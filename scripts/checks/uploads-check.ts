// Offline check of src/media/uploads.ts: happy paths for every kind (a real HEVC phone clip, a wav, a png, a
// handcrafted pdf, a markdown note), resumable chunking, and every refusal (chunk order and size, foreign
// sessions, per-IP, session and global caps, free disk minus in-flight reservations, file-count caps and the
// cached per-session tally, fake or oversized media including a second oversized video stream or cover image,
// PDFs whose metadata forges pdfinfo's page count, bad text, path-like names).
// Usage: tsx scripts/checks/uploads-check.ts [media dir holding clip.mp4 (HEVC, 6–9 MB), tone.wav, logo.png]
// Without a media dir, those three are generated with ffmpeg (an HEVC clip with sound, a tone and a logo).
// Everything else is generated under a fresh os.tmpdir() folder, which is removed at the end.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mediaDir = process.argv[2] ?? (() => {
  const dir = join(tmpdir(), `uploads-check-media-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const ff = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
  // ~7.5 MB, so it goes up in three 3 MB chunks like a short phone clip.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-vf', 'noise=alls=30:allf=t', '-c:v', 'libx265', '-tag:v', 'hvc1', '-b:v', '7400k', '-maxrate', '7400k', '-bufsize', '7400k',
    '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest', join(dir, 'clip.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', join(dir, 'tone.wav'));
  ff('-f', 'lavfi', '-i', 'color=c=0x2b6cb0:size=256x256', '-frames:v', '1', join(dir, 'logo.png'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
})();
const media = (n: string) => {
  const p = resolve(mediaDir, n);
  if (!existsSync(p)) {
    console.error(`missing ${p}`);
    process.exit(2);
  }
  return p;
};
const CLIP = media('clip.mp4');
const WAV = media('tone.wav');
const PNG = media('logo.png');

const MB = 1024 * 1024;
Object.assign(process.env, {
  UPLOAD_FILE_BYTES: String(12 * MB),
  UPLOAD_CHUNK_BYTES: String(3 * MB),
  UPLOAD_SESSION_BYTES: String(60 * MB),
  UPLOAD_GLOBAL_BYTES: String(1024 * MB),
  UPLOAD_MIN_FREE_BYTES: '0',
  UPLOAD_PER_IP_CONCURRENT: '2',
  UPLOAD_PER_IP_HOURLY_BYTES: String(200 * MB),
  UPLOAD_SESSION_FILES: '25',
  UPLOAD_PER_IP_HOURLY_FILES: '12',
});
const U = await import('../../src/media/uploads.ts');
const { UPLOAD_LIMITS: L } = U;
const DEFAULTS = { ...L };

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
async function throws(fn: () => unknown, re: RegExp, what: string) {
  try {
    await fn();
    check(false, `${what} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    check(re.test(msg), `${what} -> ${msg}`);
  }
}
let ipN = 0;
const freshIp = () => `10.0.${++ipN >> 8}.${ipN & 255}`;
const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');

const root = await mkdtemp(join(tmpdir(), 'uploads-check-'));
const sessDir = (s: string) => join(root, s);
const gen = join(root, '_gen');
mkdirSync(gen);
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** Whole upload in chunkBytes pieces; returns the completed info. */
async function upload(session: string, name: string, data: Buffer, ip = freshIp()) {
  const info = U.beginUpload(session, sessDir(session), { name, size: data.length, ip });
  for (let off = 0; off < data.length; off += L.chunkBytes) {
    await U.writeChunk(session, info.id, off, data.subarray(off, off + L.chunkBytes));
  }
  return U.completeUpload(session, info.id);
}
const partFiles = (s: string) => {
  try {
    return readdirSync(join(sessDir(s), 'assets/raw/.part'));
  } catch {
    return [];
  }
};

/** A PDF of `pages` blank pages; `title` (raw PDF literal-string body, escapes allowed) goes in an Info dict. */
function makePdf(pages: number, title?: string): Buffer {
  const objs: string[] = [];
  const first = title === undefined ? 3 : 4;
  const kids = Array.from({ length: pages }, (_, i) => `${first + i} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  if (title !== undefined) objs.push(`<< /Title (${title}) >>`);
  for (let i = 0; i < pages; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${title === undefined ? '' : ' /Info 3 0 R'} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

try {
  console.log('env limits');
  check(L.fileBytes === 12 * MB && L.chunkBytes === 3 * MB && L.minFreeBytes === 0, 'UPLOAD_* env overrides are read');

  console.log('happy paths');
  const clip = readFileSync(CLIP);
  const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', CLIP]).toString().trim();
  check(codec === 'hevc', `test clip is HEVC (${codec})`);
  {
    const s = 'sA';
    const info = U.beginUpload(s, sessDir(s), { name: '店/视频/IMG_0001.MOV', size: clip.length, ip: freshIp() });
    check(info.status === 'receiving' && /^[0-9a-f]{32}$/.test(info.id) && info.name === '店/视频/IMG_0001.MOV', `begin: display name kept "${info.name}"`);
    let chunks = 0;
    for (let off = 0; off < clip.length; off += L.chunkBytes) {
      const r = await U.writeChunk(s, info.id, off, clip.subarray(off, off + L.chunkBytes));
      chunks++;
      check(r.received === Math.min(clip.length, off + L.chunkBytes), `chunk ${chunks} received=${r.received}`);
    }
    check(chunks === 3, `clip of ${(clip.length / MB).toFixed(1)} MB sent in 3 chunks`);
    // Retry of the last chunk with the same bytes is idempotent.
    const lastOff = 2 * L.chunkBytes;
    const again = await U.writeChunk(s, info.id, lastOff, clip.subarray(lastOff));
    check(again.received === clip.length, 'retry of last chunk with identical bytes accepted and ignored');
    const changed = Buffer.from(clip.subarray(lastOff));
    changed[0] = changed[0]! ^ 0xff;
    await throws(() => U.writeChunk(s, info.id, lastOff, changed), /不一致/, 'retry of last chunk with different bytes rejected');
    const [done, twice] = await Promise.all([U.completeUpload(s, info.id), U.completeUpload(s, info.id)]);
    check(done.status === 'complete' && done.kind === 'video', `HEVC clip -> ${done.status} ${done.kind} ${done.error ?? ''}`);
    check(/^assets\/raw\/u1-[0-9a-f]{8}\.mp4$/.test(done.file ?? ''), `disk name ${done.file}`);
    check(done.file?.endsWith(`-${createHash('sha1').update(info.id).digest('hex').slice(0, 8)}.mp4`) === true, 'hash part is sha1(uploadId)');
    check(sha(readFileSync(join(sessDir(s), done.file!))) === sha(clip), 'stored bytes identical to source');
    check(twice.file === done.file, 'concurrent second complete returns the same result');
    check(partFiles(s).length === 0, 'temp file gone after complete');
    check(U.getUpload(s, info.id)?.status === 'complete', 'getUpload reports complete');
    await throws(() => U.writeChunk(s, info.id, clip.length, Buffer.from('x')), /已经结束/, 'chunk after complete rejected');
    check(U.uploadedBytes(sessDir(s)) === clip.length, `uploadedBytes = ${U.uploadedBytes(sessDir(s))}`);

    const wav = await upload(s, 'room tone.wav', readFileSync(WAV));
    check(wav.status === 'complete' && wav.kind === 'audio' && /^assets\/raw\/u2-[0-9a-f]{8}\.wav$/.test(wav.file ?? ''), `wav -> ${wav.kind} ${wav.file} ${wav.error ?? ''}`);
    const png = await upload(s, 'logo.png', readFileSync(PNG));
    check(png.status === 'complete' && png.kind === 'image' && png.file?.endsWith('.png') === true, `png -> ${png.kind} ${png.file} ${png.error ?? ''}`);
    const pdf = await upload(s, 'menu.pdf', makePdf(2));
    check(pdf.status === 'complete' && pdf.kind === 'pdf' && pdf.file?.endsWith('.pdf') === true, `pdf -> ${pdf.kind} ${pdf.file} ${pdf.error ?? ''}`);
    const mdText = Buffer.from('# 店铺简介\n\n手冲咖啡，早上八点开门。\n');
    const md = await upload(s, '资料/简介.md', mdText);
    check(md.status === 'complete' && md.kind === 'text' && md.file?.endsWith('.md') === true, `md -> ${md.kind} ${md.file} ${md.error ?? ''}`);
    check(readFileSync(join(sessDir(s), md.file!)).equals(mdText), 'md bytes intact');
    const jpgPath = join(gen, 'p.jpg');
    ff('-f', 'lavfi', '-i', 'testsrc=s=320x240', '-frames:v', '1', jpgPath);
    const jpg = await upload(s, 'photo.JPG', readFileSync(jpgPath));
    check(jpg.status === 'complete' && jpg.kind === 'image' && jpg.file?.endsWith('.jpg') === true, `jpg -> ${jpg.kind} ${jpg.file} ${jpg.error ?? ''}`);
  }

  console.log('chunk protocol');
  {
    const s = 'sB';
    const data = randomBytes(1000);
    const info = U.beginUpload(s, sessDir(s), { name: 'x.mp4', size: data.length, ip: freshIp() });
    await throws(() => U.writeChunk(s, info.id, 5, data.subarray(0, 10)), /位置不对/, 'wrong offset (5 instead of 0)');
    await U.writeChunk(s, info.id, 0, data.subarray(0, 100));
    await throws(() => U.writeChunk(s, info.id, 300, data.subarray(100, 200)), /应从第 100 字节/, 'gap after first chunk');
    await throws(() => U.writeChunk(s, info.id, 100, Buffer.alloc(L.chunkBytes + 1)), /数据块太大/, 'oversize chunk');
    await throws(() => U.writeChunk('sOther', info.id, 100, data.subarray(100, 200)), /上传不存在/, 'wrong session id on writeChunk');
    await throws(() => U.completeUpload('sOther', info.id), /上传不存在/, 'wrong session id on completeUpload');
    check(U.getUpload('sOther', info.id) === undefined, 'getUpload from another session is undefined');
    U.abortUpload('sOther', info.id);
    check(U.getUpload(s, info.id)?.status === 'receiving', 'abort from another session ignored');
    await throws(() => U.writeChunk(s, info.id, 100, randomBytes(901)), /超过了文件声明的大小/, 'size overflow (100 + 901 > 1000)');
    await throws(() => U.completeUpload(s, info.id), /还没传完/, 'complete before all bytes arrived');
    await throws(() => U.writeChunk(s, 'deadbeef', 0, data), /上传不存在/, 'unknown upload id');
    U.abortUpload(s, info.id);
    check(U.getUpload(s, info.id) === undefined && partFiles(s).length === 0, 'abort drops the upload and its temp file');
    await throws(() => U.writeChunk(s, info.id, 100, data.subarray(100, 200)), /上传不存在/, 'chunk after abort');
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'a', size: 0, ip: freshIp() })), /文件大小无效/, 'empty file');
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'a', size: L.fileBytes + 1, ip: freshIp() })), /单个文件不能超过 12 MB/, 'file over fileBytes');
  }

  console.log('per-IP limits');
  {
    const s = 'sC';
    const ip = '203.0.113.7';
    const a = U.beginUpload(s, sessDir(s), { name: 'a.mp4', size: 1000, ip });
    const b = U.beginUpload(s, sessDir(s), { name: 'b.mp4', size: 1000, ip: `::ffff:${ip}` });
    await throws(() => Promise.resolve(U.beginUpload('sC2', sessDir('sC2'), { name: 'c.mp4', size: 1000, ip })), /同时最多上传 2 个/, 'third concurrent upload from one IP (any session, IPv4-mapped counted together)');
    U.abortUpload(s, a.id);
    const c = U.beginUpload(s, sessDir(s), { name: 'c.mp4', size: 1000, ip });
    check(c.status === 'receiving', 'slot frees after abort');
    U.abortUpload(s, b.id);
    U.abortUpload(s, c.id);
    U.beginUpload(s, sessDir(s), { name: 'v6a', size: 10, ip: '2001:db8:1:2::1' });
    U.beginUpload(s, sessDir(s), { name: 'v6b', size: 10, ip: '2001:db8:1:2:aaaa::9' });
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'v6c', size: 10, ip: '2001:0db8:0001:0002:ffff:1:2:3' })), /同时最多上传/, 'IPv6 addresses of one /64 share the limit');
    const other = U.beginUpload(s, sessDir(s), { name: 'v6d', size: 10, ip: '2001:db8:1:3::1' });
    check(other.status === 'receiving', 'another /64 is separate');

    // Stale uploads (no chunk for 30 min) stop counting.
    const realNow = Date.now;
    const sIp = '198.51.100.1';
    const st1 = U.beginUpload(s, sessDir(s), { name: 's1', size: 10, ip: sIp });
    U.beginUpload(s, sessDir(s), { name: 's2', size: 10, ip: sIp });
    Date.now = () => realNow() + 31 * 60 * 1000;
    try {
      check(U.getUpload(s, st1.id) === undefined, 'stale upload dropped after 30 min');
      check(U.beginUpload(s, sessDir(s), { name: 's3', size: 10, ip: sIp }).status === 'receiving', 'stale uploads no longer hold IP slots');
    } finally {
      Date.now = realNow;
    }

    L.perIpHourlyBytes = 20 * MB;
    const hip = '192.0.2.50';
    const h1 = U.beginUpload(s, sessDir('sH'), { name: 'h1', size: 12 * MB, ip: hip });
    U.abortUpload(s, h1.id);
    await throws(() => Promise.resolve(U.beginUpload('sH', sessDir('sH'), { name: 'h2', size: 9 * MB, ip: hip })), /一小时内最多上传 20 MB/, 'per-IP hourly bytes (aborted uploads still count)');
    check(U.beginUpload('sH', sessDir('sH'), { name: 'h3', size: 8 * MB, ip: hip }).status === 'receiving', 'still room under the hourly cap');
    L.perIpHourlyBytes = DEFAULTS.perIpHourlyBytes;
  }

  console.log('session, global and disk caps');
  {
    const s = 'sD';
    L.sessionBytes = 8 * MB;
    const a = U.beginUpload(s, sessDir(s), { name: 'a', size: 5 * MB, ip: freshIp() });
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'b', size: 4 * MB, ip: freshIp() })), /对话的上传总量/, 'session cap counts in-flight uploads');
    U.abortUpload(s, a.id);
    check(U.beginUpload(s, sessDir(s), { name: 'b', size: 4 * MB, ip: freshIp() }).status === 'receiving', 'room again after abort');
    writeFileSync(join(sessDir(s), 'assets/raw/existing.bin'), Buffer.alloc(3 * MB));
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'c', size: 2 * MB, ip: freshIp() })), /对话的上传总量/, 'session cap counts stored files (3 MB stored + 4 MB in flight + 2 MB)');
    L.sessionBytes = DEFAULTS.sessionBytes;

    mkdirSync(join(root, 'sOld/assets/raw'), { recursive: true });
    writeFileSync(join(root, 'sOld/assets/raw/big.bin'), Buffer.alloc(5 * MB));
    U.setGlobalUploadRoot(root);
    const stored = readdirSync(root).reduce((n, d) => n + U.uploadedBytes(join(root, d)), 0);
    const flying = 4 * MB + 8 * MB + 40 + 10; // sD b, sH h3, the receiving test uploads of sC
    L.globalBytes = stored + flying + 2 * MB;
    await throws(() => Promise.resolve(U.beginUpload('sE', sessDir('sE'), { name: 'g', size: 3 * MB, ip: freshIp() })), /存储空间已满/, `global cap (${(stored / MB).toFixed(1)} MB stored across sessions + in flight)`);
    check(U.beginUpload('sE', sessDir('sE'), { name: 'g', size: 1 * MB, ip: freshIp() }).status === 'receiving', 'under the global cap still allowed');
    L.globalBytes = DEFAULTS.globalBytes;

    L.minFreeBytes = Number.MAX_SAFE_INTEGER;
    await throws(() => Promise.resolve(U.beginUpload('sE', sessDir('sE'), { name: 'd', size: 10, ip: freshIp() })), /磁盘空间不足/, 'free disk below minFreeBytes');

    // Concurrent begins must not each see the same free space: unwritten reservations count as used. With
    // 35 MB of headroom and ~13 MB already reserved by the receiving uploads above, 10 MB begins (each in its
    // own session and IP) must stop after a few. Before the fix all six went through.
    const st = statfsSync(root);
    L.minFreeBytes = Number(st.bavail) * Number(st.bsize) - 35 * MB;
    const admitted: Array<{ s: string; id: string }> = [];
    let refusal = '';
    for (let i = 0; i < 6 && !refusal; i++) {
      const rs = `sR${i}`;
      try {
        admitted.push({ s: rs, id: U.beginUpload(rs, sessDir(rs), { name: 'r.mp4', size: 10 * MB, ip: freshIp() }).id });
      } catch (e) {
        refusal = (e as Error).message;
      }
    }
    check(/磁盘空间不足/.test(refusal) && admitted.length >= 1 && admitted.length <= 3,
      `free disk counts in-flight reservations: ${admitted.length} of 6 x 10 MB admitted into 35 MB headroom, then "${refusal}"`);
    for (const a of admitted) U.abortUpload(a.s, a.id);
    const again = U.beginUpload('sR9', sessDir('sR9'), { name: 'r.mp4', size: 10 * MB, ip: freshIp() });
    check(again.status === 'receiving', 'aborting releases the reservations');
    U.abortUpload('sR9', again.id);
    L.minFreeBytes = DEFAULTS.minFreeBytes;
  }

  console.log('file-count caps and the cached tally');
  {
    // Per session: 25 entries in assets/raw (env override; 200 by default), in-flight uploads included.
    const s = 'sN';
    for (let i = 0; i < 24; i++) {
      const r = await upload(s, `n${i}.txt`, Buffer.from('x'));
      if (r.status !== 'complete') check(false, `tiny upload ${i} -> ${r.status} ${r.error}`);
    }
    const last = U.beginUpload(s, sessDir(s), { name: 'n24.txt', size: 1, ip: freshIp() });
    check(last.status === 'receiving', '25th file admitted (24 stored + itself)');
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'n25.txt', size: 1, ip: freshIp() })), /文件太多了（最多 25 个）/, '26th file refused while the 25th is in flight');
    await U.writeChunk(s, last.id, 0, Buffer.from('y'));
    check((await U.completeUpload(s, last.id)).status === 'complete', '25th file stored');
    await throws(() => Promise.resolve(U.beginUpload(s, sessDir(s), { name: 'n25.txt', size: 1, ip: freshIp() })), /文件太多了/, 'session full at 25 stored files');
    const firstFile = readdirSync(join(sessDir(s), 'assets/raw')).find((n) => n.startsWith('u1-'))!;
    rmSync(join(sessDir(s), 'assets/raw', firstFile));
    const freed = U.beginUpload(s, sessDir(s), { name: 'n25.txt', size: 1, ip: freshIp() });
    check(freed.status === 'receiving', 'deleting a stored file frees a slot at once');
    U.abortUpload(s, freed.id);

    // Per IP per hour: 12 begins (env override; 300 by default), aborted ones included.
    const ip = '192.0.2.77';
    for (let i = 0; i < 12; i++) U.abortUpload('sM', U.beginUpload('sM', sessDir('sM'), { name: `m${i}.txt`, size: 1, ip }).id);
    await throws(() => Promise.resolve(U.beginUpload('sM', sessDir('sM'), { name: 'm12.txt', size: 1, ip })), /一小时内最多上传 12 个文件/, '13th begin from one IP within the hour refused');
    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 60 * 1000;
    try {
      const later = U.beginUpload('sM', sessDir('sM'), { name: 'm13.txt', size: 1, ip });
      check(later.status === 'receiving', 'an hour later the IP may upload again');
      U.abortUpload('sM', later.id);
    } finally {
      Date.now = realNow;
    }

    // uploadedBytes is one stat while assets/raw is unchanged, and re-walks once an entry is added.
    const t = 'sT';
    const raw = join(sessDir(t), 'assets/raw');
    mkdirSync(raw, { recursive: true });
    for (let i = 0; i < 150; i++) writeFileSync(join(raw, `f${i}.bin`), Buffer.alloc(100));
    const past = new Date(Date.now() - 10_000);
    utimesSync(raw, past, past);
    check(U.uploadedBytes(sessDir(t)) === 15_000, `150 files counted (${U.uploadedBytes(sessDir(t))} bytes)`);
    writeFileSync(join(raw, 'f0.bin'), Buffer.alloc(1100)); // in place: the folder's mtime stays
    check(U.uploadedBytes(sessDir(t)) === 15_000, 'unchanged folder answered from the cached tally (no walk)');
    writeFileSync(join(raw, 'g.bin'), Buffer.alloc(5));
    check(U.uploadedBytes(sessDir(t)) === 16_005, `new entry triggers a fresh walk (${U.uploadedBytes(sessDir(t))} bytes)`);
  }

  console.log('content validation');
  {
    const s = 'sF';
    const rejected = async (name: string, data: Buffer, re: RegExp, what: string) => {
      const r = await upload(s, name, data);
      check(r.status === 'rejected' && re.test(r.error ?? '') && !r.file, `${what} -> ${r.status}: ${r.error ?? r.file}`);
      check(partFiles(s).length === 0, `  temp deleted (${what})`);
    };
    const fake = randomBytes(64 * 1024);
    fake.write('ftypisom', 4, 'latin1');
    fake.writeUInt32BE(24, 0);
    await rejected('fake.mp4', fake, /无法解析|不受支持/, 'fake mp4 (random bytes with ftyp)');
    await rejected('a.txt', Buffer.from([0x68, 0x69, 0xc3, 0x28, 0x0a]), /UTF-8/, 'invalid UTF-8 text');
    await rejected('nul.md', Buffer.from('ab\0cd'), /二进制/, 'text with NUL byte');
    await rejected('data.bin', Buffer.from('hello world, plain text but not a text name'), /不支持的文件类型/, 'unknown type');
    await rejected('big.csv', Buffer.alloc(1 * MB + 1, 0x61), /1 MB/, 'text over 1 MB');

    const renamed = await upload(s, 'clip.txt', readFileSync(CLIP));
    check(renamed.status === 'complete' && renamed.kind === 'video' && renamed.file?.endsWith('.mp4') === true,
      `video renamed .txt -> content wins: ${renamed.kind} ${renamed.file ?? renamed.error}`);
    await rejected('clip2.txt', readFileSync(CLIP).subarray(0, 256 * 1024).fill(0, 0, 8), /不支持的文件类型|二进制/, 'video bytes without a valid header named .txt');

    const audioOnly = join(gen, 'audio-only.mp4');
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', audioOnly);
    const ao = await upload(s, 'my video.mp4', readFileSync(audioOnly));
    check(ao.status === 'complete' && ao.kind === 'audio' && ao.file?.endsWith('.m4a') === true, `"video" with only audio -> ${ao.kind} ${ao.file ?? ao.error}`);

    const wide = join(gen, 'wide.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=red:s=5000x200:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', wide);
    await rejected('wide.mp4', readFileSync(wide), /分辨率太高.*5000×200/, '5000x200 video');

    const fast = join(gen, 'fast.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc=s=160x120:r=240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fast);
    await rejected('fast.mp4', readFileSync(fast), /帧率太高/, '240 fps video');

    // ffmpeg picks the largest video stream by default, so a second stream must be held to the same limits.
    const two = join(gen, 'two.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=6000x6000:d=1:r=1',
      '-map', '0', '-map', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', two);
    await rejected('two.mp4', readFileSync(two), /分辨率太高.*6000×6000/, 'second video stream 6000x6000');
    const twoFast = join(gen, 'two-fast.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc=s=160x120:r=30:d=1', '-f', 'lavfi', '-i', 'testsrc=s=160x120:r=1000:d=1',
      '-map', '0', '-map', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', twoFast);
    await rejected('two-fast.mp4', readFileSync(twoFast), /帧率太高/, 'second video stream at 1000 fps');
    const twoOk = join(gen, 'two-ok.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=1',
      '-map', '0', '-map', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', twoOk);
    const ok2 = await upload(s, 'two-ok.mp4', readFileSync(twoOk));
    check(ok2.status === 'complete' && ok2.kind === 'video', `two video streams within limits -> ${ok2.status} ${ok2.error ?? ''}`);
    const m4av = join(gen, 'm4a-with-video.mp4');
    ff('-f', 'lavfi', '-i', 'sine=d=1', '-f', 'lavfi', '-i', 'color=c=red:s=5000x200:d=1:r=5', '-map', '0', '-map', '1',
      '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-brand', 'M4A ', m4av);
    await rejected('voice.m4a', readFileSync(m4av), /分辨率太高.*5000×200/, 'M4A-branded file carrying a 5000x200 video stream');
    const cover = join(gen, 'cover.png');
    ff('-f', 'lavfi', '-i', 'color=c=red:s=17000x16', '-frames:v', '1', cover);
    const mp3 = join(gen, 'cover.mp3');
    ff('-f', 'lavfi', '-i', 'sine=d=1', '-i', cover, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy',
      '-id3v2_version', '3', '-disposition:v', 'attached_pic', mp3);
    await rejected('song.mp3', readFileSync(mp3), /封面图太大/, 'mp3 with a 17000x16 cover image');

    const long = join(gen, 'long.wav');
    ff('-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '901', '-c:a', 'pcm_u8', long);
    await rejected('long.wav', readFileSync(long), /不能超过 15 分钟/, '901 s wav');

    await rejected('book.pdf', makePdf(31), /不能超过 30 页/, '31-page pdf');
    // A line break in /Title makes pdfinfo print a forged "Pages:" line before the real one.
    await rejected('forged.pdf', makePdf(200, 'menu\\nPages:          1'), /文档信息异常/, '200-page pdf with "Pages: 1" forged in /Title (LF)');
    await rejected('forged-cr.pdf', makePdf(200, 'menu\\rPages: 1'), /文档信息异常/, '200-page pdf with "Pages: 1" forged in /Title (CR)');
    const titled = await upload(s, 'titled.pdf', makePdf(2, 'Pages of the menu'));
    check(titled.status === 'complete' && titled.kind === 'pdf', `pdf with an ordinary title -> ${titled.status} ${titled.error ?? ''}`);
    const brokenPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2000)]);
    await rejected('broken.pdf', brokenPdf, /PDF 无法打开/, 'broken pdf');

    const heic = Buffer.alloc(4096);
    heic.writeUInt32BE(24, 0);
    heic.write('ftypheic', 4, 'latin1');
    await rejected('IMG_1.HEIC', heic, /HEIC/, 'HEIC photo');
  }

  console.log('names');
  {
    const s = 'sG';
    const png = readFileSync(PNG);
    const r = await upload(s, '../../etc/passwd', png);
    check(r.status === 'complete' && r.name === 'etc/passwd', `display "${r.name}"`);
    check(/^assets\/raw\/u1-[0-9a-f]{8}\.png$/.test(r.file ?? ''), `disk name ${r.file}`);
    check(!existsSync(join(root, 'etc')) && !existsSync(join(sessDir(s), 'etc')), 'nothing written along the user path');
    const t = await upload(s, '..\\..\\C:\\x\\..\\note\u0000\u202e.md', Buffer.from('ok'));
    check(t.status === 'complete' && t.name === 'C:/x/note.md' && /^assets\/raw\/u2-[0-9a-f]{8}\.md$/.test(t.file ?? ''), `backslashes, NUL, bidi: display "${t.name}", disk ${t.file}`);
    const longName = `${'很长的名字'.repeat(40)}.md`;
    const l = await upload(s, longName, Buffer.from('ok'));
    check(Array.from(l.name).length === 120 && l.name.endsWith('.md'), `long name cut to 120 chars, extension kept (${Array.from(l.name).length})`);
    const d = await upload(s, '/', Buffer.from('ok'));
    check(d.status === 'rejected' && d.name === '未命名文件', `empty name -> "${d.name}" (${d.error})`);
    const files = readdirSync(join(sessDir(s), 'assets/raw')).filter((n) => n !== '.part');
    check(files.every((n) => /^u\d+-[0-9a-f]{8}\.[a-z0-9]+$/.test(n)), `only generated names on disk: ${files.join(', ')}`);
  }

  console.log('stale .part cleanup');
  {
    const s = 'sA';
    const old = join(sessDir(s), 'assets/raw/.part/orphan.part');
    writeFileSync(old, 'x');
    const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    execFileSync('touch', ['-d', `@${past}`, old]);
    const fresh = join(sessDir(s), 'assets/raw/.part/recent.part');
    writeFileSync(fresh, 'x');
    const info = U.beginUpload(s, sessDir(s), { name: 'z', size: 1, ip: freshIp() });
    check(!existsSync(old) && existsSync(fresh), '.part older than 24 h removed on begin, recent kept');
    U.abortUpload(s, info.id);
    check(statSync(sessDir(s)).isDirectory(), 'session dir intact');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} upload check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll upload checks passed');
