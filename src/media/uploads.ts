// Chunked, resumable uploads of the user's own media (shop footage, voice notes, photos, menus, briefs) into a
// conversation. The server has no login, so anyone can upload: every upload is capped per file, per session,
// per IP (concurrency and bytes per hour) and globally (total bytes and free disk), and nothing reaches the
// session's assets/raw folder before its content has been sniffed and probed. The user's file name is shown
// only; disk names are generated (u<seq>-<hash>.<ext>, the extension taken from the detected type). Partial
// uploads live in memory and in assets/raw/.part, so a restart drops them and the client starts over.
// File counts are capped too (per session and per IP per hour): tiny files cost no bytes but each one is an
// inode and an entry every directory walk has to visit, so the per-session tally is cached against the folder's
// mtime instead of being re-walked on every begin.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statfsSync, statSync, type Dirent } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type UploadKind = 'video' | 'audio' | 'image' | 'pdf' | 'text';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Upload limits in bytes (counts for the per-IP concurrency). Each can be overridden for tests through the
 * environment: UPLOAD_FILE_BYTES, UPLOAD_SESSION_BYTES, UPLOAD_GLOBAL_BYTES, UPLOAD_MIN_FREE_BYTES,
 * UPLOAD_CHUNK_BYTES, UPLOAD_PER_IP_CONCURRENT, UPLOAD_PER_IP_HOURLY_BYTES (read once at load).
 */
export const UPLOAD_LIMITS: {
  fileBytes: number; sessionBytes: number; globalBytes: number; minFreeBytes: number;
  chunkBytes: number; perIpConcurrent: number; perIpHourlyBytes: number;
} = {
  fileBytes: envInt('UPLOAD_FILE_BYTES', 500 * MB),
  sessionBytes: envInt('UPLOAD_SESSION_BYTES', 3 * GB),
  globalBytes: envInt('UPLOAD_GLOBAL_BYTES', 60 * GB),
  minFreeBytes: envInt('UPLOAD_MIN_FREE_BYTES', 20 * GB),
  chunkBytes: envInt('UPLOAD_CHUNK_BYTES', 4 * MB),
  perIpConcurrent: envInt('UPLOAD_PER_IP_CONCURRENT', 2),
  perIpHourlyBytes: envInt('UPLOAD_PER_IP_HOURLY_BYTES', 5 * GB),
};

/** Public state of one upload; `file` is relative to the session folder once complete. */
export interface UploadInfo {
  id: string;
  session: string;
  name: string;
  size: number;
  received: number;
  status: 'receiving' | 'complete' | 'rejected';
  kind?: UploadKind;
  file?: string;
  error?: string;
  createdAt: string;
}

interface Entry {
  info: UploadInfo;
  sessionDir: string;
  ip: string;
  part: string;
  lastActivity: number;
  /** Where the last accepted chunk started and how long it was, so a retried last chunk is recognised. */
  lastChunk?: { offset: number; length: number };
  /** Set once completeUpload starts: no more chunks, no abort, a second complete waits for the first. */
  completing?: Promise<UploadInfo>;
  /** Serialises writeChunk calls on one upload. */
  lock: Promise<unknown>;
}

const STALE_MS = 30 * 60 * 1000;
const PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FINISHED_KEEP_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const GLOBAL_CACHE_MS = 60 * 1000;
const TOOL_TIMEOUT_MS = 15_000;
const TEXT_MAX_BYTES = 1 * MB;
const VIDEO_MAX_EDGE = 4096;
// Phone photos go up to 12000 px (108 MP); beyond that an image is a decompression bomb, not a photo.
const IMAGE_MAX_EDGE = 16384;
// Decoding takes about 4-5 bytes per pixel: a small file can still be a huge picture. 120 MP keeps 108 MP phone photos.
const IMAGE_MAX_PIXELS = 120_000_000;
const MAX_SECONDS = 900;
const MAX_FPS = 120;
const PDF_MAX_PAGES = 30;
const NAME_MAX = 120;
// File-count caps live outside UPLOAD_LIMITS so its exported shape stays as it is; env overrides are for tests.
const SESSION_MAX_FILES = envInt('UPLOAD_SESSION_FILES', 200);
const PER_IP_HOURLY_FILES = envInt('UPLOAD_PER_IP_HOURLY_FILES', 300);
// A folder changed this recently may change again within the same mtime tick, so its tally is not cached.
const RACY_MS = 2000;

const uploads = new Map<string, Entry>();
const ipLog: Array<{ ip: string; at: number; bytes: number }> = [];
let globalRoot: string | undefined;
let globalCache: { root: string; at: number; bytes: number } | undefined;
/** Per assets/raw folder: bytes and entry count, valid while the folder's mtime is unchanged. */
const tallies = new Map<string, { mtimeNs: bigint; bytes: number; count: number }>();

const rawDir = (sessionDir: string) => join(sessionDir, 'assets', 'raw');
const partDir = (sessionDir: string) => join(rawDir(sessionDir), '.part');
const copy = (e: Entry): UploadInfo => ({ ...e.info });

/** Drops receiving uploads with no chunk for 30 min (they stop counting) and forgets old finished ones. */
function sweep(now = Date.now()) {
  for (const [id, e] of uploads) {
    if (e.info.status === 'receiving' && !e.completing && now - e.lastActivity > STALE_MS) {
      e.info.status = 'rejected';
      e.info.error = '上传超时（30 分钟没有收到数据），请重新上传';
      uploads.delete(id);
      rmSync(e.part, { force: true });
    } else if (e.info.status !== 'receiving' && now - e.lastActivity > FINISHED_KEEP_MS) {
      uploads.delete(id);
    }
  }
  while (ipLog.length && now - ipLog[0]!.at > HOUR_MS) ipLog.shift();
}

/** Uploads that still hold a reservation: receiving, or being validated. */
const inFlight = () => [...uploads.values()].filter((e) => e.info.status === 'receiving');

/**
 * IP key for the per-IP limits: IPv4-mapped IPv6 is reduced to IPv4, and IPv6 to its /64 prefix, since one
 * subscriber usually holds a whole /64.
 */
function ipKey(ip: string): string {
  let s = (ip || 'unknown').trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1]!;
  if (!s.includes(':')) return s;
  s = s.replace(/%.*$/, '');
  const [head = '', tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Display name: path separators normalised, '.'/'..'/drive parts dropped, control chars removed, ≤ 120 chars. */
function displayName(name: unknown): string {
  const cleaned = String(name ?? '')
    .replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p, i) => p && p !== '.' && p !== '..' && !(i === 0 && /^[a-z]:$/i.test(p)))
    .join('/');
  const chars = Array.from(cleaned);
  const short = chars.length > NAME_MAX ? `…${chars.slice(-(NAME_MAX - 1)).join('')}` : cleaned;
  return short || '未命名文件';
}

function dirBytes(dir: string, skip?: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const d of entries) {
    if (d.name === skip) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) total += dirBytes(p);
    else if (d.isFile()) {
      try {
        total += statSync(p).size;
      } catch { /* removed meanwhile */ }
    }
  }
  return total;
}

/**
 * Bytes and entries (files or folders, .part excluded) in a session's assets/raw. Only this module adds to that
 * folder, and only by renaming files into it, so adding or deleting an entry changes the folder's mtime; the
 * walk is redone only then. Rewriting a stored file in place would go unnoticed, which nothing does.
 */
function rawTally(sessionDir: string): { bytes: number; count: number } {
  const dir = rawDir(sessionDir);
  let mtimeNs: bigint;
  try {
    mtimeNs = statSync(dir, { bigint: true }).mtimeNs;
  } catch {
    tallies.delete(dir);
    return { bytes: 0, count: 0 };
  }
  const cached = tallies.get(dir);
  if (cached && cached.mtimeNs === mtimeNs) return cached;
  let count = 0;
  try {
    count = readdirSync(dir).filter((n) => n !== '.part').length;
  } catch { /* removed meanwhile */ }
  const t = { mtimeNs, bytes: dirBytes(dir, '.part'), count };
  if (Date.now() - Number(mtimeNs / 1_000_000n) > RACY_MS) tallies.set(dir, t);
  else tallies.delete(dir);
  return t;
}

/**
 * Bytes stored under <dir>/assets/raw for one session folder (partial uploads in .part are not counted: they
 * are reserved in memory at their full size instead). Cheap: a single stat unless the folder changed.
 */
export function uploadedBytes(dir: string): number {
  return rawTally(dir).bytes;
}

/** Folder holding all session folders; the 60 GB total is the sum over <sessionsDir>/<id>/assets/raw. */
export function setGlobalUploadRoot(sessionsDir: string): void {
  globalRoot = sessionsDir;
  globalCache = undefined;
}

function globalBytes(fallbackRoot: string): number {
  const root = globalRoot ?? fallbackRoot;
  const now = Date.now();
  if (globalCache && globalCache.root === root && now - globalCache.at < GLOBAL_CACHE_MS) return globalCache.bytes;
  let total = 0;
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) total += uploadedBytes(join(root, d.name));
  } catch { /* no sessions yet */ }
  globalCache = { root, at: now, bytes: total };
  return total;
}

function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function removeOldParts(sessionDir: string, now: number) {
  const dir = partDir(sessionDir);
  const live = new Set([...uploads.values()].map((e) => e.part));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (!live.has(p) && now - statSync(p).mtimeMs > PART_MAX_AGE_MS) rmSync(p, { force: true });
    } catch { /* gone */ }
  }
}

const gbText = (n: number) => (n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${+(n / MB).toFixed(1)} MB`);

/**
 * Registers a new upload for a session after checking every limit. `req.name` is for display only.
 * Throws an Error with a Chinese message when a limit is hit or the request is malformed.
 */
export function beginUpload(sessionId: string, sessionDir: string, req: { name: string; size: number; ip: string }): UploadInfo {
  const now = Date.now();
  sweep(now);
  const size = req?.size;
  if (!sessionId || !sessionDir) throw new Error('会话不存在');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('文件大小无效（空文件不能上传）');
  const L = UPLOAD_LIMITS;
  if (size > L.fileBytes) throw new Error(`单个文件不能超过 ${gbText(L.fileBytes)}，这个文件有 ${gbText(size)}`);

  mkdirSync(partDir(sessionDir), { recursive: true });
  removeOldParts(sessionDir, now);

  const flying = inFlight();
  const mine = flying.filter((e) => e.info.session === sessionId);
  const stored = rawTally(sessionDir);
  if (stored.count + mine.length + 1 > SESSION_MAX_FILES) {
    throw new Error(`这个对话的文件太多了（最多 ${SESSION_MAX_FILES} 个），请删掉不用的素材或新开一个对话`);
  }
  const sessionFlying = mine.reduce((a, e) => a + e.info.size, 0);
  if (stored.bytes + sessionFlying + size > L.sessionBytes) {
    throw new Error(`这个对话的上传总量已接近上限 ${gbText(L.sessionBytes)}，请删掉不用的素材或新开一个对话`);
  }
  const allFlying = flying.reduce((a, e) => a + e.info.size, 0);
  if (globalBytes(join(sessionDir, '..')) + allFlying + size > L.globalBytes) {
    throw new Error('服务器的素材存储空间已满，暂时不能上传，请稍后再试');
  }
  // Bytes promised to in-flight uploads but not yet written are as good as used (all sessions share one disk).
  const reserved = flying.reduce((a, e) => a + e.info.size - e.info.received, 0);
  if (freeBytes(sessionDir) - reserved - size < L.minFreeBytes) {
    throw new Error('服务器磁盘空间不足，暂时不能上传，请稍后再试');
  }
  const ip = ipKey(req.ip);
  if (flying.filter((e) => e.ip === ip).length >= L.perIpConcurrent) {
    throw new Error(`同时最多上传 ${L.perIpConcurrent} 个文件，请等前面的传完再继续`);
  }
  // Age checked here too: sweep() trims only from the front, so one out-of-order entry (clock change) would
  // otherwise keep every later one alive.
  const hour = ipLog.filter((r) => r.ip === ip && now - r.at <= HOUR_MS);
  if (hour.reduce((a, r) => a + r.bytes, 0) + size > L.perIpHourlyBytes) {
    throw new Error(`一小时内最多上传 ${gbText(L.perIpHourlyBytes)}，请稍后再试`);
  }
  if (hour.length >= PER_IP_HOURLY_FILES) {
    throw new Error(`一小时内最多上传 ${PER_IP_HOURLY_FILES} 个文件，请稍后再试`);
  }

  const id = randomBytes(16).toString('hex');
  const info: UploadInfo = {
    id, session: sessionId, name: displayName(req.name), size, received: 0, status: 'receiving',
    createdAt: new Date(now).toISOString(),
  };
  uploads.set(id, { info, sessionDir, ip, part: join(partDir(sessionDir), `${id}.part`), lastActivity: now, lock: Promise.resolve() });
  ipLog.push({ ip, at: now, bytes: size });
  return { ...info };
}

function entryFor(sessionId: string, uploadId: string): Entry {
  sweep();
  const e = uploads.get(uploadId);
  // A wrong session gets the same answer as an unknown id, so ids cannot be probed across sessions.
  if (!e || e.info.session !== sessionId) throw new Error('上传不存在或已过期，请重新上传');
  return e;
}

async function sameBytes(file: string, offset: number, data: Buffer): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(data.length);
    const { bytesRead } = await fh.read(buf, 0, data.length, offset);
    return bytesRead === data.length && buf.equals(data);
  } finally {
    await fh.close();
  }
}

/**
 * Appends one chunk. Chunks must arrive in order: `offset` must equal the bytes received so far; a retry of the
 * last chunk with identical bytes is accepted and ignored. Throws (Chinese message) on a wrong session or
 * unknown id, an out-of-order offset, a chunk over the chunk limit or past the declared size, or an upload that
 * is no longer receiving.
 */
export async function writeChunk(sessionId: string, uploadId: string, offset: number, data: Buffer): Promise<UploadInfo> {
  const e = entryFor(sessionId, uploadId);
  const run = e.lock.then(async () => {
    if (e.info.status !== 'receiving' || e.completing) throw new Error('这个上传已经结束，不能再写入');
    if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('数据块为空');
    if (data.length > UPLOAD_LIMITS.chunkBytes) throw new Error(`数据块太大（每块最多 ${gbText(UPLOAD_LIMITS.chunkBytes)}）`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('数据块位置无效');
    const last = e.lastChunk;
    if (last && offset === last.offset && offset + data.length === e.info.received && data.length === last.length) {
      if (await sameBytes(e.part, offset, data)) {
        e.lastActivity = Date.now();
        return copy(e);
      }
      throw new Error('重传的数据块与之前收到的不一致，请重新上传');
    }
    if (offset !== e.info.received) throw new Error(`数据块位置不对：应从第 ${e.info.received} 字节继续`);
    if (e.info.received + data.length > e.info.size) throw new Error('收到的数据超过了文件声明的大小');
    const fh = await open(e.part, 'a');
    try {
      if ((await fh.stat()).size !== e.info.received) throw new Error('临时文件已丢失，请重新上传');
      await fh.write(data, 0, data.length);
    } finally {
      await fh.close();
    }
    // Aborted or dropped while this chunk was being written: the append may have recreated the temp file.
    if (e.info.status !== 'receiving') {
      await rm(e.part, { force: true });
      throw new Error('这个上传已经结束，不能再写入');
    }
    e.lastChunk = { offset, length: data.length };
    e.info.received += data.length;
    e.lastActivity = Date.now();
    return copy(e);
  });
  e.lock = run.catch(() => undefined);
  return run;
}

/** Runs a tool on a user file with a hard timeout (SIGKILL) and capped output. */
function runTool(cmd: string, args: string[], timeoutMs = TOOL_TIMEOUT_MS, maxOut = 4 * MB): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxOut) p.kill('SIGKILL');
      else chunks.push(d);
    });
    p.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, out: '', timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: size > maxOut ? -1 : code, out: Buffer.concat(chunks).toString('utf8'), timedOut });
    });
  });
}

// At most two probes at a time: a burst of completes must not swamp the CPU server.
let probesRunning = 0;
const probeQueue: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (probesRunning >= 2) await new Promise<void>((r) => probeQueue.push(r));
  probesRunning++;
  try {
    return await fn();
  } finally {
    probesRunning--;
    probeQueue.shift()?.();
  }
}

type Sniffed =
  | { family: 'isobmff'; audioBrand: boolean; heif: boolean; ext: 'mp4' | 'mov' }
  | { family: 'wav' | 'mp3' | 'pdf'; ext: string }
  | { family: 'image'; ext: 'png' | 'jpg' | 'webp' | 'gif' };

/** Content type from the first bytes; the user's file name plays no part. */
function sniff(b: Buffer): Sniffed | undefined {
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const boxLen = Math.min(b.readUInt32BE(0), b.length);
    const brands = [ascii(8, 12)];
    for (let i = 16; i + 4 <= boxLen; i += 4) brands.push(ascii(i, i + 4));
    const audioBrand = /^M4[ABP] $/.test(brands[0]!);
    const heif = /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brands[0]!);
    return { family: 'isobmff', audioBrand, heif, ext: brands[0] === 'qt  ' ? 'mov' : 'mp4' };
  }
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { family: 'wav', ext: 'wav' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { family: 'image', ext: 'webp' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { family: 'image', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { family: 'image', ext: 'jpg' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return { family: 'image', ext: 'gif' };
  if (b.length >= 5 && ascii(0, 5) === '%PDF-') return { family: 'pdf', ext: 'pdf' };
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return { family: 'mp3', ext: 'mp3' };
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return { family: 'mp3', ext: 'mp3' };
  return undefined;
}

class Invalid extends Error {}

interface Probe {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; disposition?: { attached_pic?: number } }>;
  format?: { format_name?: string; duration?: string };
}

const FORMATS = {
  isobmff: 'mov,mp4,m4a,3gp,3g2,mj2',
  wav: 'wav',
  mp3: 'mp3',
  image: 'png_pipe,jpeg_pipe,webp_pipe,gif,image2',
} as const;

async function ffprobe(file: string, formats: string): Promise<Probe> {
  const r = await limited(() => runTool('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats,
    '-show_format', '-show_streams', '-of', 'json', '-i', file,
  ]));
  if (r.timedOut) throw new Invalid('文件解析超时，可能已损坏');
  if (r.code !== 0) throw new Invalid('文件无法解析，可能已损坏或格式不受支持');
  let p: Probe;
  try {
    p = JSON.parse(r.out) as Probe;
  } catch {
    throw new Invalid('文件无法解析，可能已损坏');
  }
  const names = (p.format?.format_name ?? '').split(',');
  if (!names.some((n) => formats.split(',').includes(n))) throw new Invalid('文件格式不受支持');
  return p;
}

function seconds(p: Probe, stream?: { duration?: string }): number {
  const d = Number(p.format?.duration ?? stream?.duration);
  return Number.isFinite(d) ? d : NaN;
}

function fps(rate?: string): number {
  const [n, d] = (rate ?? '').split('/').map(Number);
  return n && d ? n / d : 0;
}

const minutes = (d: number) => `${Math.floor(d / 60)} 分 ${Math.round(d % 60)} 秒`;

function checkAudio(p: Probe) {
  const a = p.streams?.find((s) => s.codec_type === 'audio');
  if (!a) throw new Invalid('音频文件里没有声音轨道');
  const d = seconds(p, a);
  if (!(d > 0)) throw new Invalid('无法读取音频时长，文件可能已损坏');
  if (d > MAX_SECONDS) throw new Invalid(`音频不能超过 ${MAX_SECONDS / 60} 分钟（这个有 ${minutes(d)}）`);
}

/**
 * Checks every picture stream, not just the first: ffmpeg's default stream choice is the largest video stream,
 * so one oversized stream anywhere in the file is what a later render would decode. Images and cover art are
 * held to the image edge limit, real video to the video edge and frame-rate limits.
 */
function checkPictures(p: Probe, image: boolean) {
  for (const v of (p.streams ?? []).filter((x) => x.codec_type === 'video')) {
    const cover = !image && !!v.disposition?.attached_pic;
    const edge = Math.max(v.width ?? 0, v.height ?? 0);
    if (image || cover) {
      if (image && (!v.width || !v.height)) throw new Invalid('无法读取图片尺寸，文件可能已损坏');
      if (edge > IMAGE_MAX_EDGE) throw new Invalid(`${cover ? '文件里的封面图' : '图片'}太大（最长边不能超过 ${IMAGE_MAX_EDGE} 像素）`);
      if ((v.width ?? 0) * (v.height ?? 0) > IMAGE_MAX_PIXELS) throw new Invalid(`${cover ? '文件里的封面图' : '图片'}太大（不能超过 1.2 亿像素）`);
      continue;
    }
    if (!v.width || !v.height) throw new Invalid('无法读取视频尺寸，文件可能已损坏');
    if (edge > VIDEO_MAX_EDGE) throw new Invalid(`视频分辨率太高（最长边不能超过 ${VIDEO_MAX_EDGE} 像素，这个是 ${v.width}×${v.height}）`);
    if (fps(v.avg_frame_rate) > MAX_FPS) throw new Invalid(`视频帧率太高（不能超过 ${MAX_FPS} 帧/秒）`);
  }
}

/** Validates the finished temp file; returns kind and disk extension, or throws Invalid with a Chinese reason. */
async function validate(e: Entry): Promise<{ kind: UploadKind; ext: string }> {
  const fh = await open(e.part, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const s = sniff(head);
  if (!s) {
    const ext = /\.(txt|md|csv|json)$/i.exec(e.info.name)?.[1]?.toLowerCase();
    if (!ext) throw new Invalid('不支持的文件类型（支持视频 mp4/mov、音频 m4a/wav/mp3、图片 png/jpg/webp/gif、PDF 和 txt/md/csv/json 文本）');
    if (e.info.size > TEXT_MAX_BYTES) throw new Invalid('文本文件不能超过 1 MB');
    const buf = await readFile(e.part);
    if (buf.includes(0)) throw new Invalid('文本文件里含有二进制内容，不是纯文本');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new Invalid('文本文件不是 UTF-8 编码，请另存为 UTF-8 后再上传');
    }
    return { kind: 'text', ext };
  }
  if (s.family === 'pdf') {
    const r = await limited(() => runTool('pdfinfo', [e.part]));
    if (r.timedOut) throw new Invalid('PDF 解析超时，可能已损坏');
    // pdfinfo prints the document's own Title/Author/… strings before Pages:, so a line break in one of them can
    // forge an earlier "Pages:" line. A genuine report has exactly one.
    const found = [...r.out.matchAll(/^Pages:\s+(\d+)\s*$/gm)];
    if (r.code !== 0 || found.length === 0) throw new Invalid('PDF 无法打开，可能已损坏或加密');
    if (found.length > 1) throw new Invalid('PDF 的文档信息异常（标题等字段里夹带了换行），请重新导出后再上传');
    const pages = Number(found[0]![1]);
    if (!(pages > 0)) throw new Invalid('PDF 无法打开，可能已损坏或加密');
    if (pages > PDF_MAX_PAGES) throw new Invalid(`PDF 不能超过 ${PDF_MAX_PAGES} 页（这个有 ${pages} 页）`);
    return { kind: 'pdf', ext: 'pdf' };
  }
  if (s.family === 'isobmff' && s.heif) throw new Invalid('暂不支持 HEIC/AVIF 图片，请在手机上导出为 JPG 后再上传');
  const p = await ffprobe(e.part, FORMATS[s.family]);
  const realVideo = (p.streams ?? []).filter((x) => x.codec_type === 'video' && !x.disposition?.attached_pic);
  if (s.family === 'image') {
    if (!p.streams?.some((x) => x.codec_type === 'video')) throw new Invalid('无法读取图片尺寸，文件可能已损坏');
    checkPictures(p, true);
    return { kind: 'image', ext: s.ext };
  }
  // Audio files (m4a included) are checked too: whatever picture they carry would be decoded by a later render.
  checkPictures(p, false);
  if (s.family === 'wav' || s.family === 'mp3') {
    checkAudio(p);
    return { kind: 'audio', ext: s.ext };
  }
  if (s.family !== 'isobmff') throw new Invalid('不支持的文件类型');
  // mp4 / mov / m4a: an audio brand, or no picture at all, makes it an audio file.
  if (s.audioBrand || realVideo.length === 0) {
    if (!p.streams?.some((x) => x.codec_type === 'audio')) throw new Invalid('视频里没有画面');
    checkAudio(p);
    return { kind: 'audio', ext: 'm4a' };
  }
  // Size and frame rate of every video stream were checked above; the container duration covers all streams.
  const d = seconds(p, realVideo[0]);
  if (!(d > 0)) throw new Invalid('无法读取视频时长，文件可能已损坏');
  if (d > MAX_SECONDS) throw new Invalid(`视频不能超过 ${MAX_SECONDS / 60} 分钟（这个有 ${minutes(d)}）`);
  return { kind: 'video', ext: s.ext };
}

function nextSeq(sessionDir: string): number {
  try {
    return readdirSync(rawDir(sessionDir)).filter((n) => /^u\d+-/.test(n)).length + 1;
  } catch {
    return 1;
  }
}

/**
 * Validates a fully received upload and moves it to assets/raw/u<seq>-<hash>.<ext>. Invalid content does not
 * throw: the upload comes back 'rejected' with a Chinese `error` and its temp file is deleted. Throws for an
 * unknown id, a wrong session, or an upload that has not received all its bytes. Calling it again returns
 * the same result.
 */
export async function completeUpload(sessionId: string, uploadId: string): Promise<UploadInfo> {
  const e = entryFor(sessionId, uploadId);
  if (e.completing) return e.completing;
  if (e.info.status !== 'receiving') return copy(e);
  await e.lock;
  if (e.completing) return e.completing;
  if (e.info.status !== 'receiving') return copy(e);
  if (e.info.received !== e.info.size) throw new Error(`文件还没传完（已收到 ${e.info.received} / ${e.info.size} 字节）`);
  e.completing = (async () => {
    try {
      const { kind, ext } = await validate(e);
      const hash = createHash('sha1').update(e.info.id).digest('hex').slice(0, 8);
      const rel = `assets/raw/u${nextSeq(e.sessionDir)}-${hash}.${ext}`;
      await rename(e.part, join(e.sessionDir, rel));
      Object.assign(e.info, { status: 'complete', kind, file: rel });
      if (globalCache) globalCache.bytes += e.info.size;
    } catch (err) {
      e.info.status = 'rejected';
      e.info.error = err instanceof Invalid ? err.message : '文件校验失败，请重新上传';
      await rm(e.part, { force: true });
    }
    e.lastActivity = Date.now();
    return copy(e);
  })();
  return e.completing;
}

/** Cancels a receiving upload and deletes its temp file; unknown ids, other sessions and finished uploads are ignored. */
export function abortUpload(sessionId: string, uploadId: string): void {
  const e = uploads.get(uploadId);
  if (!e || e.info.session !== sessionId || e.info.status !== 'receiving' || e.completing) return;
  e.info.status = 'rejected';
  e.info.error = '上传已取消';
  uploads.delete(uploadId);
  rmSync(e.part, { force: true });
}

/** Current state of an upload, or undefined when unknown, expired or owned by another session. */
export function getUpload(sessionId: string, uploadId: string): UploadInfo | undefined {
  sweep();
  const e = uploads.get(uploadId);
  return e && e.info.session === sessionId ? copy(e) : undefined;
}
