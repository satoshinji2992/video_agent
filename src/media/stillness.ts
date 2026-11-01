// Measures how much of a rendered shot is a frozen picture, so the agent can be told to keep elements in
// gentle motion when a code-animation shot settles into a still card after its entrance.
//
// One async ffmpeg pass decodes a small grey copy (fits in 320x320, 10 fps) and Node compares each frame with
// the frame where the current still stretch began, like ffmpeg's freezedetect. freezedetect itself is not
// used because it looks at the mean difference over the whole frame: a small floating dot or a ticking
// counter barely moves the mean and would read as frozen. Here a frame counts as changed when either a few
// pixels change strongly (a dot, digits, a moving edge) or many pixels change faintly (a fade, a glow, a slow
// push). Comparing against the start of the stretch, not the previous frame, lets slow drift (Ken Burns,
// parallax) add up until it crosses the threshold, and lets the last, barely visible part of an entrance's
// ease-out count as part of the hold that follows it.
//
// Soft continuous motion (a blurred glow drifting 10–20 px/s, a pulsing text glow, twinkling stars) creeps up
// to the threshold too, and the stretch it ends is not a held picture. So a stretch counts as a whole only
// when the picture is settled over its last 0.5 s (the hold ended with a sudden change or with the clip); when
// it is still drifting there, only the parts that match their own first frame within a tight tolerance count
// (a held card before the next one starts fading in). Pauses that recur at an even rhythm, at the turning
// points of a breathing glow or between the ticks of a counter, are part of the motion too.
//
// Calibrated on ~370 rendered code shots (data/sessions/*/clips): x264 re-encodes of a static card flicker by
// up to ~22 grey levels on ~12 pixels every few frames (B-frame quantisation), which would read as motion.
// Averaging 4 source frames (tmix) before sampling removes that flicker (static tails then differ by <=3
// levels on a handful of pixels) while real motion, which persists across frames, survives. Over its last
// 0.5 s a held stretch changes by more than 2 levels on at most ~15 pixels; a 10 px/s glow on 45 or more. A
// gradient scaled so slowly that it moves by 1 grey level (invisible) stays still.
import { spawn } from 'node:child_process';

/** Analysis frame: the clip is scaled to fit this square (aspect kept, padded with black) in grey. */
const BOX = 320;
const FPS = 10;
/** A pixel "changes strongly" above this many grey levels; STRONG_PIXELS such pixels make a frame move. */
const STRONG_DIFF = 10;
const STRONG_PIXELS = 3;
/** A pixel "changes faintly" above `diff` grey levels; `pixels` such pixels make a frame move. */
interface Faint {
  diff: number;
  pixels: number;
}
/** Breaks a still stretch. */
const LOOSE: Faint = { diff: 3, pixels: 300 };
/** Whether the picture is still drifting at the end of a stretch. */
const DRIFT: Faint = { diff: 2, pixels: 20 };
/** Splits a stretch that ends drifting into held parts. */
const PART: Faint = { diff: 2, pixels: 30 };
/** How far back from the end of a stretch the settled check looks, in frames (0.5 s). */
const END_LAG = 5;
/** A still stretch must last this long to count (freezedetect's d). */
const MIN_RUN_S = 0.5;
/** At least this many stretches recurring at most RHYTHM_MAX_S apart are the pauses of a periodic motion. */
const RHYTHM_PAUSES = 3;
const RHYTHM_MAX_S = 1.5;
/** They recur "evenly" when the gaps between their midpoints differ by at most this many frames. */
const RHYTHM_JITTER = 1;
/** Only this much of the clip (after skipStart) is analysed. */
const MAX_SECONDS = 120;
const TIMEOUT_MS = 60_000;

/** Result of {@link stillness}. */
export interface Stillness {
  /** Fraction (0–1) of the analysed span during which the picture is effectively frozen. */
  stillShare: number;
  /** Longest frozen stretch, in seconds. */
  longestStill: number;
}

/** Whether `frame` differs visibly from `ref` (both BOX*BOX grey bytes). */
function differs(ref: Uint8Array, frame: Uint8Array, faint: Faint): boolean {
  let strong = 0;
  let changed = 0;
  for (let i = 0; i < frame.length; i++) {
    const d = frame[i] > ref[i] ? frame[i] - ref[i] : ref[i] - frame[i];
    if (d > faint.diff) {
      if (++changed >= faint.pixels) return true;
      if (d > STRONG_DIFF && ++strong >= STRONG_PIXELS) return true;
    }
  }
  return false;
}

/**
 * Drops the stretches that recur at an even rhythm: at least RHYTHM_PAUSES stretches whose midpoints are no
 * more than RHYTHM_MAX_S apart and evenly spaced. These are the pauses of a periodic motion (a counter ticking,
 * a glow breathing, an element bobbing with ease-in-out), which reads as continuous motion, not as a hold.
 */
function dropRhythm(runs: [number, number][]): [number, number][] {
  const keep = runs.map(() => true);
  const mid = (m: number) => (runs[m][0] + runs[m][1]) / 2;
  for (let i = 0; i < runs.length; ) {
    let k = i;
    while (k + 1 < runs.length) {
      const step = mid(k + 1) - mid(k);
      if (step > RHYTHM_MAX_S * FPS || (k > i && Math.abs(step - (mid(k) - mid(k - 1))) > RHYTHM_JITTER)) break;
      k++;
    }
    if (k - i + 1 >= RHYTHM_PAUSES) {
      for (let m = i; m <= k; m++) keep[m] = false;
      i = k + 1;
    } else i = Math.max(i + 1, k);
  }
  return runs.filter((_, m) => keep[m]);
}

/**
 * Measures how much of a clip is a frozen picture: `stillShare` is the fraction of the clip after `skipStart`
 * seconds (default 0.6, the entrance animation) covered by stretches of at least 0.5 s with no visible change,
 * and `longestStill` the longest such stretch in seconds. A slow Ken Burns push, a gently floating element, a
 * softly drifting or breathing glow, a counter ticking at least once every 1.5 s or subtle parallax count as
 * moving; a title card that holds after its entrance counts as still. Anything that changes less often, or
 * unevenly (items revealed one by one with pauses), is still between changes. A clip no longer than
 * `skipStart` yields zeros. Rejects if ffmpeg fails or runs over 60 s.
 */
export async function stillness(file: string, opts?: { skipStart?: number }): Promise<Stillness> {
  const skip = Math.max(0, opts?.skipStart ?? 0.6);
  const size = BOX * BOX;
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...(skip > 0 ? ['-ss', String(skip)] : []),
    '-protocol_whitelist', 'file,pipe', '-i', file,
    '-t', String(MAX_SECONDS), '-an', '-sn', '-dn',
    '-vf', [
      `scale=${BOX}:${BOX}:force_original_aspect_ratio=decrease:flags=area`,
      'format=gray',
      'tmix=frames=4',
      `fps=${FPS}`,
      `pad=${BOX}:${BOX}:(ow-iw)/2:(oh-ih)/2`,
    ].join(','),
    '-f', 'rawvideo', 'pipe:1',
  ];

  let frames = 0;
  /** Still stretches as [first, last] frame. */
  const runs: [number, number][] = [];
  // The current stretch (LOOSE against `ref`) and, inside it, the current held part (PART against `anchor`).
  let ref: Uint8Array | null = null;
  let runStart = 0;
  let anchor: Uint8Array | null = null;
  let partStart = 0;
  let parts: [number, number][] = [];
  // The last END_LAG + 1 frames, for the settled check when a stretch closes.
  const recent: Uint8Array[] = [];
  const long = (first: number, last: number) => (last - first) / FPS >= MIN_RUN_S;
  const closePart = (last: number) => {
    if (long(partStart, last)) parts.push([partStart, last]);
  };
  const closeRun = (last: number) => {
    if (!long(runStart, last)) return;
    const end = recent[last % recent.length];
    const before = recent[Math.max(runStart, last - END_LAG) % recent.length];
    if (!differs(before, end, DRIFT)) runs.push([runStart, last]);
    else {
      closePart(last);
      runs.push(...parts);
    }
  };
  const onFrame = (frame: Uint8Array) => {
    if (!ref || !anchor) ref = anchor = frame;
    else if (differs(ref, frame, LOOSE)) {
      closeRun(frames - 1);
      ref = anchor = frame;
      runStart = partStart = frames;
      parts = [];
    } else if (differs(anchor, frame, PART)) {
      closePart(frames - 1);
      anchor = frame;
      partStart = frames;
    }
    if (recent.length < END_LAG + 1) recent.push(frame);
    else recent[frames % recent.length] = frame;
    frames++;
  };

  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending: Buffer = Buffer.alloc(0);
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, TIMEOUT_MS);
    p.stdout.on('data', (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      let off = 0;
      // Copy each frame out: reference frames outlive the chunk they arrived in.
      for (; off + size <= pending.length; off += size) onFrame(new Uint8Array(pending.subarray(off, off + size)));
      pending = pending.subarray(off);
    });
    p.stderr.on('data', (d) => {
      if (err.length < 4000) err += d;
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`静止检测超时（ffmpeg 超过 ${TIMEOUT_MS / 1000} 秒未完成）`));
      else if (code !== 0) reject(new Error(`静止检测失败：ffmpeg exited ${code}: ${err.slice(-600)}`));
      else resolve();
    });
  });

  if (frames === 0) return { stillShare: 0, longestStill: 0 };
  closeRun(frames - 1);
  let still = 0;
  let longest = 0;
  for (const [first, last] of dropRhythm(runs)) {
    still += last - first + 1;
    longest = Math.max(longest, last - first + 1);
  }
  return {
    stillShare: Math.round((still / frames) * 100) / 100,
    longestStill: Math.round((longest / FPS) * 10) / 10,
  };
}

/** Whole-picture change: below this mean luma difference from the previous frame (0-255) a frame is static. */
const STATIC_MEAN = 0.5;
/** Static frames count only in runs at least this long. */
const STATIC_RUN_S = 1;

export interface PictureChange {
  /** Share (0–1) of the clip's length that sits in static runs. */
  frozenShare: number;
  /** The static runs as [start, end] in seconds. */
  runs: Array<[number, number]>;
}

function probeVideo(file: string): Promise<{ w: number; h: number; fps: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const s = JSON.parse(out).streams[0];
        const [a, b] = String(s.r_frame_rate).split('/').map(Number);
        resolve({ w: s.width, h: s.height, fps: a && b ? a / b : 24 });
      } catch {
        reject(new Error('静止检测失败：读不出视频信息'));
      }
    });
  });
}

/**
 * How much of a clip shows (almost) no change across the whole picture: every frame at the clip's own rate,
 * long side 160 px, a frame is static when its mean luma differs from the previous frame's by less than 0.5,
 * static frames count in runs of at least 1 s, black frames (mean below 18, 98th percentile below 40) are left
 * out. This is TimelineBench's mostly_frozen measure. Unlike stillness(), small thin things moving on a dark
 * background (a dotted orbit, a curve being drawn, twinkling stars) barely change the picture as a whole and
 * count as static here, which is how such a shot reads on a phone. Looks at the first 120 s.
 */
export async function pictureChange(file: string): Promise<PictureChange> {
  if (!file) throw new Error('pictureChange: missing file');
  const { w, h, fps: rate } = await probeVideo(file);
  const fps = rate > 0 && rate <= 60 ? rate : 30;
  const [sw, sh] = w >= h ? [160, Math.max(2, Math.round((h * 160) / w / 2) * 2)] : [Math.max(2, Math.round((w * 160) / h / 2) * 2), 160];
  const px = sw * sh;
  const size = px * 3;
  let prev: Float32Array | null = null;
  let frames = 0;
  let run = 0;
  const runs: Array<[number, number]> = [];
  const close = () => {
    if (run / fps >= STATIC_RUN_S) runs.push([(frames - run) / fps, frames / fps]);
    run = 0;
  };
  const hist = new Uint32Array(256);
  const onFrame = (rgb: Buffer) => {
    const luma = new Float32Array(px);
    let sum = 0;
    let diff = 0;
    hist.fill(0);
    for (let i = 0; i < px; i++) {
      const v = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
      luma[i] = v;
      sum += v;
      hist[Math.min(255, Math.floor(v))]!++;
      if (prev) diff += Math.abs(v - prev[i]!);
    }
    let seen = 0;
    let p98 = 255;
    for (let k = 0; k < 256; k++) if ((seen += hist[k]!) >= 0.98 * px) { p98 = k; break; }
    const black = sum / px < 18 && p98 < 40;
    // The first frame takes the second's verdict, as in the guard; approximated by counting it as static.
    const isStatic = !prev || diff / px < STATIC_MEAN;
    if (isStatic && !black) run++;
    else close();
    prev = luma;
    frames++;
  };
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-t', String(MAX_SECONDS),
      '-map', '0:v:0', '-vf', `${rate > 60 ? `fps=${fps},` : ''}scale=${sw}:${sh}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let pending: Buffer = Buffer.alloc(0);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.stdout.on('data', (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      let off = 0;
      for (; off + size <= pending.length; off += size) onFrame(pending.subarray(off, off + size));
      pending = pending.subarray(off);
    });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`静止检测超时（ffmpeg 超过 ${TIMEOUT_MS / 1000} 秒未完成）`));
      else if (code !== 0) reject(new Error(`静止检测失败：ffmpeg exited ${code}`));
      else resolve();
    });
  });
  close();
  const total = runs.reduce((a, [s, e]) => a + (e - s), 0);
  return { frozenShare: frames ? Math.round((total / (frames / fps)) * 100) / 100 : 0, runs: runs.map(([s, e]) => [Math.round(s * 10) / 10, Math.round(e * 10) / 10]) };
}
