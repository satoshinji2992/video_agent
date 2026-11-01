// What happens to a user's upload once it has landed: each file becomes an indexed media item the agent can
// browse and cut. Videos get an H.264 proxy (phones record HEVC 10-bit, which browsers and our own editing
// steps handle badly), shot segments, keyframes and a numbered contact sheet, plus per-shot quality flags so
// shaky, blown-out, dark, blurred, black, duplicated and too-short takes are spotted before anyone picks them.
// Audio gets a proxy and a transcript, images a proxy, PDFs and text files their text. Every external
// command that reads a user file is restricted to local files and pipes and is killed when it runs too long.
//
// Quality measures (per shot, on the proxy, from frames decimated to 4 fps unless noted):
//   exposure  share of pixels at or above 250 in full-range grey (≈ clipped highlights; the proxy's
//             limited-range luma 233+ maps there), on a 160 px long-edge copy of the frame.
//   dark      share of pixels at or below 25 in full-range grey (≈ limited-range luma 37 and below).
//   bright    the 98th-percentile grey level of each frame (its highlights), averaged over the shot. An
//             underexposed take is dim all over, its brightest parts included; a night or low-key scene is
//             dark in large areas but still has lamps, signs or faces that reach up the scale.
//   blur      ffmpeg blurdetect (edge width; higher is blurrier) on the full proxy frame, pooled over the
//             sharpest 5% of 48 px blocks: a shot is blurred when even its sharpest parts are soft. Pooling
//             the whole frame read smooth sharp surfaces (metal, a shallow-focus background) as soft as a
//             defocused lens. null when the filter is missing.
//   shake     ffmpeg vidstabdetect at 12 fps on a 640 px copy: each step's camera motion is the median of its
//             local motion vectors; shake is the mean of what is left after a ±0.5 s moving average is taken
//             away (so steady pans and walks do not count, wobble does), in % of the frame diagonal per step.
//             null when vidstab is missing.
//   black     blackdetect (pix_th 0.10) covering most of the shot, and the brightest pixel of those frames
//             also dark (YMAX < 60 in grey), so a dim scene with a small lit subject is not called black.
//   repeats   see markDuplicates: a coarse dHash finds candidates, a 32x32 grey comparison decides whether the
//             shot really is the same footage (重复) or only looks alike (相似, a hint for vision and the agent).
// The limits come from the development set in ../video_agent_devset (next to the repo, not part of it): 30 clean phone
// clips of five shops and 45 copies of them with defects of known type and strength. See QUALITY_LIMITS for the
// numbers each limit sits between, and scripts/checks/ingest-check.ts (INGEST_ALL=1) for the full table.
// Shots and keyframes follow the proxy's video track, which can end before its audio.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { atomicOutput, CJK_FONT_FILE } from '../core/ffmpeg.ts';
import { createLimiter } from '../core/limiter.ts';

/** One shot of a video (or the single still of an image), with its keyframes and quality measures. */
export interface MediaSegment {
  start: number;
  end: number;
  /** Keyframes at 20/50/80 % of the shot, relative to the project dir. */
  frames: string[];
  /** `bright` is missing on shots analysed before it was measured. */
  quality: { exposure: number; dark: number; bright?: number; blur: number | null; shake: number | null; black: boolean };
  /** Chinese flags: '手抖', '过曝', '太暗', '模糊', '黑场', '太短', '重复', '相似' (a hint), '误拍' (set by describe). */
  flags: string[];
  usable: boolean;
  /** '<itemId>:<segIndex>' of the earlier shot this one repeats ('重复') or closely resembles ('相似'). */
  dupOf?: string;
  desc?: string;
  tags?: string[];
}

/** One uploaded file and everything worked out from it. */
export interface MediaItem {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'pdf' | 'text';
  file: string;
  proxy?: string;
  duration?: number; width?: number; height?: number; fps?: number; codec?: string; bitDepth?: number; rotation?: number; hasAudio?: boolean;
  segments: MediaSegment[];
  transcript?: Array<{ start: number; end: number; text: string }>;
  text?: string;
  sheet?: string;
  summary?: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string;
  addedAt: string;
}

type Line = { start: number; end: number; text: string };
type Deps = {
  transcribe?: (audioFile: string, language?: 'zh' | 'en') => Promise<Line[]>;
  onProgress?: (stage: string, pct: number) => void;
};

// Thresholds, calibrated on the development set (see the header). "Clean" below means the 30 clean clips plus
// the copies marked clean (a ±0.7 stop offset, the 1.1x reframe without jitter); each limit sits between the
// worst clean value and the weakest defect strength that should be caught, with room on both sides.
export const QUALITY_LIMITS = {
  /** Share of clipped pixels above which a shot is blown out. Clean frames clip at most 0.033 (a lit engine
   *  bay, a gym window); +1 stop on a workshop shot 0.002-0.015 (acceptable, left alone), +2 stops 0.106-0.141
   *  and +3 stops 0.21-0.25 per frame. 0.06 sits between the clean and +2 stop frames. */
  exposure: 0.06,
  /** Mean highlight level (`bright`, 0-255) below which a shot is too dark. Clean shots 153-243 (the darkest a
   *  -0.7 stop copy, then a dawn bakery window at 161); -1 stop 139 (still fine, left alone), -2 stops 101,
   *  -3 stops 74, -4 stops 54, pocket and floor takes 53 and 74. */
  bright: 120,
  /** Share of near-black pixels above which a shot is too dark whatever its highlights: a picture mostly lost
   *  to black. Clean shots reach 0.18 (night street, dark rose close-up), -4 stops 0.52, a covered lens 1. */
  dark: 0.5,
  /** blurdetect value (sharpest 5% of 48 px blocks) above which a shot is blurred. Clean shots 1.9-4.1 (the
   *  highest polished dumbbells; a 10% crop of them re-encoded 4.2); Gaussian defocus sigma 1.5 reads 4.4 (a
   *  slight softness, left alone), sigma 3 5.3, 6 7.6, 10 10.4; a 21 px vertical motion blur 5.1. Horizontal
   *  motion blur of 9-41 px reads 4.0-4.3 on the same shot: the rows along the smear stay sharp, so a smear
   *  in one direction is not caught by this edge-width measure. */
  blur: 4.7,
  /** Mean wobble (% of diagonal per 1/12 s) above which a shot is shaky. Synthetic jitter on a steady shot
   *  (peak px → wobble): 3 → 0.15, 8 → 0.36 (borderline, left alone), 16 → 0.73, 30 → 1.39; 12 px on a
   *  forward walk 0.57. Clean shots reach 0.47: a tray pulled out of an oven in jerks fills the frame, and
   *  subject motion that large reads as camera motion. src/media/stabilize.ts SHAKE_LIMIT mirrors this value. */
  shake: 0.52,
  /** Shots shorter than this (s) are flagged 太短 (a hint, not a defect). The set's too-short takes are 0.5 and
   *  0.8 s, its shortest ordinary shot (a trimmed copy) 3.5 s; 1.5 s is about the least a cut can hold. */
  short: 1.5,
  /** Shots shorter than this (s) are merged into a neighbour. */
  minShot: 0.8,
  /** ffmpeg scene score for a cut (no single-shot clip of the set is split, handheld pans and walks included). */
  scene: 0.32,
  /** dHash Hamming distance at or below which keyframes at the same place in two shots can be the same
   *  footage (重复, with dupCellShare deciding). Byte copies 0; copies blurred, colour-cast or re-encoded stay
   *  within it. */
  dupBits: 6,
  /** Any keyframe of a shot within this many dHash bits of any keyframe of an earlier one, at whatever place in
   *  the shot (a trimmed copy shifts every moment), looks alike: 相似. Copies trimmed by 0.6-1.5 s, cropped
   *  5-10% and re-encoded come within 7-10 bits; the closest pair of different shots in the set, shops'
   *  similar subjects included, is 18 bits apart. dHash follows gradients, so copies made brighter or
   *  darker still match. */
  dupNearBits: 13,
  /** Grey levels (0-255) by which a cell of the 32x32 copies must differ to count as changed. */
  dupCellDiff: 24,
  /** Share of changed cells every keyframe must stay under for the shot to be the same footage (重复). Byte
   *  copies 0, blurred or colour-cast copies under it; a ±0.7 stop exposure change already exceeds it, and
   *  different shots of one shop change at least 0.45 of the cells. */
  dupCellShare: 0.01,
  /** Tracks quieter than this mean volume (dB) are not sent for transcription. */
  silentDb: -45,
};
const SEVERE = new Set(['手抖', '过曝', '太暗', '模糊', '黑场', '重复', '误拍']);
/** Transcription base timeout (ms), plus 2 s per second of audio; INGEST_TRANSCRIBE_TIMEOUT_MS overrides the base. */
const transcribeTimeoutMs = (duration: number) =>
  (Number(process.env.INGEST_TRANSCRIBE_TIMEOUT_MS) || 60_000) + Math.max(0, duration) * 2_000;
const MAX_TEXT = 60_000;
const MAX_PDF_PAGES = 30;

/** A message meant for the user; anything else is reported as a generic failure of the stage. */
class IngestError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Running tools safely

interface RunOpts { timeoutMs: number; onStdout?: (b: Buffer) => void; keepStdout?: boolean }

/**
 * Runs a command, killing it after `timeoutMs`. ffmpeg/ffprobe callers must put '-protocol_whitelist',
 * 'file,pipe' before every user-file input themselves (see `safeIn`).
 */
function run(cmd: string, args: string[], opts: RunOpts): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, opts.timeoutMs);
    p.stdout.on('data', (d: Buffer) => {
      if (opts.onStdout) opts.onStdout(d);
      if (opts.keepStdout !== false) out.push(d);
    });
    p.stderr.on('data', (d) => {
      err += d;
      // Keep memory bounded on chatty runs: the head carries the stream info, the tail the parsed output.
      if (err.length > 64 << 20) err = err.slice(-(32 << 20));
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new IngestError(`处理超时（${cmd} 超过 ${Math.round(opts.timeoutMs / 1000)} 秒未完成）`));
      else if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`));
      else resolvePromise({ stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** An input that may only be read from the local disk or a pipe (no http, concat, subfile tricks). */
const safeIn = (file: string) => ['-protocol_whitelist', 'file,pipe', '-i', file];
const ff = (args: string[], opts: RunOpts) => run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], opts);

const FILTERS = (() => {
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-filters'], { timeout: 10_000 }).toString();
  } catch {
    return '';
  }
})();
const hasFilter = (name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(FILTERS);

/** Escapes a path for use as a filter option value inside single quotes. */
const filterPath = (p: string) => `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** Size with the long edge at most `long`, aspect kept, even sides. */
function fit(w: number, h: number, long: number) {
  const k = Math.min(1, long / Math.max(w, h));
  return { w: even(w * k), h: even(h * k) };
}

// ---------------------------------------------------------------------------------------------------------
// Index

const indexFile = (projectDir: string) => join(projectDir, 'media_index.json');

/** All media items of a project, in the order they were added; [] when the index is missing or unreadable. */
export function readIndex(projectDir: string): MediaItem[] {
  try {
    const j = JSON.parse(readFileSync(indexFile(projectDir), 'utf8')) as unknown;
    const items = Array.isArray(j) ? j : (j as { items?: unknown })?.items;
    return Array.isArray(items) ? (items as MediaItem[]).filter((x) => x && typeof x.id === 'string') : [];
  } catch {
    return [];
  }
}

// Every change is a synchronous read-modify-write followed by tmp+rename, so within this process writes to
// one project can never interleave and readers never see half a file.
function writeIndex(projectDir: string, items: MediaItem[]) {
  const file = indexFile(projectDir);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 1));
  renameSync(tmp, file);
}

/** Adds an uploaded file to the index as a queued item with the next free id ('m1', 'm2', …). */
export function registerMedia(projectDir: string, upload: { name: string; kind: MediaItem['kind']; file: string }): MediaItem {
  insideProject(projectDir, upload.file);
  const items = readIndex(projectDir);
  const next = items.reduce((n, x) => Math.max(n, Number(/^m(\d+)$/.exec(x.id)?.[1] ?? 0)), 0) + 1;
  const item: MediaItem = {
    id: `m${next}`, name: upload.name, kind: upload.kind, file: upload.file,
    segments: [], status: 'queued', addedAt: new Date().toISOString(),
  };
  items.push(item);
  writeIndex(projectDir, items);
  return item;
}

/** Merges `patch` into item `id` and saves; undefined when there is no such item. */
export function updateMedia(projectDir: string, id: string, patch: Partial<MediaItem>): MediaItem | undefined {
  const items = readIndex(projectDir);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return undefined;
  const merged = { ...items[i]!, ...patch, id };
  // An explicit undefined clears the field (JSON would drop it anyway; this keeps the returned object honest).
  for (const k of Object.keys(patch) as Array<keyof MediaItem>) if (patch[k] === undefined) delete merged[k];
  items[i] = merged;
  writeIndex(projectDir, items);
  return merged;
}

/** Absolute path of a project-relative file, refusing anything that would leave the project dir. */
function insideProject(projectDir: string, rel: string) {
  const root = resolve(projectDir);
  const abs = resolve(root, rel);
  if (!abs.startsWith(root + sep)) throw new IngestError('素材路径不在项目目录内');
  return abs;
}

// ---------------------------------------------------------------------------------------------------------
// Probing

interface Probe {
  /** Container duration (the longest track); `videoDuration` is the picture's own, 0 when not stated. */
  duration: number; videoDuration: number; width: number; height: number; fps: number; codec: string; bitDepth: number; rotation: number;
  hasVideo: boolean; hasAudio: boolean; transfer: string;
}

async function probe(file: string, timeoutMs = 20_000): Promise<Probe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file,
  ], { timeoutMs });
  type S = {
    codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
    pix_fmt?: string; bits_per_raw_sample?: string; duration?: string; color_transfer?: string; tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number }>; disposition?: { attached_pic?: number };
  };
  const j = JSON.parse(stdout.toString()) as { streams?: S[]; format?: { duration?: string } };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const rate = (r?: string) => {
    const [n, d] = (r ?? '0/0').split('/').map(Number);
    return n && d ? n / d : 0;
  };
  let rotation = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0) || 0;
  rotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const sideways = rotation === 90 || rotation === 270;
  const pix = v?.pix_fmt ?? '';
  const depth = /p(\d+)/.exec(pix.replace(/^yuv[aj]?4\d\d|^gbrap?|^gray/, 'p'))?.[1];
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0,
    videoDuration: Number(v?.duration ?? 0) || 0,
    width: (sideways ? v?.height : v?.width) ?? 0,
    height: (sideways ? v?.width : v?.height) ?? 0,
    fps: Math.round((rate(v?.avg_frame_rate) || rate(v?.r_frame_rate)) * 1000) / 1000,
    codec: v?.codec_name ?? a?.codec_name ?? '',
    bitDepth: Number(depth ?? v?.bits_per_raw_sample ?? 8) || 8,
    rotation,
    hasVideo: !!v,
    hasAudio: !!a,
    transfer: v?.color_transfer ?? '',
  };
}

// ---------------------------------------------------------------------------------------------------------
// Proxies

/** H.264 8-bit 4:2:0, long edge ≤ 1280, ≤ 30 fps, 2 s GOP (fast seeking), AAC 48 kHz stereo, faststart. */
async function videoProxy(src: string, out: string, info: Probe, onPct: (p: number) => void) {
  const vf = [
    // Rotation is applied by the decoder (autorotate) before this, so iw/ih are the display sides.
    "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
    ...(info.fps > 30.5 || !info.fps ? ['fps=30'] : []),
    // HDR (HLG or PQ) footage would look grey and flat squeezed straight into 8-bit SDR. Tone-mapped after
    // the downscale, where the float conversion costs a third as much.
    ...(/arib-std-b67|smpte2084/.test(info.transfer) && hasFilter('zscale') && hasFilter('tonemap')
      ? ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv']
      : []),
    'format=yuv420p',
  ].join(',');
  const gop = String(Math.round(Math.min(info.fps || 30, 30) * 2));
  let buf = '';
  await atomicOutput(out, async (tmp) => void await ff([
    '-loglevel', 'error', '-progress', 'pipe:1', ...safeIn(src),
    '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : []), '-sn', '-dn', '-map_metadata', '-1',
    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-g', gop,
    '-threads', '0', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an']),
    '-movflags', '+faststart', '-f', 'mp4', tmp,
  ], {
    // 1080p HEVC 10-bit runs at ~6x realtime on 4 cores; 4x the duration leaves room for 4K60 on a slow box.
    timeoutMs: 120_000 + info.duration * 4_000,
    keepStdout: false,
    onStdout: (d) => {
      buf = (buf + d.toString()).slice(-400);
      const us = [...buf.matchAll(/out_time_us=(\d+)/g)].at(-1)?.[1];
      if (us && info.duration > 0) onPct(Math.min(1, Number(us) / 1e6 / info.duration));
    },
  }));
}

/** AAC 48 kHz stereo .m4a. */
async function audioProxy(src: string, out: string, duration: number) {
  await atomicOutput(out, async (tmp) => void await ff([
    '-loglevel', 'error', ...safeIn(src), '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp,
  ], { timeoutMs: 60_000 + duration * 1_000 }));
}

/**
 * JPEG, long edge ≤ 1920, even sides; transparency is laid on white so logos keep their shape. The size comes
 * from the decoded frame, never from the probe: ffmpeg turns a JPEG upright by its EXIF orientation while
 * ffprobe reports the stored sides, so forcing the probed size would squash portrait phone photos.
 */
async function imageProxy(src: string, out: string) {
  await atomicOutput(out, async (tmp) => void await ff([
    '-loglevel', 'error', ...safeIn(src),
    '-filter_complex', [
      "[0:v]scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale='max(2,trunc(iw/2)*2)':'max(2,trunc(ih/2)*2)',format=rgba,split=2[fg][bg0]",
      // An opaque white canvas exactly the size of the scaled frame.
      '[bg0]lutrgb=r=255:g=255:b=255:a=255[bg]',
      '[bg][fg]overlay=format=auto,format=yuvj420p',
    ].join(';'),
    '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-update', '1', tmp,
  ], { timeoutMs: 30_000 }));
}

// ---------------------------------------------------------------------------------------------------------
// Analysis

/** `hi`: the frame's 98th-percentile grey level. */
interface FrameStat { t: number; white: number; dark: number; mean: number; max: number; hi: number }
interface Analysis {
  frames: FrameStat[];
  blur: Array<{ t: number; v: number }> | null;
  /** Per 1/12 s step: camera translation in fractions of the frame diagonal. */
  motion: Array<{ t: number; dx: number; dy: number }> | null;
  cuts: number[];
  black: Array<[number, number]>;
}

const GREY_LONG = 160;
const ANALYSIS_FPS = 4;
/** blurdetect pooling: block side (px on the proxy) and the share of sharpest blocks that count. */
const BLUR_BLOCK = 48;
const BLUR_POOL = 5;
const SHAKE_FPS = 12;

/**
 * One decoding pass over a proxy (or one still): grey thumbnails for exposure/darkness/black, blurdetect,
 * vidstabdetect, scene cuts and blackdetect, all from the same decoded frames.
 */
async function analyse(file: string, w: number, h: number, still: boolean, duration: number): Promise<Analysis> {
  const g = fit(w, h, GREY_LONG);
  const lo = fit(w, h, 640);
  const blurOk = hasFilter('blurdetect');
  const stabOk = !still && hasFilter('vidstabdetect');
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  const trf = join(dir, 'motion.trf');
  const graph: string[] = [];
  if (still) {
    // blurdetect measures edge width in pixels, so stills are brought to the video proxies' scale first.
    const b = fit(w, h, 1280);
    graph.push(`[0:v]format=yuv420p,split=2[hi0][gr]`, `[hi0]scale=${b.w}:${b.h}[hi]`);
  } else {
    graph.push(`[0:v]split=2[hi][lo0]`, `[lo0]scale=${lo.w}:${lo.h},split=${stabOk ? 4 : 3}[sc][bk][gr0]${stabOk ? '[st]' : ''}`);
    graph.push(`[sc]select='gt(scene,${QUALITY_LIMITS.scene})',showinfo,nullsink`);
    graph.push(`[bk]blackdetect=d=0.1:pix_th=0.10,nullsink`);
    if (stabOk) graph.push(`[st]fps=${SHAKE_FPS},vidstabdetect=shakiness=8:accuracy=9:result=${filterPath(trf)},nullsink`);
    graph.push(`[gr0]fps=${ANALYSIS_FPS}[gr]`);
  }
  graph.push(blurOk
    ? `[hi]${still ? '' : `fps=${ANALYSIS_FPS},`}blurdetect=block_width=${BLUR_BLOCK}:block_height=${BLUR_BLOCK}:block_pct=${BLUR_POOL},metadata=print:key=lavfi.blur,nullsink`
    : '[hi]nullsink');
  graph.push(`[gr]scale=${g.w}:${g.h}:flags=area,format=gray[g]`);
  const size = g.w * g.h;
  const frames: FrameStat[] = [];
  let pending: Buffer = Buffer.alloc(0);
  const hist = new Uint32Array(256);
  const take = (px: Buffer) => {
    let white = 0, dark = 0, sum = 0, max = 0;
    hist.fill(0);
    for (const v of px) {
      if (v >= 250) white++;
      if (v <= 25) dark++;
      sum += v;
      if (v > max) max = v;
      hist[v]!++;
    }
    let hi = 255;
    for (let above = 0; hi > 0 && (above += hist[hi]!) < size * 0.02; hi--);
    frames.push({ t: frames.length / ANALYSIS_FPS, white: white / size, dark: dark / size, mean: sum / size, max, hi });
  };
  try {
    const { stderr } = await ff([
      '-loglevel', 'info', '-nostats', ...safeIn(file), '-filter_complex', graph.join(';'),
      '-map', '[g]', '-f', 'rawvideo', 'pipe:1',
    ], {
      timeoutMs: 60_000 + duration * 3_000,
      keepStdout: false,
      onStdout: (d) => {
        pending = pending.length ? Buffer.concat([pending, d]) : d;
        let off = 0;
        for (; off + size <= pending.length; off += size) take(pending.subarray(off, off + size));
        pending = pending.subarray(off);
      },
    });
    const cuts = [...stderr.matchAll(/Parsed_showinfo[^\n]*pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    const black = [...stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
    // The metadata filter prints "frame:N pts:… pts_time:T" and then "lavfi.blur=V".
    let blur: Analysis['blur'] = null;
    if (blurOk) {
      blur = [];
      for (const m of stderr.matchAll(/pts_time:\s*([\d.]+)\s*\n[^\n]*lavfi\.blur=([\d.]+)/g)) blur.push({ t: Number(m[1]), v: Number(m[2]) });
    }
    let motion: Analysis['motion'] = null;
    if (stabOk && existsSync(trf)) motion = parseTrf(await readFile(trf, 'utf8'), Math.hypot(lo.w, lo.h));
    return { frames, blur, motion, cuts, black };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** vidstab's text format: one line per frame with its local motion vectors "(LM dx dy x y size contrast match)". */
function parseTrf(text: string, diag: number): Array<{ t: number; dx: number; dy: number }> {
  const out: Array<{ t: number; dx: number; dy: number }> = [];
  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[s.length >> 1]! : 0;
  };
  for (const line of text.split('\n')) {
    const m = /^Frame (\d+) \(List \d+ \[(.*)\]\)/.exec(line);
    if (!m) continue;
    const lms = [...m[2]!.matchAll(/\(LM (-?\d+) (-?\d+) /g)];
    out.push({
      t: (Number(m[1]) - 1) / SHAKE_FPS,
      dx: median(lms.map((x) => Number(x[1]))) / diag,
      dy: median(lms.map((x) => Number(x[2]))) / diag,
    });
  }
  return out;
}

/** Wobble per step after steady movement (±0.5 s moving average) is removed, in % of the diagonal. */
function wobble(motion: Array<{ t: number; dx: number; dy: number }>): number[] {
  const half = Math.round(SHAKE_FPS / 2);
  return motion.map((m, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(motion.length - 1, i + half); k++) {
      sx += motion[k]!.dx;
      sy += motion[k]!.dy;
      n++;
    }
    return Math.hypot(m.dx - sx / n, m.dy - sy / n) * 100;
  });
}

/** Shot boundaries from scene cuts; shots under `minShot` are merged into their shorter neighbour. */
function shots(cuts: number[], duration: number): Array<[number, number]> {
  const pts = [0, ...cuts.filter((c) => c > 0.05 && c < duration - 0.05).sort((a, b) => a - b), duration];
  let segs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < pts.length; i++) if (pts[i + 1]! > pts[i]!) segs.push([pts[i]!, pts[i + 1]!]);
  if (!segs.length) segs = [[0, duration]];
  for (;;) {
    const i = segs.findIndex(([a, b]) => b - a < QUALITY_LIMITS.minShot);
    if (i < 0 || segs.length < 2) break;
    const prev = segs[i - 1], next = segs[i + 1];
    const j = !prev ? i + 1 : !next ? i - 1 : prev[1] - prev[0] <= next[1] - next[0] ? i - 1 : i + 1;
    const [lo, hi] = [Math.min(i, j), Math.max(i, j)];
    segs.splice(lo, 2, [segs[lo]![0], segs[hi]![1]]);
  }
  return segs;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Quality, flags and usability of the shot [a, b]. A 'graphic' (a PNG/GIF/BMP logo, menu or poster) only gets
 * the black check: a white background is not overexposure and flat colour is not blur.
 */
function judge(an: Analysis, a: number, b: number, mode: 'video' | 'photo' | 'graphic'): Pick<MediaSegment, 'quality' | 'flags' | 'usable'> {
  const still = mode !== 'video';
  const within = <T extends { t: number }>(xs: T[]) => {
    const inside = xs.filter((x) => x.t >= a - 1e-6 && x.t < b);
    if (inside.length || !xs.length) return inside;
    // A shot shorter than the sampling step: take the nearest sample.
    const mid = (a + b) / 2;
    return [xs.reduce((best, x) => (Math.abs(x.t - mid) < Math.abs(best.t - mid) ? x : best))];
  };
  const fr = within(an.frames);
  const exposure = round(mean(fr.map((f) => f.white)));
  const dark = round(mean(fr.map((f) => f.dark)));
  const bright = round(mean(fr.map((f) => f.hi)), 1);
  const blur = an.blur && an.blur.length ? round(mean(within(an.blur).map((x) => x.v)), 2) : null;
  let shake: number | null = null;
  if (an.motion) {
    const w = wobble(an.motion);
    const idx = an.motion.map((m, i) => ({ t: m.t, i })).filter((m) => m.t > a + 0.01 && m.t < b);
    shake = idx.length ? round(mean(idx.map((m) => w[m.i]!))) : 0;
  }
  let black: boolean;
  const ymax = fr.length ? [...fr.map((f) => f.max)].sort((x, y) => x - y)[fr.length >> 1]! : 255;
  if (still) black = ymax < 60;
  else {
    const covered = an.black.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
    black = covered >= 0.6 * (b - a) && ymax < 60;
  }
  const flags: string[] = [];
  if (shake !== null && shake > QUALITY_LIMITS.shake) flags.push('手抖');
  const photo = mode !== 'graphic';
  if (photo && exposure > QUALITY_LIMITS.exposure) flags.push('过曝');
  if (black) flags.push('黑场');
  else if (photo && fr.length && (bright < QUALITY_LIMITS.bright || dark > QUALITY_LIMITS.dark)) flags.push('太暗');
  if (photo && blur !== null && blur > QUALITY_LIMITS.blur && !black) flags.push('模糊');
  if (!still && b - a < QUALITY_LIMITS.short) flags.push('太短');
  return { quality: { exposure, dark, bright, blur, shake, black }, flags, usable: !flags.some((f) => SEVERE.has(f)) };
}

// ---------------------------------------------------------------------------------------------------------
// Keyframes, contact sheet, fingerprints

const frameRel = (id: string, k: number, n: number) => `assets/proxy/${id}-s${k}-${n}.jpg`;

/** Grabs frames at `times` from our own proxy, a batch of inputs per ffmpeg run, 512 px long edge. */
async function grabFrames(proxy: string, jobs: Array<{ t: number; out: string }>) {
  for (let i = 0; i < jobs.length; i += 12) {
    const batch = jobs.slice(i, i + 12);
    const args = ['-loglevel', 'error'];
    for (const j of batch) args.push('-ss', j.t.toFixed(3), ...safeIn(proxy));
    batch.forEach((j, k) => args.push('-map', `${k}:v:0`, '-frames:v', '1',
      '-vf', "scale='if(gte(iw,ih),min(512,iw),-2)':'if(gte(iw,ih),-2,min(512,ih))'", '-q:v', '4', '-f', 'image2', '-update', '1', `${j.out}.tmp`));
    try {
      await ff(args, { timeoutMs: 30_000 + batch.length * 5_000, keepStdout: false });
      for (const j of batch) {
        if (!existsSync(`${j.out}.tmp`) || statSync(`${j.out}.tmp`).size === 0) throw new Error(`no frame at ${j.t}`);
        await rename(`${j.out}.tmp`, j.out);
      }
    } finally {
      for (const j of batch) rmSync(`${j.out}.tmp`, { force: true });
    }
  }
}

/** One tiled JPEG of every shot's middle frame, each numbered with its segment index, at most 6 per row. */
async function contactSheet(projectDir: string, id: string, count: number, out: string) {
  const cols = Math.min(6, count);
  const rows = Math.ceil(count / cols);
  const font = CJK_FONT_FILE ? `fontfile=${filterPath(CJK_FONT_FILE)}:` : '';
  await atomicOutput(out, async (tmp) => void await ff([
    '-loglevel', 'error', '-framerate', '1', '-start_number', '0', '-protocol_whitelist', 'file,pipe',
    '-i', join(projectDir, 'assets', 'proxy', `${id}-s%d-2.jpg`),
    '-vf', [
      "scale='if(gte(iw,ih),256,-2)':'if(gte(iw,ih),-2,256)'",
      `drawtext=${font}text='%{frame_num}':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6:x=8:y=8`,
      `tile=${cols}x${rows}:padding=4:margin=4:color=white`,
    ].join(','),
    '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-update', '1', tmp,
  ], { timeoutMs: 30_000 + count * 500 }));
}

const dhashFile = (projectDir: string, id: string) => join(projectDir, 'assets', 'proxy', `${id}.dhash.json`);

/** A keyframe's fingerprints: the 64-bit dHash (hex) and a 32x32 grey copy (1024 bytes). */
interface Print { hash: string; grey: Buffer }

// One decode gives both: the 9x8 copy is padded to 32 wide and stacked on the 32x32 one, so the dHash is
// bit for bit the one a plain 'scale=9:8' run gives (and older caches stay valid).
const PRINT_ARGS = (file: string) => ['-hide_banner', '-nostdin', '-loglevel', 'error', ...safeIn(file),
  '-filter_complex', '[0:v]split=2[a][b];[a]scale=9:8:flags=area,format=gray,pad=32:8[h];[b]scale=32:32:flags=area,format=gray[g];[h][g]vstack',
  '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'];
const PRINT_BYTES = 32 * 40;

/** 64-bit difference hash (hex) of a 9x8 grey copy (rows of `stride` bytes): bit = left pixel brighter than its right neighbour. */
function dhashOf(raw: Buffer, stride = 9): string {
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (raw[y * stride + x]! > raw[y * stride + x + 1]! ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

const printOf = (raw: Buffer): Print | null =>
  raw.length >= PRINT_BYTES ? { hash: dhashOf(raw, 32), grey: Buffer.from(raw.subarray(32 * 8, PRINT_BYTES)) } : null;

function printSync(file: string): Print | null {
  try {
    return printOf(execFileSync('ffmpeg', PRINT_ARGS(file), { timeout: 10_000, killSignal: 'SIGKILL' }));
  } catch {
    return null;
  }
}

async function print(file: string): Promise<Print | null> {
  try {
    const [cmd, ...args] = ['ffmpeg', ...PRINT_ARGS(file)];
    return printOf((await run(cmd!, args, { timeoutMs: 10_000 })).stdout);
  } catch {
    return null;
  }
}

/** The cache file's entries: '<frame>' → dHash hex, 'g:<frame>' → base64 of the 32x32 grey copy. */
function cachePrint(cache: Record<string, string>, rel: string, p: Print) {
  cache[rel] = p.hash;
  cache[`g:${rel}`] = p.grey.toString('base64');
}

const hamming = (a: string, b: string) => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  for (; x; x &= x - 1n) n++;
  return n;
};

/** A frame with too little structure (flat black, white, a wall) hashes alike whatever it shows. */
const structured = (h: string) => {
  const ones = hamming(h, '0000000000000000');
  return ones >= 6 && ones <= 58;
};

/** Share of the 32x32 cells whose grey levels differ by more than `dupCellDiff`. */
function changedShare(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < 1024; i++) if (Math.abs(a[i]! - b[i]!) > QUALITY_LIMITS.dupCellDiff) n++;
  return n / 1024;
}

/**
 * Marks repeated takes across all ready videos, comparing each shot with the shots of earlier items (never
 * with another shot of its own item: A-B-A cutting and a cut found inside one continuous shot are not repeats).
 *   重复  the same footage: all three keyframes (20/50/80 %) within 6 dHash bits, at least two of them with
 *        structure, and on 32x32 grey copies under 1 % of cells changed by more than 24 levels at every
 *        keyframe. dupOf, the flag and usable false. A 9x8 dHash alone cannot see a person filling 5-10 % of a
 *        locked-off frame, so it never decides this on its own.
 *   相似  only looks alike: some keyframe within 13 dHash bits of some keyframe of the other shot, wherever
 *        each sits in its shot (a copy trimmed, cropped, re-encoded or brightened, a second take of the same
 *        action, another shot from the same tripod position). dupOf and the flag as a hint; usable is left
 *        as it was, for vision or the agent to decide.
 * Only these marks are owned here: each run removes its own '重复'/'相似'/dupOf and recomputes them; usable
 * becomes what it was without the 重复 mark, so flags other steps set (误拍 from describe) are kept.
 */
export function markDuplicates(projectDir: string): void {
  const items = readIndex(projectDir);
  const videos = items.filter((x) => x.kind === 'video' && x.status === 'ready')
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  type Seen = { item: string; seg: number; hashes: Array<string | undefined>; greys: Array<() => Buffer | undefined> };
  const seen: Seen[] = [];
  const caches: Array<{ id: string; cache: Record<string, string>; changed: boolean }> = [];
  let changed = false;
  for (const v of videos) {
    const c = { id: v.id, cache: {} as Record<string, string>, changed: false };
    try { c.cache = JSON.parse(readFileSync(dhashFile(projectDir, v.id), 'utf8')) as Record<string, string>; } catch { /* rebuild */ }
    caches.push(c);
    const fill = (rel: string) => {
      const p = printSync(join(projectDir, rel));
      if (!p) return false;
      cachePrint(c.cache, rel, p);
      c.changed = true;
      return true;
    };
    const hashOf = (rel: string | undefined) => {
      if (!rel) return undefined;
      if (!c.cache[rel] && !fill(rel)) return undefined;
      return structured(c.cache[rel]!) ? c.cache[rel] : undefined;
    };
    // Grey copies are only needed for the rare close pair, so a cache from before they existed is filled lazily.
    const greyOf = (rel: string | undefined) => () => {
      if (!rel) return undefined;
      if (!c.cache[`g:${rel}`] && !fill(rel)) return undefined;
      const b = Buffer.from(c.cache[`g:${rel}`] ?? '', 'base64');
      return b.length === 1024 ? b : undefined;
    };
    v.segments.forEach((s, k) => {
      const three = s.frames.length === 3;
      const me: Seen = {
        item: v.id, seg: k,
        hashes: three ? s.frames.map(hashOf) : [undefined, hashOf(s.frames[0]), undefined],
        greys: three ? s.frames.map(greyOf) : [],
      };
      const before = JSON.stringify([s.dupOf, s.flags, s.usable]);
      const others = s.flags.filter((f) => f !== '重复' && f !== '相似');
      // What usable would be without our 重复 mark: while we held it false, only the other flags can tell.
      const base = s.flags.includes('重复') ? !others.some((f) => SEVERE.has(f)) : s.usable;
      // Any keyframe against any of the other shot's: a trimmed copy shifts every moment.
      const loose = (o: Seen) => me.hashes.some((h) => !!h && o.hashes.some((other) => !!other && hamming(h, other) <= QUALITY_LIMITS.dupNearBits));
      const same = (o: Seen) => {
        if (me.greys.length !== 3 || o.greys.length !== 3) return false;
        let both = 0;
        for (let n = 0; n < 3; n++) {
          const h = me.hashes[n], other = o.hashes[n];
          if (!!h !== !!other) return false;
          if (h && other) {
            if (hamming(h, other) > QUALITY_LIMITS.dupBits) return false;
            both++;
          }
        }
        if (both < 2) return false;
        for (let n = 0; n < 3; n++) {
          const a = me.greys[n]!(), b = o.greys[n]!();
          if (!a || !b || changedShare(a, b) >= QUALITY_LIMITS.dupCellShare) return false;
        }
        return true;
      };
      const candidates = seen.filter((o) => o.item !== v.id && loose(o));
      const orig = candidates.find(same);
      delete s.dupOf;
      s.flags = others;
      if (orig) {
        s.dupOf = `${orig.item}:${orig.seg}`;
        s.flags.push('重复');
        s.usable = false;
      } else {
        if (candidates[0]) {
          s.dupOf = `${candidates[0].item}:${candidates[0].seg}`;
          s.flags.push('相似');
        }
        s.usable = base;
        seen.push(me);
      }
      if (JSON.stringify([s.dupOf, s.flags, s.usable]) !== before) changed = true;
    });
  }
  for (const c of caches) {
    if (!c.changed) continue;
    try { writeFileSync(dhashFile(projectDir, c.id), JSON.stringify(c.cache)); } catch { /* only a cache */ }
  }
  // Nothing awaits between the read above and this write, so no other update can slip in between.
  if (changed) writeIndex(projectDir, items);
}

// ---------------------------------------------------------------------------------------------------------
// Transcripts and documents

async function meanVolume(file: string, duration: number): Promise<number> {
  const { stderr } = await ff(['-loglevel', 'info', '-nostats', ...safeIn(file), '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { timeoutMs: 30_000 + duration * 500, keepStdout: false });
  return Number(/mean_volume:\s*(-?[\d.]+|-inf)/.exec(stderr)?.[1]?.replace('-inf', '-200') ?? -200);
}

/** A track ready to go out for transcription: a 16 kHz mono mp3 in a temp dir the caller removes. */
interface Speech { dir: string; mp3: string; duration: number }

/** The CPU part, run inside an ingest slot: null when the track is too quiet for anyone to be speaking. */
async function prepareSpeech(file: string, duration: number): Promise<Speech | null> {
  if ((await meanVolume(file, duration)) < QUALITY_LIMITS.silentDb) return null;
  const dir = await mkdtemp(join(tmpdir(), 'ingest-asr-'));
  try {
    const mp3 = join(dir, 'speech.mp3');
    await ff(['-loglevel', 'error', ...safeIn(file), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-q:a', '6', mp3],
      { timeoutMs: 30_000 + duration * 1_000, keepStdout: false });
    return { dir, mp3, duration };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * The network part, run outside the slots: the transcriber raced against 60 s + 2 s per second of audio, so a
 * relay call stuck on a dead socket gives up instead of holding the item in 'processing' for good.
 */
async function transcribeSpeech(sp: Speech, transcribe: NonNullable<Deps['transcribe']>): Promise<Line[]> {
  const ms = transcribeTimeoutMs(sp.duration);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`转写超时（超过 ${Math.round(ms / 1000)} 秒没有结果）`)), ms);
  });
  try {
    const lines = await Promise.race([Promise.resolve().then(() => transcribe(sp.mp3)), timeout]);
    return (Array.isArray(lines) ? lines : [])
      .filter((l) => l && typeof l.text === 'string' && l.text.trim() && Number.isFinite(l.start) && Number.isFinite(l.end))
      .map((l) => ({ start: round(l.start, 2), end: round(l.end, 2), text: l.text.trim() }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Saves the transcript; a failing or timed-out transcriber leaves the item without one (and ready: the
 * picture is still usable) so the next ingest call tries again.
 */
async function addTranscript(projectDir: string, id: string, sp: Speech, transcribe: NonNullable<Deps['transcribe']>) {
  try {
    return updateMedia(projectDir, id, { transcript: await transcribeSpeech(sp, transcribe) });
  } catch (e) {
    console.error(`[ingest] ${id} transcription failed:`, (e as Error)?.message ?? e);
    return undefined;
  }
}

async function pdfText(file: string): Promise<string> {
  let info: string;
  try {
    info = (await run('pdfinfo', [file], { timeoutMs: 15_000 })).stdout.toString();
  } catch (e) {
    if (e instanceof IngestError) throw e;
    throw new IngestError('无法读取这个 PDF，文件可能已损坏或加了密码');
  }
  const pages = Number(/^Pages:\s*(\d+)/m.exec(info)?.[1] ?? 0);
  if (pages > MAX_PDF_PAGES) throw new IngestError(`PDF 共 ${pages} 页，超过 ${MAX_PDF_PAGES} 页的上限，请只上传需要的部分`);
  const { stdout } = await run('pdftotext', ['-l', String(MAX_PDF_PAGES), '-layout', '-enc', 'UTF-8', file, '-'], { timeoutMs: 15_000 })
    .catch((e) => { throw e instanceof IngestError ? e : new IngestError('无法从这个 PDF 中提取文字'); });
  return clip(stdout.toString('utf8'));
}

const clip = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);

// ---------------------------------------------------------------------------------------------------------
// Pipeline

const limit = createLimiter(2);
const inflight = new Map<string, Promise<MediaItem>>();

/**
 * Turns registered item `id` into a ready media item: proxy, shots, keyframes, contact sheet, quality flags,
 * transcript (when `deps.transcribe` is given and someone may be speaking) or document text. Status and fields
 * are saved as each step finishes; on failure the item is 'failed' with a Chinese message (this never throws
 * for a bad file). Steps whose outputs already exist are skipped, so calling it again is cheap. At most two
 * ingests do their decoding and encoding at a time in this process; the transcription request itself waits
 * outside those two slots (it is network-bound and has its own timeout). A second call for an item already
 * in progress joins the first.
 */
export function ingestMedia(projectDir: string, id: string, deps: Deps = {}): Promise<MediaItem> {
  const key = `${resolve(projectDir)}#${id}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = pipeline(projectDir, id, deps).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function outputsExist(projectDir: string, item: MediaItem) {
  const has = (rel?: string) => !!rel && existsSync(join(projectDir, rel));
  switch (item.kind) {
    case 'video': return has(item.proxy) && has(item.sheet) && item.segments.length > 0 && item.segments.every((s) => s.frames.every(has));
    case 'image': return has(item.proxy) && item.segments.length === 1;
    case 'audio': return has(item.proxy);
    default: return item.text !== undefined;
  }
}

async function pipeline(projectDir: string, id: string, deps: Deps): Promise<MediaItem> {
  const first = readIndex(projectDir).find((x) => x.id === id);
  if (!first) throw new Error(`找不到素材 ${id}`);
  const progress = (stage: string, pct: number) => {
    try { deps.onProgress?.(stage, Math.round(Math.max(0, Math.min(100, pct)))); } catch { /* the listener's problem */ }
  };
  const needsTranscript = (x: MediaItem) => !!deps.transcribe && (x.kind === 'video' || x.kind === 'audio') && x.hasAudio === true && x.transcript === undefined;
  if (first.status === 'ready' && outputsExist(projectDir, first) && !needsTranscript(first)) {
    progress('done', 100);
    return first;
  }
  let stage = '准备';
  const save = (patch: Partial<MediaItem>) => {
    const r = updateMedia(projectDir, id, patch);
    if (!r) throw new IngestError('素材已被删除');
    return r;
  };
  // Both run synchronously to the end, so whatever ends inside a slot has finished before the slot is free.
  const finish = (cur: MediaItem) => {
    cur = save({ status: 'ready', error: undefined });
    if (cur.kind === 'video') {
      markDuplicates(projectDir);
      cur = readIndex(projectDir).find((x) => x.id === id) ?? cur;
    }
    progress('done', 100);
    return cur;
  };
  const fail = (e: unknown): MediaItem => {
    const msg = e instanceof IngestError ? e.message : `素材处理失败（${stage}）：${String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160)}`;
    console.error(`[ingest] ${id} ${stage}:`, (e as Error)?.message ?? e);
    progress('failed', 100);
    return updateMedia(projectDir, id, { status: 'failed', error: msg }) ?? { ...first, status: 'failed', error: msg };
  };

  // Decoding and encoding, inside one of the two slots. Ends with the item finished, or with the speech
  // track ready to be sent off.
  const local = async (): Promise<{ done: MediaItem } | { cur: MediaItem; speech: Speech }> => {
    let linkDir: string | undefined;
    try {
      const item = readIndex(projectDir).find((x) => x.id === id);
      if (!item) throw new IngestError('素材已被删除');
      let src = insideProject(projectDir, item.file);
      if (!existsSync(src) || !statSync(src).isFile()) throw new IngestError('找不到上传的文件，可能还没传完或已被删除');
      // ffmpeg reads "%d" in an image file name as a numbered sequence; such files are read through a plain link.
      if (src.includes('%')) {
        linkDir = await mkdtemp(join(tmpdir(), 'ingest-in-'));
        const link = join(linkDir, `input${extname(src).replace(/[^.\w]/g, '')}`);
        symlinkSync(src, link);
        src = link;
      }
      save({ status: 'processing', error: undefined });
      mkdirSync(join(projectDir, 'assets', 'proxy'), { recursive: true });
      let cur = item;
      // The proxy to transcribe and its length, for video and audio.
      let speechSrc: { file: string; duration: number } | undefined;
      switch (item.kind) {
        case 'video': {
          stage = '读取视频信息';
          progress('probe', 0);
          const info = await probe(src).catch((e) => { console.warn(`[ingest] probe ${src}: ${String((e as Error).message).slice(0, 300)}`); throw new IngestError('无法读取这个视频，文件可能已损坏或格式不受支持'); });
          if (!info.hasVideo || !info.width) throw new IngestError('这个文件里没有可用的视频画面');
          if (!(info.duration > 0)) throw new IngestError('无法读出视频时长，文件可能不完整');
          const proxy = `assets/proxy/${id}.mp4`;
          cur = save({
            duration: round(info.duration, 3), width: info.width, height: info.height, fps: info.fps, codec: info.codec,
            bitDepth: info.bitDepth, rotation: info.rotation, hasAudio: info.hasAudio,
          });
          stage = '转码';
          if (!existsSync(join(projectDir, proxy))) await videoProxy(src, join(projectDir, proxy), info, (p) => progress('proxy', 5 + p * 50));
          const pAbs = join(projectDir, proxy);
          const pi = await probe(pAbs);
          // The picture's own length: screen recordings and edited exports often carry audio past the last
          // frame, and shots or keyframes there would show nothing.
          const dur = pi.videoDuration || pi.duration || info.duration;
          cur = save({ proxy, duration: round(dur, 3) });
          progress('proxy', 55);
          const sheet = `assets/proxy/${id}.sheet.jpg`;
          const done = cur.segments.length > 0 && cur.segments.every((s) => s.frames.every((f) => existsSync(join(projectDir, f))))
            && existsSync(join(projectDir, sheet));
          if (!done) {
            stage = '分析镜头';
            progress('analyse', 55);
            const an = await analyse(pAbs, pi.width, pi.height, false, pi.duration);
            const bounds = shots(an.cuts, dur);
            progress('keyframes', 75);
            stage = '抽取关键帧';
            // The last keyframe may sit no later than the start of the last frame.
            const lastFrame = Math.max(0, dur - 1 / (pi.fps || info.fps || 30));
            const jobs: Array<{ t: number; out: string }> = [];
            const segments: MediaSegment[] = bounds.map(([a, b], k) => {
              const frames = [0.2, 0.5, 0.8].map((q, n) => {
                const rel = frameRel(id, k, n + 1);
                jobs.push({ t: Math.min(lastFrame, a + (b - a) * q), out: join(projectDir, rel) });
                return rel;
              });
              return { start: round(a, 3), end: round(b, 3), frames, ...judge(an, a, b, 'video') };
            });
            await grabFrames(pAbs, jobs.filter((j) => !existsSync(j.out)));
            stage = '生成缩略图';
            await contactSheet(projectDir, id, segments.length, join(projectDir, sheet));
            const prints: Record<string, string> = {};
            for (const f of segments.flatMap((s) => s.frames)) {
              const p = await print(join(projectDir, f));
              if (p) cachePrint(prints, f, p);
            }
            writeFileSync(dhashFile(projectDir, id), JSON.stringify(prints));
            cur = save({ segments, sheet });
          }
          speechSrc = { file: pAbs, duration: info.duration };
          break;
        }
        case 'audio': {
          stage = '读取音频信息';
          progress('probe', 0);
          const info = await probe(src).catch((e) => { console.warn(`[ingest] probe ${src}: ${String((e as Error).message).slice(0, 300)}`); throw new IngestError('无法读取这个音频，文件可能已损坏或格式不受支持'); });
          if (!info.hasAudio) throw new IngestError('这个文件里没有音频');
          const proxy = `assets/proxy/${id}.m4a`;
          cur = save({ duration: round(info.duration, 3), codec: info.codec, hasAudio: true, segments: [] });
          stage = '转码';
          progress('proxy', 10);
          if (!existsSync(join(projectDir, proxy))) await audioProxy(src, join(projectDir, proxy), info.duration);
          cur = save({ proxy });
          speechSrc = { file: join(projectDir, proxy), duration: info.duration };
          break;
        }
        case 'image': {
          stage = '读取图片信息';
          progress('probe', 0);
          const info = await probe(src).catch((e) => { console.warn(`[ingest] probe ${src}: ${String((e as Error).message).slice(0, 300)}`); throw new IngestError('无法读取这张图片，文件可能已损坏或格式不受支持'); });
          if (!info.hasVideo || !info.width) throw new IngestError('无法读取这张图片的尺寸');
          const proxy = `assets/proxy/${id}.jpg`;
          stage = '生成预览图';
          progress('proxy', 20);
          if (!existsSync(join(projectDir, proxy))) await imageProxy(src, join(projectDir, proxy));
          stage = '分析画面';
          progress('analyse', 60);
          const pAbs = join(projectDir, proxy);
          const pi = await probe(pAbs);
          // The proxy is upright (EXIF orientation applied); the probe of the original may give the stored sides.
          const turned = info.width !== info.height && pi.width !== pi.height && (info.width > info.height) !== (pi.width > pi.height);
          const an = await analyse(pAbs, pi.width, pi.height, true, 0);
          cur = save({
            width: turned ? info.height : info.width, height: turned ? info.width : info.height, codec: info.codec, bitDepth: info.bitDepth,
            proxy, segments: [{ start: 0, end: 0, frames: [proxy], ...judge(an, 0, 1, /^(png|gif|bmp|tiff|svg)/.test(info.codec) ? 'graphic' : 'photo') }],
          });
          break;
        }
        case 'pdf': {
          stage = '读取 PDF';
          progress('text', 10);
          cur = save({ text: await pdfText(src), segments: [] });
          break;
        }
        case 'text': {
          stage = '读取文本';
          progress('text', 10);
          if (statSync(src).size > 8 << 20) throw new IngestError('文本文件太大（超过 8MB）');
          const raw = readFileSync(src);
          // Notes written on Chinese Windows are often GB18030 rather than UTF-8.
          let s: string;
          try { s = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
            try { s = new TextDecoder('gb18030', { fatal: true }).decode(raw); } catch { s = new TextDecoder('utf-8').decode(raw); }
          }
          s = s.replace(/^﻿/, '');
          cur = save({ text: clip(s), segments: [] });
          break;
        }
        default:
          throw new IngestError('不支持这种素材类型');
      }
      if (speechSrc && needsTranscript(cur)) {
        stage = '转写语音';
        progress('transcribe', cur.kind === 'video' ? 85 : 60);
        try {
          const speech = await prepareSpeech(speechSrc.file, speechSrc.duration);
          if (speech) return { cur, speech };
          cur = save({ transcript: [] });
        } catch (e) {
          // As with a failing transcriber: ready without a transcript, tried again next time.
          console.error(`[ingest] ${id} transcription failed:`, (e as Error)?.message ?? e);
        }
      }
      return { done: finish(cur) };
    } catch (e) {
      return { done: fail(e) };
    } finally {
      if (linkDir) await rm(linkDir, { recursive: true, force: true });
    }
  };

  const r = await limit(local);
  if ('done' in r) return r.done;
  try {
    const cur = await addTranscript(projectDir, id, r.speech, deps.transcribe!) ?? r.cur;
    return finish(cur);
  } catch (e) {
    return fail(e);
  } finally {
    await rm(r.speech.dir, { recursive: true, force: true });
  }
}
