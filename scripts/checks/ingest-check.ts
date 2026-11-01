// Offline check of src/media/ingest.ts on the development set in ../video_agent_devset (outside the repo,
// never deployed; see its README and truth.json): a temp project under os.tmpdir() gets a handful of its clean
// phone clips and of their copies with known defects (the ones the quality flags should catch, a few that are
// too mild to flag, a byte copy and a trimmed, cropped copy), a shop's logos, document and a photo, a street
// ambience track cut from a clip, plus made-up cases (a rotated clip, a black-then-pattern clip, the same take
// squeezed by a chat app, an A-B-A cut, a sideways JPEG with an EXIF orientation tag, audio running past the
// picture, a broken file, shots from one locked-off camera that must not count as repeats).
// Everything is registered and ingested with a stub transcriber; the per-shot metrics table and the look-alike
// pairs are printed so a person can judge the thresholds. Then: a 误拍 mark surviving later ingests, and hung
// transcriptions timing out without blocking other uploads. The development set is only read.
//   npx tsx scripts/checks/ingest-check.ts            the handful
//   INGEST_ALL=1 npx tsx scripts/checks/ingest-check.ts  every clean and defect clip, with a confusion table per flag
//                                                 against truth.json (threshold calibration)
//   KEEP=1 …                                      keep the temp project for a look
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ingestMedia, markDuplicates, readIndex, registerMedia, updateMedia, type MediaItem } from '../../src/media/ingest.ts';

const DEV = process.env.DEVSET_DIR ?? new URL('../../../video_agent_devset', import.meta.url).pathname;
if (!existsSync(join(DEV, 'truth.json'))) throw new Error(`missing development set: ${DEV}`);
/** truth.json entries by path relative to the set. It is written by Python, which spells a silent track's peak -Infinity. */
type Truth = {
  category: string; clean?: boolean; base?: string; duplicate_of?: string | null;
  defects?: Array<{ type: string; stops?: number; length_px?: number; gaussian_sigma_px?: number; peak_px?: number; seconds?: number }>;
  measured: { has_audio: boolean; width: number; height: number; duration?: number };
};
const truth = (JSON.parse(readFileSync(join(DEV, 'truth.json'), 'utf8').replace(/-Infinity|NaN/g, 'null')) as { files: Record<string, Truth> }).files;
const devFile = (rel: string) => {
  if (!truth[rel] || !existsSync(join(DEV, rel))) throw new Error(`development set has no ${rel}`);
  return join(DEV, rel);
};

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const pad = (s: unknown, n: number) => String(s).slice(0, n).padEnd(n);
const num = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? '-' : v.toFixed(d));

function ffprobe(file: string) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,sample_rate,channels,duration:stream_side_data=rotation:format=duration', '-of', 'json', file]).toString();
  return JSON.parse(out) as { streams: Array<{ codec_type: string; codec_name: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string; sample_rate?: string; channels?: number; duration?: string; side_data_list?: unknown[] }>; format: { duration?: string } };
}
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
/** A 32x32 grey copy of an image's first frame (EXIF orientation applied, as ffmpeg decodes it). */
const grey32 = (file: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=32:32:flags=area,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
const meanAbsDiff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
/** Flags that make a shot unusable, as src/media/ingest.ts has them. */
const SEVERE = ['手抖', '过曝', '太暗', '模糊', '黑场', '重复', '误拍'];
/** The quality flags (a shot's own picture), as opposed to the repeat marks and 误拍. */
const QUALITY = ['手抖', '过曝', '太暗', '模糊', '黑场', '太短'];

/** The JPEG with an APP1 EXIF block carrying only Orientation = `o` put first (any JFIF APP0 dropped). */
function withExifOrientation(jpeg: Buffer, o: number): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  let rest = jpeg.subarray(2);
  if (rest[0] === 0xff && rest[1] === 0xe0) rest = rest.subarray(2 + rest.readUInt16BE(2));
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(o, 18);
  tiff.writeUInt32BE(0, 22);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, rest]);
}

/** A PDF of `pages` pages, each with a line of text, written by hand (no PDF library in the project). */
function tinyPdf(file: string, text: string, pages = 1) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>'),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(file, pdf);
}

/**
 * What a clip of the set should get for one quality flag: 'pos' must be flagged, 'neg' must not, 'any' is
 * either (a strength between acceptable and clearly bad, or a take another severe flag already rules out).
 * Strengths that count, judged by looking at the clips: +2 stops over and -2 under; motion blur of 21 px and
 * defocus of sigma 3; jitter of 12 px and more. +1 / -1 stop, sigma 1.5, a 9 px smear and 8 px jitter are
 * borderline. A covered lens, a pocket or floor take only has to come out unusable.
 */
function expected(rel: string, flag: string): 'pos' | 'neg' | 'any' {
  const t = truth[rel]!;
  const d = t.defects?.[0];
  const covered = d?.type === 'black' || d?.type === 'accidental';
  switch (flag) {
    case '过曝': return d?.type === 'overexposed' ? (d.stops! >= 2 ? 'pos' : 'any') : 'neg';
    case '太暗': return d?.type === 'underexposed' ? (d.stops! <= -2 ? 'pos' : 'any') : covered ? 'any' : 'neg';
    case '黑场': return covered ? (d.type === 'black' && /lens/.test(rel) ? 'pos' : 'any') : d?.type === 'underexposed' && d.stops! <= -4 ? 'any' : 'neg';
    case '模糊':
      if (d?.type === 'motion_blur') return d.length_px! >= 21 ? 'pos' : 'any';
      if (d?.type === 'defocus_blur') return d.gaussian_sigma_px! >= 3 ? 'pos' : 'any';
      return covered || (d?.type === 'underexposed' && d.stops! <= -3) ? 'any' : 'neg';
    case '手抖': return d?.type === 'shake' ? (d.peak_px! >= 12 ? 'pos' : d.peak_px! >= 8 ? 'any' : 'neg') : covered ? 'any' : 'neg';
    case '太短': return d?.type === 'too_short' ? 'pos' : 'neg';
    case 'unusable': return covered ? 'pos' : 'any';
  }
  return 'neg';
}

const project = await mkdtemp(join(tmpdir(), 'ingest-check-'));
const raw = join(project, 'assets', 'raw');
mkdirSync(raw, { recursive: true });
console.log(`project: ${project}\ndevelopment set: ${DEV}`);

// --- the uploads ---------------------------------------------------------------------------------------------
// Clean takes first (two shots each from the bakery and the flower shop, which must not mark each other), then
// copies with defects: the ones the flags must catch, too-mild ones they must leave alone, and repeats.
const HANDFUL = [
  'footage/bakery/bakery_02_kneading.mp4', 'footage/bakery/bakery_03_croissants.mp4', 'footage/flower_shop/flower_02_arranging.mp4',
  'footage/flower_shop/flower_03_roses.mp4', 'footage/car_repair/garage_04_customer.mp4', 'footage/gym/gym_02_coaching.mp4',
  'footage/gym/gym_03_dumbbells.mp4', 'footage/gym/gym_05_space.mp4', 'footage/street_food/stall_06_wok.mp4',
  'defects/overexposed_plus1stop.mp4', 'defects/overexposed_plus3stop.mp4', 'defects/underexposed_minus3stop.mp4',
  'defects/defocus_sigma6.mp4', 'defects/shake_a3px.mp4', 'defects/shake_a16px.mp4', 'defects/black_lenscap_4s.mp4',
  'defects/accidental_pocket_gym_02.mp4', 'defects/tooshort_0.8s_stall_06.mp4', 'defects/dup_exact_flower_03_roses.mp4',
  'defects/neardup_gym_03_dumbbells.mp4',
];
const ALL = !!process.env.INGEST_ALL;
const clips = ALL
  ? [...Object.keys(truth).filter((k) => truth[k]!.category === 'footage').sort(), ...Object.keys(truth).filter((k) => truth[k]!.category === 'defect').sort()]
  : HANDFUL;
const uploads: Array<{ name: string; kind: MediaItem['kind']; file: string }> = [];
/** Upload name → its path in the development set. */
const relOf = new Map<string, string>();
const add = (name: string, kind: MediaItem['kind'], from?: string) => {
  if (from) copyFileSync(from, join(raw, name));
  uploads.push({ name, kind, file: `assets/raw/${name}` });
};
for (const rel of clips) {
  relOf.set(basename(rel), rel);
  add(basename(rel), 'video', devFile(rel));
}
const clip = (rel: string) => devFile(rel);
// Street ambience cut out of a clip, as a separate sound file.
ff(['-i', clip('footage/car_repair/garage_01_exterior.mp4'), '-vn', '-c:a', 'pcm_s16le', join(raw, 'street_ambience.wav')]);
add('street_ambience.wav', 'audio');
const logos = Object.keys(truth).filter((k) => truth[k]!.category === 'logo').sort();
for (const l of logos) add(basename(l), 'image', devFile(l));
// A real photo (NASA, a clean room) and a portrait frame of the bakery's window taken from a clip.
const PHOTO = 'archive/ft-nasa-438184aa41.jpg';
add('cleanroom.jpg', 'image', devFile(PHOTO));
add('cleanroom 50%done.jpg', 'image', devFile(PHOTO));
ff(['-ss', '2', '-i', clip('footage/bakery/bakery_01_exterior.mp4'), '-frames:v', '1', '-q:v', '2', join(raw, 'storefront.jpg')]);
add('storefront.jpg', 'image');
add('bakery.md', 'text', devFile('docs/bakery.md'));
tinyPdf(join(raw, 'menu.pdf'), 'Maixiangli bakery menu: croissant 9, sourdough 32');
add('menu.pdf', 'pdf');
tinyPdf(join(raw, 'long.pdf'), 'page', 31);
add('long.pdf', 'pdf');
// "门店介绍：麦香里烘焙" saved as GB18030, as Notepad on Chinese Windows does.
writeFileSync(join(raw, 'notes_gbk.txt'), Buffer.from('c3c5b5eabde9c9dca3bac2f3cfe3c0efbae6b1ba', 'hex'));
add('notes_gbk.txt', 'text');
// Made-up cases. The same take after a chat app squeezed it: 540 px wide, heavy compression.
const SQUEEZE = 'footage/car_repair/garage_04_customer.mp4';
ff(['-i', clip(SQUEEZE), '-vf', 'scale=540:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(raw, 'customer_squeezed.mp4')]);
add('customer_squeezed.mp4', 'video');
// A phone clip stored with a 90° rotation flag.
ff(['-display_rotation', '90', '-i', clip('footage/car_repair/garage_02_wrench.mp4'), '-c', 'copy', join(raw, 'rotated.mp4')]);
add('rotated.mp4', 'video');
ff(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=2:r=25', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=3:r=25',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-map', '2:a',
  '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(raw, 'black_then_pattern.mp4')]);
add('black_then_pattern.mp4', 'video');
const SHOTS = ['testsrc2', 'smptebars', 'rgbtestsrc', 'mandelbrot', 'color=c=red', 'color=c=blue', 'life=mold=10:ratio=0.5', 'cellauto=rule=110'];
ff([...SHOTS.flatMap((src) => ['-t', '1.6', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}s=480x270:r=25`]),
  '-filter_complex', `${SHOTS.map((_, i) => `[${i}:v]format=yuv420p,setsar=1[v${i}]`).join(';')};${SHOTS.map((_, i) => `[v${i}]`).join('')}concat=n=${SHOTS.length}:v=1[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(raw, 'eight_shots.mp4')]);
add('eight_shots.mp4', 'video');
ff(['-t', '3', '-i', clip('footage/street_food/stall_03_skewers.mp4'), '-vf', 'gblur=sigma=6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', join(raw, 'out_of_focus.mp4')]);
add('out_of_focus.mp4', 'video');
// The synthetic clips below use test sources no other clip uses: two clips of the same test source are the
// same footage and rightly marked 重复.
// A-B-A within one clip: the third shot returns to the first, which is cutting, not a repeat.
ff(['-loop', '1', '-t', '2', '-i', join(raw, 'storefront.jpg'), '-f', 'lavfi', '-i', 'smptehdbars=s=270x480:r=25:d=2',
  '-filter_complex', '[0:v]scale=270:480,fps=25,format=yuv420p,setsar=1,split=2[a1][a2];[1:v]format=yuv420p,setsar=1[b];[a1][b][a2]concat=n=3:v=1[v]',
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(raw, 'a_b_a.mp4')]);
add('a_b_a.mp4', 'video');
// The portrait frame stored sideways with EXIF Orientation 6, as most phones save photos.
const sideways = join(raw, 'storefront_sideways_src.jpg');
ff(['-i', join(raw, 'storefront.jpg'), '-vf', 'transpose=cclock', '-q:v', '2', sideways]);
writeFileSync(join(raw, 'storefront_exif6.jpg'), withExifOrientation(readFileSync(sideways), 6));
add('storefront_exif6.jpg', 'image');
// One locked-off camera (a still of the workshop with sensor grain): the empty room, someone crossing it left to
// right and right to left. Different shots from the same spot, never the same footage.
const room = join(raw, 'room.png');
ff(['-ss', '2', '-i', clip('footage/car_repair/garage_05_workshop.mp4'), '-frames:v', '1', room]);
const walker = join(raw, 'walker.png');
ff(['-ss', '2', '-i', clip('footage/car_repair/garage_04_customer.mp4'), '-frames:v', '1', '-vf', 'crop=240:640:240:400,scale=120:320', walker]);
const locked = (name: string, x: string | null) => ff([
  '-loop', '1', '-t', '4', '-i', room, ...(x ? ['-loop', '1', '-t', '4', '-i', walker] : []),
  '-filter_complex', `[0:v]fps=25,format=yuv420p${x ? `[bg];[bg][1:v]overlay=x='${x}':y=640` : ''},noise=alls=4:allf=t[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', join(raw, name)]);
locked('locked_empty.mp4', null);
locked('locked_cross_lr.mp4', '-120+840*t/4');
locked('locked_cross_rl.mp4', '720-840*t/4');
for (const n of ['locked_empty.mp4', 'locked_cross_lr.mp4', 'locked_cross_rl.mp4']) add(n, 'video');
// 3 s of picture with 8 s of sound; and a short last shot (1.2 s) with 0.5 s of sound after the picture ends.
ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=8',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(raw, 'long_audio.mp4')]);
add('long_audio.mp4', 'video');
ff(['-f', 'lavfi', '-i', 'yuvtestsrc=s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'pal75bars=s=640x360:r=25:d=1.2', '-f', 'lavfi', '-i', 'sine=f=330:d=4.7',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(raw, 'audio_tail.mp4')]);
add('audio_tail.mp4', 'video');
writeFileSync(join(raw, 'broken.mp4'), Buffer.from('this is not a video'));
add('broken.mp4', 'video');

// --- register --------------------------------------------------------------------------------------------------
console.log('\nregister');
const items = uploads.map((u) => registerMedia(project, u));
check(items.map((x) => x.id).join(',') === items.map((_, i) => `m${i + 1}`).join(','), 'ids are m1..mN in upload order');
check(items.every((x) => x.status === 'queued'), 'new items are queued');
let threw = false;
try { registerMedia(project, { name: 'x', kind: 'text', file: '../../etc/passwd' }); } catch { threw = true; }
check(threw && readIndex(project).length === items.length, 'a path outside the project is refused');
check(updateMedia(project, 'm999', { name: 'x' }) === undefined, 'updateMedia on an unknown id gives undefined');

// --- ingest ----------------------------------------------------------------------------------------------------
console.log('\ningest (stub transcribe)');
const asked: string[] = [];
const stub = async (audio: string) => {
  asked.push(audio);
  check(existsSync(audio) && /\.mp3$/.test(audio), `transcribe gets an existing mp3 (${basename(audio)})`);
  return [{ start: 0, end: 1.5, text: ' 欢迎光临 ' }];
};
const stageAt: Record<string, Record<string, number>> = {};
// An ingest holds a slot from its first progress event until it starts transcribing (the request itself
// waits outside the slots) or ends.
let active = 0, maxActive = 0;
const slotTracker = () => {
  let state: 'waiting' | 'in' | 'out' = 'waiting';
  return (stage: string) => {
    if (state === 'waiting') {
      state = 'in';
      maxActive = Math.max(maxActive, ++active);
    }
    if (state === 'in' && (stage === 'transcribe' || stage === 'done' || stage === 'failed')) {
      state = 'out';
      active--;
    }
  };
};
const t0 = Date.now();
await Promise.all(items.map(async (it) => {
  const slot = slotTracker();
  return ingestMedia(project, it.id, {
    transcribe: stub,
    onProgress: (stage) => {
      slot(stage);
      (stageAt[it.id] ??= {})[stage] ??= Date.now();
    },
  });
}));
const total = (Date.now() - t0) / 1000;
check(maxActive <= 2, `at most 2 ingests decoding at a time (saw ${maxActive})`);

const byName = (n: string) => readIndex(project).find((x) => x.name === n)!;
const index = readIndex(project);

console.log('\nitems');
for (const x of index) {
  console.log(`  ${pad(x.id, 4)} ${pad(x.name, 32)} ${pad(x.kind, 5)} ${pad(x.status, 7)} ${x.duration ? `${x.duration.toFixed(1)}s` : ''} ${x.width ? `${x.width}x${x.height}` : ''}`
    + ` ${x.fps ? `${x.fps}fps` : ''} ${x.codec ?? ''} ${x.bitDepth ? `${x.bitDepth}bit` : ''} rot=${x.rotation ?? '-'} audio=${x.hasAudio ?? '-'} segs=${x.segments.length}`
    + `${x.transcript ? ` transcript=${x.transcript.length}` : ''}${x.text ? ` text=${x.text.length}ch` : ''}${x.error ? ` error=${x.error}` : ''}`);
}

console.log('\nper-segment metrics (expo = share of clipped pixels, dark = share near black, bright = highlight level, blur = blurdetect, shake = wobble % diag/step)');
console.log(`  ${pad('item', 4)} ${pad('name', 32)} ${pad('seg', 3)} ${pad('start-end', 11)} ${pad('expo', 6)} ${pad('dark', 6)} ${pad('bright', 6)} ${pad('blur', 6)} ${pad('shake', 6)} ${pad('black', 5)} flags`);
for (const x of index) {
  x.segments.forEach((s, k) => console.log(`  ${pad(x.id, 4)} ${pad(x.name, 32)} ${pad(k, 3)} ${pad(`${s.start.toFixed(1)}-${s.end.toFixed(1)}`, 11)} ${pad(num(s.quality.exposure), 6)} ${pad(num(s.quality.dark), 6)} ${pad(num(s.quality.bright, 1), 6)} ${pad(num(s.quality.blur, 2), 6)} ${pad(num(s.quality.shake), 6)} ${pad(s.quality.black ? 'yes' : '', 5)} ${s.flags.join(' ')}${s.dupOf ? ` dupOf=${s.dupOf}` : ''}${s.usable ? '' : '  [unusable]'}`));
}

// Look-alike pairs with the measures markDuplicates decides on, read from its per-item fingerprint caches.
console.log('\nlook-alike pairs (dHash bits and share of 32x32 cells changed >24 levels, at 20/50/80 %; best pair at any places)');
const prints = (id: string) => {
  try { return JSON.parse(readFileSync(join(project, 'assets', 'proxy', `${id}.dhash.json`), 'utf8')) as Record<string, string>; } catch { return {}; }
};
const bitsOf = (a?: string, b?: string) => {
  if (!a || !b) return NaN;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  for (; x; x &= x - 1n) n++;
  return n;
};
const shareOf = (a?: string, b?: string) => {
  if (!a || !b) return NaN;
  const ga = Buffer.from(a, 'base64'), gb = Buffer.from(b, 'base64');
  let n = 0;
  for (let i = 0; i < 1024; i++) if (Math.abs(ga[i]! - gb[i]!) > 24) n++;
  return n / 1024;
};
for (const x of index) {
  x.segments.forEach((s, k) => {
    if (!s.dupOf) return;
    const [oid, oseg] = s.dupOf.split(':') as [string, string];
    const o = index.find((i) => i.id === oid)!;
    const of = o.segments[Number(oseg)]!.frames;
    const pa = prints(x.id), pb = prints(oid);
    const cross = s.frames.flatMap((f) => of.map((g) => [bitsOf(pa[f], pb[g]), shareOf(pa[`g:${f}`], pb[`g:${g}`])] as const)).sort((p, q) => p[0] - q[0])[0]!;
    console.log(`  ${pad(`${x.id}:${k}`, 7)} ${pad(x.name, 32)} ~ ${pad(s.dupOf, 7)} ${pad(o.name, 30)} ${pad(s.flags.includes('重复') ? '重复' : '相似', 3)}`
      + ` bits ${s.frames.map((f, n) => bitsOf(pa[f], pb[of[n]!])).join('/')}  cells ${s.frames.map((f, n) => shareOf(pa[`g:${f}`], pb[`g:${of[n]!}`]).toFixed(3)).join('/')}`
      + `  best ${cross[0]} bits ${cross[1].toFixed(3)}`);
  });
}

// --- the development set's clips against truth.json -------------------------------------------------------------
console.log('\nflags against truth.json (clip level: flagged when any shot is; "any" = borderline, not scored)');
const devItems = index.filter((x) => relOf.has(x.name));
for (const flag of [...QUALITY, 'unusable']) {
  let tp = 0, fn = 0, fp = 0, tn = 0, anyF = 0, anyN = 0;
  const wrong: string[] = [];
  for (const x of devItems) {
    const rel = relOf.get(x.name)!;
    const e = expected(rel, flag);
    const got = flag === 'unusable' ? x.segments.some((s) => s.flags.some((f) => QUALITY.includes(f) && SEVERE.includes(f))) : x.segments.some((s) => s.flags.includes(flag));
    if (e === 'pos') got ? tp++ : (fn++, wrong.push(`missed ${x.name}`));
    else if (e === 'neg') got ? (fp++, wrong.push(`false ${x.name}`)) : tn++;
    else got ? anyF++ : anyN++;
  }
  console.log(`  ${pad(flag, 8)} TP ${pad(tp, 3)} FN ${pad(fn, 3)} FP ${pad(fp, 3)} TN ${pad(tn, 3)} borderline flagged ${anyF} / left ${anyN}${wrong.length ? `  (${wrong.join(', ')})` : ''}`);
}

console.log('\nchecks');
const longPdf = byName('long.pdf');
check(longPdf.status === 'failed' && /31 页/.test(longPdf.error ?? ''), `a 31-page PDF is refused (${longPdf.error})`);
check(byName('notes_gbk.txt').text === '门店介绍：麦香里烘焙', `GB18030 text decoded (${byName('notes_gbk.txt').text})`);
const broken = byName('broken.mp4');
check(broken.status === 'failed' && /[一-鿿]/.test(broken.error ?? ''), `a broken file fails with a Chinese message (${broken.error})`);
for (const x of index.filter((i) => i.name !== 'broken.mp4' && i.name !== 'long.pdf')) check(x.status === 'ready', `${x.name} is ready`);

for (const x of index.filter((i) => i.kind === 'video' && i.status === 'ready')) {
  const p = ffprobe(join(project, x.proxy!));
  const v = p.streams.find((s) => s.codec_type === 'video')!;
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = (v.avg_frame_rate ?? '0/1').split('/').map(Number);
  check(v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && Math.max(v.width!, v.height!) <= 1280 && n! / d! <= 30.01 && !v.side_data_list
    && (x.hasAudio ? a?.codec_name === 'aac' && a.sample_rate === '48000' && a.channels === 2 : !a),
  `${x.name}: proxy h264 yuv420p ${v.width}x${v.height} ${(n! / d!).toFixed(2)}fps${a ? ` ${a.codec_name} ${a.sample_rate}Hz` : ''}`);
  check(Math.abs(Number(v.duration) - x.duration!) < 0.05, `${x.name}: duration is the proxy's picture length (${x.duration} vs ${v.duration})`);
  check(Math.abs(x.segments.at(-1)!.end - x.duration!) < 0.01, `${x.name}: the last segment ends with the picture`);
  check((v.width! > v.height!) === (x.width! > x.height!), `${x.name}: proxy keeps display orientation`);
  check(x.segments.length > 0 && x.segments.every((s) => s.frames.length === 3 && s.frames.every((f) => existsSync(join(project, f)))), `${x.name}: 3 keyframes per segment exist`);
  check(!!x.sheet && existsSync(join(project, x.sheet)), `${x.name}: contact sheet exists`);
  check(x.segments.every((s, k) => s.start < s.end && (k === 0 ? s.start === 0 : s.start === x.segments[k - 1]!.end)), `${x.name}: segments tile the clip`);
}
for (const x of devItems) {
  const t = truth[relOf.get(x.name)!]!;
  check(x.hasAudio === t.measured.has_audio && x.width === t.measured.width && x.height === t.measured.height && x.segments.length === 1,
    `${x.name}: ${x.width}x${x.height}, audio ${x.hasAudio} as truth.json has it, one shot (${x.segments.length})`);
}
const flagsOf = (n: string) => byName(n).segments.flatMap((s) => s.flags);
// usable as the shot's own quality flags have it: a look-alike hint never changes it.
const ownUsable = (s: MediaItem['segments'][number]) => !s.flags.some((f) => SEVERE.includes(f));
const cleanTakes = devItems.filter((x) => truth[relOf.get(x.name)!]!.category === 'footage' || truth[relOf.get(x.name)!]!.clean);
check(cleanTakes.every((x) => x.segments.every((s) => !s.flags.some((f) => QUALITY.includes(f)))),
  `clean takes get no quality flag (${cleanTakes.filter((x) => x.segments.some((s) => s.flags.some((f) => QUALITY.includes(f)))).map((x) => `${x.name}: ${flagsOf(x.name).join('/')}`).join('; ') || 'none flagged'})`);
const cleanFootage = devItems.filter((x) => truth[relOf.get(x.name)!]!.category === 'footage');
check(cleanFootage.every((x) => x.segments.every((s) => !s.dupOf && s.usable)),
  `different clean shots, several of one shop, never mark each other and stay usable (${cleanFootage.filter((x) => x.segments.some((s) => s.dupOf || !s.usable)).map((x) => `${x.name} ${flagsOf(x.name).join('/')}`).join('; ') || 'all clear'})`);
const has = (n: string, f: string, want = true) => check(flagsOf(n).includes(f) === want, `${n}: ${want ? '' : 'no '}${f} (${flagsOf(n).join('/') || 'no flags'}; ${JSON.stringify(byName(n).segments[0]?.quality)})`);
has('overexposed_plus3stop.mp4', '过曝');
has('overexposed_plus1stop.mp4', '过曝', false);
has('underexposed_minus3stop.mp4', '太暗');
has('defocus_sigma6.mp4', '模糊');
has('shake_a16px.mp4', '手抖');
has('shake_a3px.mp4', '手抖', false);
has('black_lenscap_4s.mp4', '黑场');
has('tooshort_0.8s_stall_06.mp4', '太短');
check(byName('black_lenscap_4s.mp4').segments.every((s) => !s.usable) && byName('accidental_pocket_gym_02.mp4').segments.every((s) => !s.usable),
  `a covered lens and a pocket take are unusable (${flagsOf('accidental_pocket_gym_02.mp4').join('/')})`);
check(byName('gym_05_space.mp4').hasAudio === false && byName('gym_05_space.mp4').transcript === undefined, 'a clip without a sound track is not sent for transcription');
const rose = byName('flower_03_roses.mp4');
const roseCopy = byName('dup_exact_flower_03_roses.mp4');
check(roseCopy.segments.every((s, k) => s.dupOf === `${rose.id}:${k}` && s.flags.includes('重复') && !s.flags.includes('相似') && !s.usable), `the same file uploaded twice is marked 重复 (${roseCopy.segments.map((s) => s.dupOf).join(',')})`);
check(rose.segments.every((s) => !s.dupOf), 'the first upload stays the original');
const customer = byName('garage_04_customer.mp4');
const squeezed = byName('customer_squeezed.mp4');
check(squeezed.segments.every((s, k) => s.dupOf === `${customer.id}:${k}` && s.flags.includes('重复') && !s.usable), `the same take recompressed at 540p is marked 重复 (${squeezed.segments.map((s) => `${s.flags.join('/')} ${s.dupOf}`).join(',')})`);
const dumbbells = byName('gym_03_dumbbells.mp4');
const dumbbellsCut = byName('neardup_gym_03_dumbbells.mp4');
check(dumbbellsCut.segments[0]?.dupOf === `${dumbbells.id}:0` && dumbbellsCut.segments[0].flags.includes('相似') && dumbbellsCut.segments[0].usable === ownUsable(dumbbellsCut.segments[0]),
  `a copy trimmed by 1.5 s, cropped 10% and re-encoded is a 相似 hint of the original, usable left alone (${dumbbellsCut.segments[0]?.dupOf} ${dumbbellsCut.segments[0]?.flags.join('/')} usable=${dumbbellsCut.segments[0]?.usable})`);
for (const n of ['locked_cross_lr.mp4', 'locked_cross_rl.mp4']) {
  const x = byName(n);
  check(x.segments.every((s) => !s.flags.includes('重复') && s.usable === ownUsable(s)),
    `${n}: same camera spot as the empty room, different shot: not 重复 (${x.segments.map((s) => `${s.flags.join('/') || '-'}${s.dupOf ? ` ~${s.dupOf}` : ''} usable=${s.usable}`).join('; ')})`);
}
const rot = byName('rotated.mp4');
check(rot.rotation === 90 && rot.width === 1280 && rot.height === 720, `rotated clip reported in display orientation (${rot.width}x${rot.height}, rotation ${rot.rotation})`);
const bp = byName('black_then_pattern.mp4');
check(bp.segments.length === 2 && Math.abs(bp.segments[0]!.end - 2) < 0.15, `cut found between black and pattern (${bp.segments.map((s) => `${s.start}-${s.end}`).join(', ')})`);
check(bp.segments[0]?.quality.black === true && bp.segments[0].flags.includes('黑场') && !bp.segments[0].usable, 'black opening flagged 黑场, unusable');
check(bp.segments[1]?.quality.black === false, 'test pattern is not black');
check(bp.transcript !== undefined && bp.transcript.length === 0, 'silent track is not sent for transcription');
const aba = byName('a_b_a.mp4');
check(aba.segments.length === 3 && aba.segments.every((s) => !s.dupOf && !s.flags.includes('重复') && !s.flags.includes('相似')),
  `A-B-A cutting inside one clip is not a repeat (${aba.segments.map((s) => `${s.start}-${s.end} ${s.flags.join('/')}${s.dupOf ?? ''}`).join(', ')})`);
const eight = byName('eight_shots.mp4');
const sheetSize = eight.sheet ? ffprobe(join(project, eight.sheet)).streams[0]! : undefined;
check(eight.segments.length === 8 && !!sheetSize && sheetSize.width! > sheetSize.height! * 2,
  `eight-shot clip: ${eight.segments.length} segments, sheet ${sheetSize?.width}x${sheetSize?.height} (6 per row, 2 rows)`);
const oof = byName('out_of_focus.mp4');
check(oof.segments.every((s) => s.flags.includes('模糊') && !s.usable), `an out-of-focus clip is flagged 模糊 (blur ${oof.segments[0]?.quality.blur})`);
check(logos.every((l) => !byName(basename(l)).segments[0]!.flags.length), `shop logos (flat colour, transparent laid on white) are not flagged (${logos.map((l) => byName(basename(l)).segments[0]!.flags.join('/')).filter(Boolean).join(', ') || 'none'})`);
for (const n of ['cleanroom.jpg', 'storefront.jpg']) {
  const photo = byName(n);
  check(photo.status === 'ready' && photo.segments[0]!.quality.blur !== null && !photo.segments[0]!.flags.length, `${n}: photo analysed, no flags (${JSON.stringify(photo.segments[0]!.quality)})`);
}
check(byName('cleanroom 50%done.jpg').status === 'ready', 'an image named with "%d" in it is read as one file');
const logo = byName('bakery_transparent.png');
const lp = ffprobe(join(project, logo.proxy!)).streams[0]!;
check(logo.segments.length === 1 && logo.segments[0]!.start === 0 && logo.segments[0]!.end === 0 && logo.segments[0]!.frames[0] === logo.proxy && lp.codec_name === 'mjpeg' && Math.max(lp.width!, lp.height!) <= 1920,
  `image: one [0,0] segment pointing at a ${lp.width}x${lp.height} JPEG proxy`);
for (const n of ['bakery_transparent.png', 'cleanroom.jpg', 'storefront.jpg']) {
  const x = byName(n);
  const pp = ffprobe(join(project, x.proxy!)).streams[0]!;
  check(Math.abs(pp.width! / pp.height! - x.width! / x.height!) < 0.01, `${n}: proxy keeps the aspect (${pp.width}x${pp.height} for ${x.width}x${x.height})`);
}
const ex = byName('storefront_exif6.jpg');
const exp = ex.proxy ? ffprobe(join(project, ex.proxy)).streams[0]! : undefined;
const front = ffprobe(join(raw, 'storefront.jpg')).streams[0]!;
const exDiff = ex.proxy ? meanAbsDiff(grey32(join(project, ex.proxy)), grey32(join(raw, 'storefront.jpg'))) : 999;
check(ex.status === 'ready' && ex.width === front.width && ex.height === front.height && exp?.width === front.width! - (front.width! % 2) && exp.height === front.height! - (front.height! % 2) && exDiff < 6,
  `EXIF-rotated JPEG: ${ex.width}x${ex.height} reported, ${exp?.width}x${exp?.height} upright proxy (original ${front.width}x${front.height}), mean grey diff to the original ${exDiff.toFixed(1)}`);
const la = byName('long_audio.mp4');
check(la.status === 'ready' && Math.abs(la.duration! - 3) < 0.05 && la.segments.length === 1 && la.segments[0]!.end === la.duration,
  `audio running 5 s past the picture: ${la.status}, duration ${la.duration}, shots ${la.segments.map((s) => `${s.start}-${s.end}`).join(', ')}${la.error ? ` (${la.error})` : ''}`);
const at = byName('audio_tail.mp4');
check(at.status === 'ready' && Math.abs(at.duration! - 4.2) < 0.05 && at.segments.length === 2 && Math.abs(at.segments[1]!.start - 3) < 0.1,
  `short last shot with an audio tail: ${at.status}, duration ${at.duration}, shots ${at.segments.map((s) => `${s.start}-${s.end}`).join(', ')}${at.error ? ` (${at.error})` : ''}`);
const wav = byName('street_ambience.wav');
const wp = ffprobe(join(project, wav.proxy!)).streams[0]!;
const ambLen = Number(ffprobe(join(raw, 'street_ambience.wav')).format.duration);
check(wav.segments.length === 0 && wp.codec_name === 'aac' && wp.sample_rate === '48000' && Math.abs(wav.duration! - ambLen) < 0.1, `audio: m4a 48 kHz proxy, ${wav.duration}s`);
check(Array.isArray(wav.transcript), `audio: transcript decided (${wav.transcript?.length} lines)`);
const pdf = byName('menu.pdf');
check(/croissant 9/.test(pdf.text ?? ''), `pdf text extracted (${JSON.stringify(pdf.text)})`);
const md = byName('bakery.md');
check(md.text === readFileSync(devFile('docs/bakery.md'), 'utf8').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 60000), `markdown text read (${md.text?.length} chars)`);
check(index.filter((i) => i.transcript?.length).every((i) => i.transcript![0]!.text === '欢迎光临'), 'stub transcript lines stored (trimmed)');
check(asked.length > 0, `transcribe called ${asked.length} times`);

// --- round trip and idempotency --------------------------------------------------------------------------------
const before = readFileSync(join(project, 'media_index.json'), 'utf8');
check(JSON.stringify(JSON.parse(before)) === JSON.stringify(readIndex(project)), 'index round-trips through readIndex');
markDuplicates(project);
check(readFileSync(join(project, 'media_index.json'), 'utf8') === before, 'markDuplicates again changes nothing');
const t1 = Date.now();
const again2 = await Promise.all(index.filter((x) => x.status === 'ready').map((x) => ingestMedia(project, x.id, { transcribe: stub })));
const reTime = (Date.now() - t1) / 1000;
check(reTime < 2 && again2.every((x) => x.status === 'ready'), `re-ingest of ${again2.length} ready items took ${reTime.toFixed(2)}s`);
check(readFileSync(join(project, 'media_index.json'), 'utf8') === before, 're-ingest leaves the index as it was');
// A lost sheet is rebuilt on its own without redoing the proxy.
const victim = index.find((x) => x.kind === 'video' && x.status === 'ready')!;
execFileSync('rm', ['-f', join(project, victim.sheet!)]);
const mtime = execFileSync('stat', ['-c', '%Y', join(project, victim.proxy!)]).toString();
const redo = await ingestMedia(project, victim.id);
check(redo.status === 'ready' && existsSync(join(project, victim.sheet!)) && execFileSync('stat', ['-c', '%Y', join(project, victim.proxy!)]).toString() === mtime, 'a missing sheet is rebuilt, the proxy kept');

// A transcriber that fails leaves the clip ready without a transcript; the next call fills it in.
const flaky = registerMedia(project, { name: 'coaching_flaky.mp4', kind: 'video', file: 'assets/raw/gym_02_coaching.mp4' });
const f1 = await ingestMedia(project, flaky.id, { transcribe: async () => { throw new Error('relay down'); } });
check(f1.status === 'ready' && f1.transcript === undefined, 'a failing transcriber leaves the clip ready, without transcript');
const f2 = await ingestMedia(project, flaky.id, { transcribe: stub });
check(f2.status === 'ready' && f2.transcript?.length === 1, 'the next ingest adds the transcript');

// --- marks other steps own ------------------------------------------------------------------------------------
// describe.ts marks accidental takes 误拍 / usable false; a later video's ingest reruns markDuplicates.
console.log('\nmarks set by other steps');
const markMisshot = (id: string) => {
  const x = readIndex(project).find((i) => i.id === id)!;
  updateMedia(project, id, { segments: x.segments.map((s, k) => (k === 0 ? { ...s, flags: [...s.flags, '误拍'], usable: false } : s)) });
};
const kneading = byName('bakery_02_kneading.mp4');
markMisshot(kneading.id);
markMisshot(roseCopy.id);
const nextOne = registerMedia(project, { name: 'pattern_again.mp4', kind: 'video', file: 'assets/raw/black_then_pattern.mp4' });
const nr = await ingestMedia(project, nextOne.id);
const kneading2 = byName('bakery_02_kneading.mp4'), roseCopy2 = byName('dup_exact_flower_03_roses.mp4');
check(nr.status === 'ready' && kneading2.segments[0]!.flags.includes('误拍') && kneading2.segments[0]!.usable === false,
  `a 误拍 shot stays unusable after the next video's ingest (${JSON.stringify([kneading2.segments[0]!.flags, kneading2.segments[0]!.usable])})`);
check(kneading2.segments.slice(1).every((s, k) => s.usable === kneading.segments[k + 1]!.usable), 'the clip\'s other shots keep their usable');
check(roseCopy2.segments[0]!.flags.includes('误拍') && roseCopy2.segments[0]!.flags.includes('重复') && !roseCopy2.segments[0]!.usable, 'a repeat later marked 误拍 keeps both marks');
markDuplicates(project);
check(JSON.stringify(byName('bakery_02_kneading.mp4').segments) === JSON.stringify(kneading2.segments), 'markDuplicates again leaves them as they are');

// --- hung transcriptions --------------------------------------------------------------------------------------
// A relay call stuck on a dead socket never settles. It must time out (base cut to 1.5 s here, + 2 s per second
// of audio) and must not hold the decoding slots meanwhile.
console.log('\nhung transcriptions');
process.env.INGEST_TRANSCRIBE_TIMEOUT_MS = '1500';
for (const [n, src] of [['hung_a.mp4', 'testsrc2'], ['hung_b.mp4', 'mandelbrot']] as const) {
  ff(['-f', 'lavfi', '-i', `${src}=s=320x180:r=25`, '-f', 'lavfi', '-i', 'sine=f=500', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(raw, n)]);
}
ff(['-f', 'lavfi', '-i', 'rgbtestsrc=s=320x180:r=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(raw, 'plain.mp4')]);
const [ha, hb, pl] = ['hung_a.mp4', 'hung_b.mp4', 'plain.mp4'].map((n) => registerMedia(project, { name: n, kind: 'video', file: `assets/raw/${n}` }));
let hungCalls = 0;
const hang = () => { hungCalls++; return new Promise<Array<{ start: number; end: number; text: string }>>(() => {}); };
const th = Date.now();
const pHa = ingestMedia(project, ha!.id, { transcribe: hang });
const pHb = ingestMedia(project, hb!.id, { transcribe: hang });
const rPl = await ingestMedia(project, pl!.id);
const tPl = (Date.now() - th) / 1000;
const midStatus = [byName('hung_a.mp4').status, byName('hung_b.mp4').status];
check(rPl.status === 'ready' && hungCalls === 2 && midStatus.every((x) => x === 'processing'),
  `a third upload finishes in ${tPl.toFixed(1)}s while two transcriptions hang (${hungCalls} calls, those items ${midStatus.join('/')})`);
const [rHa, rHb] = await Promise.all([pHa, pHb]);
const tH = (Date.now() - th) / 1000;
check(rHa.status === 'ready' && rHb.status === 'ready' && rHa.transcript === undefined && rHb.transcript === undefined && tH < 15,
  `hung transcriptions time out after ${tH.toFixed(1)}s: items ready, no transcript`);
const rHa2 = await ingestMedia(project, ha!.id, { transcribe: stub });
check(rHa2.status === 'ready' && rHa2.transcript?.length === 1, 'the next ingest adds the transcript');
delete process.env.INGEST_TRANSCRIBE_TIMEOUT_MS;

// --- timings ---------------------------------------------------------------------------------------------------
console.log('\ntimings');
let footage = 0, proxySec = 0, proxyMedia = 0;
for (const x of index.filter((i) => i.kind === 'video' && i.status === 'ready')) {
  const s = stageAt[x.id]!;
  footage += x.duration!;
  if (s.proxy && s.analyse) {
    proxySec += (s.analyse - s.proxy) / 1000;
    proxyMedia += x.duration!;
  }
  console.log(`  ${pad(x.name, 32)} ${x.duration!.toFixed(1)}s  proxy ${s.proxy && s.analyse ? ((s.analyse - s.proxy) / 1000).toFixed(2) : '-'}s  analyse ${s.analyse && s.keyframes ? ((s.keyframes - s.analyse) / 1000).toFixed(2) : '-'}s  frames+sheet ${s.keyframes && s.done ? ((s.done - s.keyframes) / 1000).toFixed(2) : '-'}s  total ${s.probe && s.done ? ((s.done - s.probe) / 1000).toFixed(2) : '-'}s`);
}
console.log(`  proxy: ${proxyMedia.toFixed(0)}s of footage in ${proxySec.toFixed(1)}s of ingest time (${(proxyMedia / proxySec).toFixed(1)}x realtime per ingest, 2 in parallel)`);
console.log(`  whole run: ${total.toFixed(1)}s wall for ${footage.toFixed(0)}s of video (+ other files) = ${(total / (footage / 60)).toFixed(1)}s per minute of footage, on ${execFileSync('nproc').toString().trim()} cores`);

if (process.env.KEEP) console.log(`\nkept ${project}`);
else await rm(project, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nAll ingest checks passed');
