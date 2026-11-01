// Steadies a shaky take (ingest flags it 手抖) so that, when it is the only take of a moment, it can still be
// cut in. Two-pass vidstab: vidstabdetect measures the frame-to-frame camera motion, vidstabtransform moves
// each frame back onto a smoothed camera path and zooms in just enough that the moved frame never shows its
// edge. Falls back to ffmpeg's deshake (one pass, a fixed crop-in) when this ffmpeg was built without vidstab.
//
// Why the steps are as they are:
//  - Detection runs on a copy at most 960 px long and its motion file is scaled back to the source size:
//    vidstabdetect costs ~6 CPU-seconds per second of 1080x1920 footage at full size and half that here, and
//    the camera motion it finds differs by under half a pixel.
//  - The zoom is worked out here, not by vidstab's optzoom: optzoom=1 ignores the 10 % most extreme frames, so
//    those still slide their edge into view. vidstab's global motions (written by a debug run on a blank
//    picture, which costs nothing) are smoothed the way vidstab smooths them (its Gaussian camera path), and
//    the zoom is the one the worst frame needs, plus a 1 % margin. crop=keep fills any leftover sliver with
//    the previous frame rather than black.
//  - A take that barely travels (locking it off costs at most 3 % more zoom than following a smoothed path)
//    is held still like on a tripod (vidstab's tripod mode, every frame aligned to the first); one that pans
//    or walks keeps its intended movement and loses the wobble around it. Handheld phone takes nearly always
//    drift (the dev set's "static" talking shot trucks ~55 px and turns ~4° in 5 s, so locking it off would
//    need 25 % zoom); tripod mode is for a take shot from a fixed spot, like the check's shaken still.
//  - The smoothing window is set in seconds (one second each side of each frame; 24 frames at 24 fps), since
//    the shake measure counts as wobble whatever strays from a ±0.5 s average. Calibrated on the dev set's
//    synthetic shakes (3/8/16/30 px peak at 1.3–7.1 Hz on a static talking shot, 12 px on a walk-forward):
//    a 0.5 s window left the 30 px take at 0.27 (a visible 1.3 Hz sway on a kymograph) and the walk at 0.14,
//    0.75 s left 0.09 / 0.09, 1 s 0.04 / 0.08, and 1.5 s 0.04 / 0.07 at more zoom (1.11 / 1.14 vs 1.10 / 1.11).
//  - The zoom is capped (default 12 %): past that the correction itself is clamped (maxshift/maxangle, split
//    so the least correction is lost) and the frame edge stays out of view, steadying less. Real shake needs
//    little: the 30 px take (shake 1.38, 2.7 times the 手抖 limit) takes 10.3 % and the walk 10.5 %; held to
//    8 % they still came out at 0.09, held to 5 % at 0.29 / 0.12. What runs into a 20 % cap is subject motion
//    the camera path follows (kneading hands, a wok, a fitness class), where the zoom buys nothing.
//  - Only a clear improvement is kept: the shake must drop by at least 0.1 and to at most 60 % of what it was.
//    Otherwise (a take that is already steady, or whose 'shake' is people moving: on the dev set's clean clips
//    vidstab made kneading 0.13 → 0.24, croissants 0.50 → 0.71, a fitness class 0.35 → 0.43, each at ~12 %
//    zoom) the output is the span untouched, at zoom 1, reporting the shake before as the residual, so the
//    caller keeps the original. A take reading under 0.1 is not processed at all. Synthetic shakes of 3–30 px
//    came out at 0.03–0.08 (a drop of 80–97 %); the steady reference (0.056) now keeps its full frame instead
//    of a 4 % crop.
//  - The shake before and after is ingest's measure (vidstabdetect at 12 fps on a 640 px copy: the median local
//    motion per step, minus a ±0.5 s moving average, in % of the frame diagonal; ingest calls a shot 手抖 above
//    0.52). Without vidstab, deshake's own motion log stands in for vidstabdetect. Both measures run as side
//    branches of the passes that decode the clip anyway.
// Every ffmpeg run is asynchronous and killed after a time scaled to the clip's length and size.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicOutput } from '../core/ffmpeg.ts';

/** Options of {@link stabilize}. */
export interface StabilizeOptions {
  /** Start of the span to steady, in seconds of the input (default 0). */
  from?: number;
  /** Length of the span in seconds (default: to the end). */
  seconds?: number;
  /** vidstab smoothing: frames on each side of the Gaussian camera path window (default one second's worth,
   *  e.g. 24 at 24 fps, at least 10). Larger keeps less of the wobble but needs more zoom. */
  smoothing?: number;
  /** Zoom factor (1.1 = 10 % crop-in) the result may use: 'auto' (default) uses what the shake needs up to
   *  1.12; a number is a hard budget, and corrections are clamped to fit it. */
  zoom?: 'auto' | number;
  /** 'copy' (default) keeps the input's audio for the same span (stream-copied when the whole clip is taken,
   *  re-encoded to AAC when it is cut, so it stays in sync); 'drop' writes video only. */
  audio?: 'copy' | 'drop';
  /** 'deshake' forces the fallback even when vidstab is available (for tests and comparison). */
  method?: 'auto' | 'deshake';
}

/** Result of {@link stabilize}. */
export interface StabilizeResult {
  method: 'vidstab' | 'deshake';
  /** Zoom factor the output uses (1 = none, 1.12 = 12 % crop-in). */
  zoom: number;
  /** Shake left in the output, in ingest's units (% of the diagonal per 1/12 s; 手抖 above 0.52). */
  residual: number;
  /** The same measure on the input span, to compare with. */
  before: number;
  /** vidstab smoothing used (0 in tripod mode and for deshake). */
  smoothing: number;
  /** Whether the take was locked off (vidstab tripod mode). */
  tripod: boolean;
  /** Whether the correction had to be clamped to stay within the zoom budget (steadied less than asked). */
  limited: boolean;
}

/** Shake limit ingest uses for 手抖 (src/media/ingest.ts QUALITY_LIMITS.shake, recalibrated on the dev set: its 8 px
 *  shake reads 0.36 and is not flagged, the 12 px walk 0.57 is; the worst clean clip 0.47), for callers judging
 *  the residual. Kept as a number here rather than imported, so this module does not load ingest's. Keep the two
 *  equal. Stabilising does not depend on it: a result is kept on its own improvement (MIN_GAIN, KEEP_RATIO). */
export const SHAKE_LIMIT = 0.52;
/** Detection copy's long edge. */
const DETECT_LONG = 960;
/** Measure copy: ingest's frame rate and size. */
const MEASURE_FPS = 12;
const MEASURE_LONG = 640;
/** Largest zoom 'auto' may use. */
const AUTO_ZOOM_CAP = 1.12;
/** A result is kept only when the shake drops by at least MIN_GAIN and to at most KEEP_RATIO of the input's;
 *  an input under MIN_GAIN is passed through untouched. */
const MIN_GAIN = 0.1;
const KEEP_RATIO = 0.6;
/** Default smoothing window, seconds on each side (turned into frames at the clip's rate). */
const SMOOTH_SECONDS = 1;
/** A take is held still (tripod mode) when that needs at most this much more zoom (percent) than following
 *  a smoothed path: then it barely travels. */
const TRIPOD_EXTRA_PCT = 3;
/** Added to the computed zoom, in percent. */
const MARGIN_PCT = 1;

/** An input that may only be read from the local disk or a pipe. */
const safeIn = (file: string) => ['-protocol_whitelist', 'file,pipe', '-i', file];
/** Escapes a path for use as a filter option value inside single quotes. */
const filterPath = (p: string) => `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** Size with the long edge at most `long`, aspect kept, even sides. */
function fit(w: number, h: number, long: number) {
  const k = Math.min(1, long / Math.max(w, h));
  return { w: even(w * k), h: even(h * k) };
}

/**
 * Runs a command without blocking the server, killing it after `timeoutMs`; resolves with its log (stderr),
 * rejects when it fails or times out. `cwd` is where it runs (vidstab's debug output lands there).
 */
function run(cmd: string, args: string[], timeoutMs: number, cwd?: string, onStdout?: (b: Buffer) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', onStdout ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    if (onStdout) p.stdout!.on('data', onStdout);
    p.stderr!.on('data', (d) => {
      err += d;
      if (err.length > 8 << 20) err = err.slice(-(4 << 20));
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`防抖处理超时（${cmd} 超过 ${Math.round(timeoutMs / 1000)} 秒未完成）`));
      else if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`));
      else resolve(err);
    });
  });
}
const ff = (args: string[], timeoutMs: number, cwd?: string, onStdout?: (b: Buffer) => void) =>
  run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], timeoutMs, cwd, onStdout);

let vidstabAnswer: Promise<boolean> | null = null;

/** Whether this ffmpeg has vidstabdetect and vidstabtransform (asked once, then cached). */
export function hasVidstab(): Promise<boolean> {
  vidstabAnswer ??= new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 10_000);
    const has = (name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(out);
    p.on('error', () => { clearTimeout(timer); resolve(false); });
    p.on('close', () => { clearTimeout(timer); resolve(has('vidstabdetect') && has('vidstabtransform')); });
  });
  return vidstabAnswer;
}

interface Probe { w: number; h: number; fps: number; duration: number; audio: string | null }

/** Picture size as decoded (rotation applied), frame rate, duration and audio codec of a file. */
async function probe(file: string): Promise<Probe> {
  let out = '';
  await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:format=duration',
    '-of', 'json', '-i', file], 30_000, undefined, (d) => { out += d; });
  const j = JSON.parse(out || '{}') as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; side_data_list?: Array<{ rotation?: number }> }>;
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('防抖失败：文件里没有可用的视频画面');
  const rate = (r?: string) => {
    const [a, b] = (r ?? '').split('/').map(Number);
    return a && b ? a / b : 0;
  };
  const turned = Math.abs(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
  return {
    w: turned ? v.height : v.width,
    h: turned ? v.width : v.height,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30,
    duration: Number(j.format?.duration) || 0,
    audio: j.streams?.find((s) => s.codec_type === 'audio')?.codec_name ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Shake measure (ingest's)

type Step = { dx: number; dy: number };

/** vidstabdetect's text: per frame its local motion vectors "(LM dx dy x y size contrast match)"; each step's
 *  camera motion is their median, in fractions of `diag`. */
function trfSteps(text: string, diag: number): Step[] {
  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[s.length >> 1]! : 0;
  };
  const out: Step[] = [];
  for (const line of text.split('\n')) {
    const m = /^Frame \d+ \(List \d+ \[(.*)\]\)/.exec(line);
    if (!m) continue;
    const lms = [...m[1]!.matchAll(/\(LM (-?\d+) (-?\d+) /g)];
    out.push({ dx: median(lms.map((x) => Number(x[1]))) / diag, dy: median(lms.map((x) => Number(x[2]))) / diag });
  }
  return out;
}

/** deshake's motion log: a header, then per frame "Ori x, Avg x, Fin x, Ori y, ..." (the first two rows are
 *  zero, before it has a reference frame). */
function deshakeSteps(text: string, diag: number): Step[] {
  return text.split('\n').slice(1).filter((l) => /\d/.test(l)).map((l) => {
    const c = l.split(',').map(Number);
    return { dx: (c[0] ?? 0) / diag, dy: (c[3] ?? 0) / diag };
  });
}

/** Mean wobble (% of the diagonal per step) after steady movement (±0.5 s moving average) is removed; the
 *  first `skip` steps carry no motion and are left out. */
function wobble(steps: Step[], skip: number): number {
  const half = Math.round(MEASURE_FPS / 2);
  let sum = 0, n = 0;
  for (let i = skip; i < steps.length; i++) {
    let sx = 0, sy = 0, k = 0;
    for (let j = Math.max(skip, i - half); j <= Math.min(steps.length - 1, i + half); j++, k++) {
      sx += steps[j]!.dx;
      sy += steps[j]!.dy;
    }
    sum += Math.hypot(steps[i]!.dx - sx / k, steps[i]!.dy - sy / k) * 100;
    n++;
  }
  return n ? Math.round((sum / n) * 1000) / 1000 : 0;
}

interface Measure { filter: string; read: () => Promise<number> }

/** A filter chain that measures shake on its input, and how to read the result. */
function measureBranch(w: number, h: number, file: string, kind: 'vidstab' | 'deshake'): Measure {
  const m = fit(w, h, MEASURE_LONG);
  const diag = Math.hypot(m.w, m.h);
  const base = `fps=${MEASURE_FPS},scale=${m.w}:${m.h}`;
  if (kind === 'vidstab') {
    return {
      filter: `${base},vidstabdetect=shakiness=8:accuracy=9:result=${filterPath(file)}`,
      read: async () => wobble(trfSteps(await readFile(file, 'utf8'), diag), 1),
    };
  }
  // Search range, block size and contrast chosen to follow the vidstab measure: on the dev set it reads the
  // synthetic 3/8/16/30 px shakes 0.14/0.28/0.56/1.07 against vidstab's 0.16/0.36/0.73/1.38 (it under-reads
  // strong shake by about a quarter) and clean clips 0.00–0.38 against 0.04–0.50.
  return {
    filter: `${base},deshake=rx=32:ry=32:blocksize=16:contrast=20:filename=${filterPath(file)}`,
    read: async () => wobble(deshakeSteps(await readFile(file, 'utf8'), diag), 2),
  };
}

/** Kill timeout for a pass over `seconds` of `w`x`h` footage: generous for a small CPU server. */
const passTimeout = (seconds: number, w: number, h: number) => 60_000 + seconds * 10_000 * Math.max(1, (w * h) / 2_073_600);

/** Input arguments for the span [from, from + seconds). */
const spanIn = (file: string, from: number, seconds: number | undefined) =>
  [...(from > 0 ? ['-ss', from.toFixed(3)] : []), ...(seconds ? ['-t', seconds.toFixed(3)] : []), ...safeIn(file)];

/**
 * Shake of a clip (or of `seconds` from `from`) in ingest's units: % of the frame diagonal per 1/12 s, after
 * steady movement is taken out; ingest flags 手抖 above {@link SHAKE_LIMIT}. Uses vidstabdetect when available,
 * deshake's motion log otherwise (or when `kind` says so).
 */
export async function measureShake(file: string, opts?: { from?: number; seconds?: number; kind?: 'vidstab' | 'deshake' }): Promise<number> {
  const info = await probe(file);
  const kind = opts?.kind ?? ((await hasVidstab()) ? 'vidstab' : 'deshake');
  const dir = await mkdtemp(join(tmpdir(), 'shake-'));
  try {
    const span = Math.max(0, Math.min(opts?.seconds ?? Infinity, info.duration - (opts?.from ?? 0)));
    const m = measureBranch(info.w, info.h, join(dir, 'm.log'), kind);
    await ff([...spanIn(file, opts?.from ?? 0, opts?.seconds), '-vf', m.filter, '-f', 'null', '-'],
      passTimeout(span, MEASURE_LONG, MEASURE_LONG), dir);
    return await m.read();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Camera path and zoom

interface Tf { x: number; y: number; a: number; z: number }

/** Rewrites a motion file found on a copy scaled by 1/fx, 1/fy so it fits the full-size frames. */
function scaleTrf(text: string, fx: number, fy: number): string {
  const r = Math.round;
  return text.replace(/\(LM (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\d+) ([^ ]+) ([^)]+)\)/g, (_m, dx, dy, x, y, size, c, q) =>
    `(LM ${r(dx * fx)} ${r(dy * fy)} ${r(x * fx)} ${r(y * fy)} ${r(size * Math.max(fx, fy))} ${c} ${q})`);
}

/** vidstab's global transforms as its debug run writes them ("frame x y alpha zoom extra" per line). */
function parseGlobal(text: string): Tf[] {
  const out: Tf[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const c = line.trim().split(/\s+/).map(Number);
    if (c.length >= 5 && c.every(Number.isFinite)) out.push({ x: c[1]!, y: c[2]!, a: c[3]!, z: c[4]! });
  }
  return out;
}

/** The corrections vidstab applies in relative mode: its Gaussian-smoothed camera path minus the path. */
function gaussCorrections(rel: Tf[], mu: number): Tf[] {
  const path: Tf[] = [];
  rel.forEach((t, i) => {
    const p = path[i - 1] ?? { x: 0, y: 0, a: 0, z: 0 };
    path.push({ x: p.x + t.x, y: p.y + t.y, a: p.a + t.a, z: p.z + t.z });
  });
  // vidstab's kernel: exp(-(k - mu)^2 / (mu/2)^2) over 2 mu + 1 frames, renormalised at the clip's ends.
  const sigma2 = Math.max(1, Math.floor(mu / 2) ** 2);
  const kernel = Array.from({ length: 2 * mu + 1 }, (_, k) => Math.exp(-((k - mu) ** 2) / sigma2));
  return path.map((p, i) => {
    let wsum = 0;
    const s = { x: 0, y: 0, a: 0, z: 0 };
    kernel.forEach((wk, k) => {
      const q = path[i + k - mu];
      if (!q) return;
      wsum += wk;
      s.x += wk * q.x; s.y += wk * q.y; s.a += wk * q.a; s.z += wk * q.z;
    });
    return { x: s.x / wsum - p.x, y: s.y / wsum - p.y, a: s.a / wsum - p.a, z: s.z / wsum - p.z };
  });
}

// vidstab's zoom Z (percent) samples the source at scale 1 - Z/100 about the centre (zoom=20 enlarges by 1.25).
// A frame moved by (x, y) and turned by a shows no edge when (1 - Z/100) * (corner turned by a) + |shift| stays
// inside the frame on both axes. vidstab also smooths a per-frame zoom it estimates; those corrections are
// small (under 3 % on the walk-in, where walking forward makes them largest) and left to the 1 % margin:
// counting them in full cost a third of the shift room there, and leaving them out showed no uncovered pixel.

/** Zoom percent (vidstab's Z) each frame moved by `corr` needs so that a w x h frame shows no edge. */
function zoomNeeds(corr: Tf[], w: number, h: number): number[] {
  const hw = w / 2, hh = h / 2;
  return corr.map((c) => {
    const a = Math.abs(c.a), cos = Math.cos(a), sin = Math.sin(a);
    const scale = Math.min((hw - Math.abs(c.x)) / (hw * cos + hh * sin), (hh - Math.abs(c.y)) / (hw * sin + hh * cos));
    return Math.max(0, 100 * (1 - scale));
  });
}
/** vidstab zoom percent as a magnification factor, and back. */
const factorOf = (pct: number) => 1 / (1 - pct / 100);
const pctOf = (factor: number) => 100 * (1 - 1 / factor);

/**
 * Shift (px) and angle (rad) limits that keep the edge out of view at zoom `pct`. vidstab takes one shift
 * limit for both axes; the angle limit is chosen among the quantiles of the frames' turns so that the
 * correction left undone (pixels of shift beyond the limit plus the turn beyond it at the frame's far edge,
 * summed over frames) is smallest.
 */
function clampFor(corr: Tf[], w: number, h: number, pct: number) {
  const hw = w / 2, hh = h / 2;
  const scale = 1 - pct / 100;
  const turns = corr.map((c) => Math.abs(c.a)).sort((x, y) => x - y);
  let best = { shift: 0, angle: 0, left: Infinity };
  for (const q of [0, 0.5, 0.75, 0.9, 0.95, 0.98, 1]) {
    const angle = q ? turns[Math.min(turns.length - 1, Math.floor(q * turns.length))] ?? 0 : 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const shift = Math.floor(Math.min(hw - scale * (hw * cos + hh * sin), hh - scale * (hw * sin + hh * cos)));
    if (shift < 0) continue;
    const left = corr.reduce((sum, c) => sum + Math.max(0, Math.abs(c.x) - shift) + Math.max(0, Math.abs(c.y) - shift)
      + Math.max(0, Math.abs(c.a) - angle) * Math.max(hw, hh), 0);
    if (left < best.left) best = { shift, angle: Math.floor(angle * 1e4) / 1e4, left };
  }
  return { shift: best.shift, angle: best.angle };
}

// ---------------------------------------------------------------------------------------------------------
// Stabilisation

/** Output encoding: H.264 yuv420p, frame timing kept, audio per `audio`. */
function encodeArgs(info: Probe, audio: 'copy' | 'drop', cut: boolean, out: string): string[] {
  const a = audio === 'drop' || !info.audio ? ['-an']
    : !cut && ['aac', 'mp3', 'alac', 'ac3', 'opus'].includes(info.audio) ? ['-map', '0:a:0', '-c:a', 'copy']
      : ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'];
  return ['-map', '[v]', ...a, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'passthrough', '-movflags', '+faststart', '-map_metadata', '-1', '-f', 'mp4', out];
}

/**
 * Steadies `input` (or `seconds` of it from `from`) into `output`: two-pass vidstab (a smoothed camera path,
 * or a locked-off frame when the take barely travels) with just enough zoom that no frame edge shows, or
 * ffmpeg's deshake with a fixed crop-in when vidstab is missing (or `method: 'deshake'`). The output is H.264
 * yuv420p at the input's size and frame rate, frame for frame as long as the span; audio is kept or dropped
 * per `audio` (see {@link StabilizeOptions}). Reports the zoom used and the shake before and after in
 * ingest's units, so the caller can tell whether it helped (a residual under {@link SHAKE_LIMIT} reads as
 * steady). When steadying would not clearly help (the shake would not drop by at least 0.1 and to at most
 * 60 %, or the input already reads under 0.1), `output` is the span untouched (zoom 1) and `residual` equals
 * `before`: the original is the better cut. `output` appears only on success; temporary motion files live
 * next to it and are removed. Relative paths are taken from the current directory.
 */
export async function stabilize(input: string, outputPath: string, opts?: StabilizeOptions): Promise<StabilizeResult> {
  // ffmpeg runs inside the temporary folder (vidstab writes its debug files there), so paths are made absolute.
  input = resolve(input);
  const output = resolve(outputPath);
  const info = await probe(input);
  const from = Math.max(0, opts?.from ?? 0);
  const span = Math.max(0, Math.min(opts?.seconds ?? Infinity, info.duration - from));
  if (!(span > 0)) throw new Error('防抖失败：所选片段长度为 0');
  const cut = from > 0 || opts?.seconds !== undefined;
  const seconds = opts?.seconds !== undefined ? span : undefined;
  const budget = opts?.zoom === undefined || opts.zoom === 'auto' ? AUTO_ZOOM_CAP : Math.max(1, opts.zoom);
  const audio = opts?.audio ?? 'copy';
  const vidstab = await hasVidstab();
  const timeout = passTimeout(span, info.w, info.h);
  const dir = await mkdtemp(join(dirname(output), '.stab-'));
  try {
    const inArgs = spanIn(input, from, seconds);
    const kind = vidstab ? 'vidstab' : 'deshake';
    /** Kept when the shake clearly dropped (see MIN_GAIN, KEEP_RATIO). */
    const helped = (before: number, residual: number) => before - residual >= MIN_GAIN && residual <= KEEP_RATIO * before;
    /** The span untouched (same encoding), for a take steadying would not help. */
    const untouched = async (method: StabilizeResult['method'], before: number): Promise<StabilizeResult> => {
      await atomicOutput(output, async (tmp) => {
        await ff([...inArgs, '-filter_complex', '[0:v]format=yuv420p,setsar=1[v]', ...encodeArgs(info, audio, cut, tmp)], timeout * 2, dir);
      });
      return { method, zoom: 1, residual: before, before, smoothing: 0, tripod: false, limited: false };
    };
    if (!vidstab || opts?.method === 'deshake') {
      // deshake searches each frame's motion within rx/ry pixels (a multiple of 16) and moves the frame back,
      // mirroring the edge it uncovers; a fixed crop-in by that range hides the band. contrast=60 lets it use
      // more blocks than its default 125 (a jittered texture: shake 0.96 → 0.10 with 60, 0.77 with 125);
      // wider ranges found more false matches. On the dev set's shakes (9.8 % crop-in at 720x1280): 3/8/16/30 px
      // 0.16/0.36/0.73/1.38 → 0.07/0.15/0.27/0.50 and the walk 0.58 → 0.26 (vidstab: 0.03–0.08); the steady
      // reference got nothing from it and is passed through.
      const r = Math.min(info.w, info.h) >= 480 ? 32 : 16;
      const full = Math.max(info.w / (info.w - 2 * r), info.h / (info.h - 2 * r));
      const zoom = Math.min(budget, full);
      const before = measureBranch(info.w, info.h, join(dir, 'before.log'), kind);
      const after = measureBranch(info.w, info.h, join(dir, 'after.log'), kind);
      const graph = [
        `[0:v]format=yuv420p,split=2[src][mb]`, `[mb]${before.filter},nullsink`,
        `[src]deshake=rx=${r}:ry=${r}:contrast=60:edge=mirror,crop=${even(info.w / zoom)}:${even(info.h / zoom)},scale=${info.w}:${info.h}:flags=bicubic,setsar=1,split=2[v][ma]`,
        `[ma]${after.filter},nullsink`,
      ];
      await atomicOutput(output, async (tmp) => { await ff([...inArgs, '-filter_complex', graph.join(';'), ...encodeArgs(info, audio, cut, tmp)], timeout * 2, dir); });
      // Under a tighter budget than the band, mirrored edges can show on the biggest jolts.
      const [b, left] = [await before.read(), await after.read()];
      if (!helped(b, left)) return await untouched('deshake', b);
      return { method: 'deshake', zoom: round(zoom), residual: left, before: b, smoothing: 0, tripod: false, limited: zoom < full };
    }

    // Pass 1: motion on the detection copy, and the shake measure on the input.
    const d = fit(info.w, info.h, DETECT_LONG);
    const scaleDown = d.w !== info.w || d.h !== info.h ? `scale=${d.w}:${d.h},` : '';
    const detect = (tripod: boolean, out: string) =>
      `${scaleDown}vidstabdetect=shakiness=8:accuracy=12${tripod ? ':tripod=1' : ''}:result=${filterPath(out)}`;
    const before = measureBranch(info.w, info.h, join(dir, 'before.trf'), 'vidstab');
    await ff([...inArgs, '-filter_complex',
      `[0:v]format=yuv420p,split=2[a][mb];[a]${detect(false, join(dir, 'raw-rel.trf'))}[o];[mb]${before.filter},nullsink`,
      '-map', '[o]', '-f', 'null', '-'], timeout, dir);
    const shakeBefore = await before.read();
    if (shakeBefore < MIN_GAIN) return await untouched('vidstab', shakeBefore);
    const motions = async (name: string) => {
      const trf = join(dir, `${name}.trf`);
      const text = await readFile(join(dir, `raw-${name}.trf`), 'utf8');
      await writeFile(trf, scaleTrf(text, info.w / d.w, info.h / d.h));
      // A debug run on a blank picture of the same size writes vidstab's global motions to its working dir.
      const gdir = await mkdtemp(join(dir, 'g-'));
      await ff(['-f', 'lavfi', '-i', `color=c=gray:s=${info.w}x${info.h}:r=1:d=1`, '-vf',
        `format=yuv420p,vidstabtransform=input=${filterPath(trf)}:debug=1`, '-frames:v', '1', '-f', 'null', '-'], 30_000, gdir);
      return { trf, global: parseGlobal(await readFile(join(gdir, 'global_motions.trf'), 'utf8')) };
    };
    const rel = await motions('rel');
    const smoothing = Math.round(Math.min(60, Math.max(1, opts?.smoothing ?? Math.max(10, info.fps * SMOOTH_SECONDS))));
    const budgetPct = pctOf(budget);
    const worst = (corr: Tf[]) => Math.max(0, ...zoomNeeds(corr, info.w, info.h));

    // Locked off when the take barely travels: vidstab's tripod mode aligns every frame with the first.
    const smooth = gaussCorrections(rel.global, smoothing);
    const lockLimit = Math.min(budgetPct, worst(smooth) + TRIPOD_EXTRA_PCT);
    let plan: { trf: string; tripod: boolean; corr: Tf[] } | null = null;
    const path: Tf[] = [];
    rel.global.forEach((t, i) => {
      const p = path[i - 1] ?? { x: 0, y: 0, a: 0, z: 0 };
      path.push({ x: p.x + t.x, y: p.y + t.y, a: p.a + t.a, z: p.z + t.z });
    });
    if (worst(path) <= lockLimit) {
      await ff([...inArgs, '-vf', `format=yuv420p,${detect(true, join(dir, 'raw-tri.trf'))}`, '-f', 'null', '-'], timeout, dir);
      const tri = await motions('tri');
      // Measured against the first frame directly, the lock-off can come out costlier than the summed steps said.
      if (worst(tri.global) <= Math.min(budgetPct, lockLimit + 1)) plan = { trf: tri.trf, tripod: true, corr: tri.global };
    }
    // Otherwise the wobble around a smoothed path is taken out; past the zoom budget the correction is clamped.
    plan ??= { trf: rel.trf, tripod: false, corr: smooth };
    const need = worst(plan.corr) + MARGIN_PCT;
    const limited = need > budgetPct;
    const pct = Math.min(budgetPct, need);
    const clamp = limited ? clampFor(plan.corr, info.w, info.h, pct) : null;
    const transform = [
      `vidstabtransform=input=${filterPath(plan.trf)}`,
      plan.tripod ? 'tripod=1' : `smoothing=${smoothing}:optalgo=gauss`,
      `optzoom=0:zoom=${pct.toFixed(2)}:crop=keep:interpol=bicubic`,
      ...(clamp ? [`maxshift=${clamp.shift}:maxangle=${clamp.angle}`] : []),
    ].join(':');

    // Pass 2: transform (a light unsharp makes up for the resampling) and measure the result.
    const after = measureBranch(info.w, info.h, join(dir, 'after.trf'), 'vidstab');
    await atomicOutput(output, async (tmp) => {
      await ff([...inArgs, '-filter_complex',
        `[0:v]format=yuv420p,${transform},unsharp=5:5:0.6:3:3:0.3,setsar=1,split=2[v][ma];[ma]${after.filter},nullsink`,
        ...encodeArgs(info, audio, cut, tmp)], timeout * 2, dir);
    });
    const residual = await after.read();
    if (!helped(shakeBefore, residual)) return await untouched('vidstab', shakeBefore);
    return {
      method: 'vidstab', zoom: round(factorOf(pct)), residual, before: shakeBefore,
      smoothing: plan.tripod ? 0 : smoothing, tripod: plan.tripod, limited,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
