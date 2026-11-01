// Checks src/media/compose.ts on synthetic footage: every export at 9:16 and 16:9, timing asserted from decoded pixels,
// and contact sheets written for a visual check of each effect.
// Each synthetic clip is a solid colour (which clip) with a grey reference bar and a white bar whose length is
// the clip's own time mod 4 s, so a decoded frame tells which clip it shows and how far into it, after any
// scaling or cropping.
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { joinClips, addOverlays, splitScreen, kenBurns, type FrameSpec, type KenBurnsMove, type Transition } from '../../src/media/compose.ts';
import { config, FRAME_SIZE } from '../../src/core/config.ts';
import { CJK_FONT_FILE, ffmpeg, hasAudio, normalizeClip, concatClips, probeDuration } from '../../src/core/ffmpeg.ts';

const DIR = process.env.COMPOSE_CHECK_DIR ?? join(tmpdir(), 'video-agent-compose-check');
const SRC = join(DIR, 'src');
const OUT = join(DIR, 'out');
const SHEETS = join(DIR, 'sheets');
await Promise.all([SRC, OUT, SHEETS].map((d) => mkdir(d, { recursive: true })));

const fps = config.fps;
const SIZES: Record<'9:16' | '16:9', FrameSpec> = {
  '9:16': { ...FRAME_SIZE['9:16'], fps },
  '16:9': { ...FRAME_SIZE['16:9'], fps },
};
const FONT = CJK_FONT_FILE ? `fontfile='${CJK_FONT_FILE}':` : '';
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const r = await fn();
  return [r, (performance.now() - t0) / 1000];
};

// ---------------------------------------------------------------------------------------------------------------
// Synthetic inputs

type RGB = [number, number, number];
const PALETTE: Record<string, RGB> = {
  red: [220, 40, 40], green: [40, 180, 60], blue: [40, 80, 220], yellow: [230, 200, 40],
  magenta: [200, 50, 200], cyan: [40, 200, 210], orange: [240, 130, 30], plum: [120, 40, 90],
};
const hex = (c: RGB) => c.map((v) => v.toString(16).padStart(2, '0')).join('');

interface Src { file: string; color: string; seconds: number }

async function makeClip(name: string, color: string, w: number, h: number, rate: number, seconds: number, audio = false): Promise<Src> {
  const file = join(SRC, `${name}.mp4`);
  const c = hex(PALETTE[color]!);
  const m = Math.min(w, h);
  const L = 2 * Math.round(m * 0.2);
  const bh = Math.max(6, Math.round(m * 0.03));
  const x0 = Math.round(w / 2 - L / 2);
  const yr = Math.round(h / 2 + m * 0.12);
  const yt = yr + bh + 4;
  const graph = [
    `color=c=0x${c}:s=${w}x${h}:r=${rate}:d=${seconds}[bg]`,
    `color=c=white:s=${L}x${bh}:r=${rate}[bar]`,
    `[bg]drawbox=x=${x0}:y=${yr}:w=${L}:h=${bh}:c=0x808080:t=fill[g]`,
    `[g][bar]overlay=x='${x0}-${L}+${L}*mod(t,4)/4':y=${yt}:shortest=1[o]`,
    `[o]drawbox=x=${x0 - L}:y=${yt}:w=${L}:h=${bh}:c=0x${c}:t=fill,` +
      `drawtext=${FONT}text='${name}':fontsize=${Math.round(m * 0.2)}:fontcolor=black:x=(w-tw)/2:y=h/2-${Math.round(m * 0.3)},` +
      `drawtext=${FONT}text='f%{eif\\:t*24\\:d}':fontsize=${Math.round(m * 0.1)}:fontcolor=black:x=(w-tw)/2:y=h/2-${Math.round(m * 0.06)}[v]`,
  ];
  const aud = audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : [];
  await ffmpeg([
    ...aud, '-filter_complex', graph.join(';'), '-map', '[v]', ...(audio ? ['-map', '0:a', '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', file,
  ]);
  return { file, color, seconds };
}

/** A grid picture with a red marker square, used for the Ken Burns motion tracking and the image PiP. */
async function makeImage(name: string, w: number, h: number, marker: [number, number]) {
  const file = join(SRC, `${name}.png`);
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=0x2a4d69:s=${w}x${h}:d=1`,
    '-vf', [
      `drawgrid=w=80:h=80:t=3:c=0xe0e0e0@0.6`,
      `drawbox=x=0:y=0:w=${w}:h=${h}:c=0xf2c14e:t=12`,
      `drawtext=${FONT}text='${name}':fontsize=${Math.round(Math.min(w, h) * 0.08)}:fontcolor=white:x=(w-tw)/2:y=h*0.3`,
      `drawbox=x=${marker[0] - 15}:y=${marker[1] - 15}:w=30:h=30:c=0xff0000:t=fill`,
    ].join(','),
    '-frames:v', '1', '-update', '1', file,
  ]);
  return file;
}

// ---------------------------------------------------------------------------------------------------------------
// Pixel reading

function frameCount(file: string) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim());
}

/** Decodes the given frame numbers (any order) as RGB buffers, keyed by frame number. */
function readFrames(file: string, size: FrameSpec, frames: number[]): Map<number, Buffer> {
  const want = [...new Set(frames)].filter((n) => n >= 0).sort((a, b) => a - b);
  const sel = want.map((n) => `eq(n,${n})`).join('+');
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='${sel}'`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const bytes = size.width * size.height * 3;
  const map = new Map<number, Buffer>();
  want.forEach((n, i) => map.set(n, raw.subarray(i * bytes, (i + 1) * bytes)));
  return map;
}

/** Every frame of a video as RGB buffers. */
function readAll(file: string, size: FrameSpec): Buffer[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const bytes = size.width * size.height * 3;
  return Array.from({ length: raw.length / bytes }, (_, i) => raw.subarray(i * bytes, (i + 1) * bytes));
}

function colorAt(f: Buffer, size: FrameSpec, x: number, y: number): RGB {
  const s: RGB = [0, 0, 0];
  let n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = Math.min(size.width - 1, Math.max(0, Math.round(x) + dx));
    const py = Math.min(size.height - 1, Math.max(0, Math.round(y) + dy));
    const o = (py * size.width + px) * 3;
    s[0] += f[o]!; s[1] += f[o + 1]!; s[2] += f[o + 2]!; n++;
  }
  return s.map((v) => v / n) as RGB;
}
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luma = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
function nearest(c: RGB): string {
  let best = '?';
  let d = 70;
  for (const [k, v] of Object.entries(PALETTE)) if (dist(c, v) < d) { d = dist(c, v); best = k; }
  return best;
}

/** Clip-local time (mod 4 s) from the bars inside a region: white run length over grey run length. */
function barTime(f: Buffer, size: FrameSpec, region = { x: 0, y: 0, w: size.width, h: size.height }): number | null {
  let grey = 0;
  let white = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    let g = 0;
    let w = 0;
    for (let x = region.x; x < region.x + region.w; x++) {
      const o = (y * size.width + x) * 3;
      const [r, gg, b] = [f[o]!, f[o + 1]!, f[o + 2]!];
      g = Math.abs(r - 128) < 28 && Math.abs(gg - 128) < 28 && Math.abs(b - 128) < 28 ? g + 1 : 0;
      w = r > 205 && gg > 205 && b > 205 ? w + 1 : 0;
      grey = Math.max(grey, g);
      white = Math.max(white, w);
    }
  }
  return grey > 20 ? (4 * white) / grey : null;
}
/** Distance between two times on the 4 s bar clock. */
const clockDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 4) + 4) % 4);
  return Math.min(d, 4 - d);
};

/** A strip of the given frames, each stamped with its frame number. */
async function sheet(video: string, frames: number[], out: string, cols = frames.length, width = 200) {
  const sel = frames.map((n) => `eq(n,${n})`).join('+');
  await ffmpeg([
    '-i', video, '-vf',
    `drawtext=${FONT}text='%{n}':x=6:y=6:fontsize=h/18:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4,select='${sel}',scale=${width}:-2,tile=${cols}x${Math.ceil(frames.length / cols)}:padding=4:color=white`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-update', '1', out,
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// joinClips

interface JoinCase { name: string; clips: Array<Src & { use: number; srcSeconds: number }>; transitions: Array<Transition | null> }

async function verifyJoin(c: JoinCase, size: FrameSpec, out: string) {
  const total = c.clips.reduce((s, k) => s + k.use, 0);
  const [res, secs] = await timed(() => joinClips(c.clips.map((k) => ({ file: k.file, seconds: k.use })), c.transitions, out, size));
  const starts = [0];
  let t = 0;
  for (const k of c.clips) starts.push(Math.round((t += k.use) * fps));
  const n = frameCount(out);
  console.log(`  ${c.name}: ${c.clips.length} clips, ${total.toFixed(2)} s, joined in ${secs.toFixed(2)} s`);
  check(n === starts.at(-1), `frame count ${n} == round(sum*fps) ${starts.at(-1)}`);
  check(Math.abs(probeDuration(out) - total) <= 1 / fps + 1e-3, `duration ${probeDuration(out).toFixed(3)} == ${total.toFixed(3)} ±1 frame (returned ${res.duration.toFixed(3)})`);

  // Effective transition lengths in frames, mirroring the clamp in compose.ts.
  const hold = c.transitions.map((tr, i) => {
    if (!tr) return 0;
    const d = Math.min(Math.round(Math.min(1.5, Math.max(0.2, tr.duration)) * fps), starts[i + 2]! - starts[i + 1]! - 1);
    return d >= 2 ? d : 0;
  });
  type Probe = { frame: number; clip: number; local?: number; why: string };
  const probes: Probe[] = [{ frame: 0, clip: 0, local: 0, why: 'first frame' }];
  c.clips.forEach((k, i) => {
    const s = starts[i]!;
    const len = starts[i + 1]! - s;
    if (i > 0) {
      const d = hold[i - 1]!;
      probes.push({ frame: s - 1, clip: i - 1, why: `frame before clip ${i} start` });
      if (d) {
        probes.push({ frame: s, clip: i - 1, why: `${c.transitions[i - 1]!.type} begins on held frame of clip ${i - 1}` });
        if (d + 1 < len) probes.push({ frame: s + d + 1, clip: i, local: (d + 1) / fps, why: `clip ${i} after ${d}-frame ${c.transitions[i - 1]!.type}` });
      } else {
        probes.push({ frame: s, clip: i, local: 0, why: `clip ${i} first frame at cumulative start (hard cut)` });
      }
    }
    const mid = s + Math.floor(len / 2);
    if (Math.floor(len / 2) / fps < k.srcSeconds - 0.1 && mid > s + (i ? hold[i - 1]! : 0) + 1) probes.push({ frame: mid, clip: i, local: (mid - s) / fps, why: `clip ${i} midpoint` });
    if (k.srcSeconds < k.use) probes.push({ frame: starts[i + 1]! - 1, clip: i, local: k.srcSeconds - 1 / fps, why: `clip ${i} holds its last frame (source shorter than shot)` });
  });
  const frames = readFrames(out, size, probes.map((p) => p.frame));
  let worst = 0;
  for (const p of probes) {
    const f = frames.get(p.frame)!;
    const got = nearest(colorAt(f, size, size.width * 0.1, size.height * 0.08));
    let ok = got === c.clips[p.clip]!.color;
    let note = `colour ${got}`;
    if (ok && p.local !== undefined) {
      const tm = barTime(f, size);
      const err = tm === null ? Infinity : clockDiff(tm, p.local);
      worst = Math.max(worst, err);
      ok = err <= 1.5 / fps;
      note += `, local t ${tm?.toFixed(3)} vs ${p.local.toFixed(3)}`;
    }
    check(ok, `frame ${p.frame} (${(p.frame / fps).toFixed(3)} s): ${p.why} — ${note}`);
  }
  console.log(`  worst local-time error ${(worst * fps).toFixed(2)} frames`);
  return { starts, hold, secs };
}

async function transitionSheets(c: JoinCase, out: string, starts: number[], hold: number[], tag: string) {
  for (const [i, tr] of c.transitions.entries()) {
    if (!tr || !hold[i]) continue;
    const s = starts[i + 1]!;
    const d = hold[i]!;
    const frames = [s - 1, ...[0.2, 0.4, 0.5, 0.6, 0.8].map((q) => s + Math.round(d * q)), s + d + 1];
    const file = join(SHEETS, `join-${tag}-${i + 1}-${tr.type}.png`);
    await sheet(out, frames, file, frames.length, 150);
  }
}

// ---------------------------------------------------------------------------------------------------------------

console.log('Building synthetic inputs...');
const imgLand = await makeImage('LAND', 1600, 1000, [900, 380]);
const imgPort = await makeImage('PORT', 800, 1400, [500, 650]);
// Mixed sizes and rates on purpose; C's source is shorter than its shot, E is shorter than the transitions into it.
const A = await makeClip('A', 'red', 480, 854, 24, 3.2);
const B = await makeClip('B', 'green', 1280, 720, 30, 3.0);
const C = await makeClip('C', 'blue', 640, 640, 25, 1.5);
const D = await makeClip('D', 'yellow', 720, 1280, 30, 2.0);
const E = await makeClip('E', 'magenta', 854, 480, 24, 0.5);
const F = await makeClip('F', 'cyan', 1080, 1920, 60, 3.5);
const T = await Promise.all(['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'orange'].map((col, i) =>
  makeClip(`T${i}`, col, i % 2 ? 1280 : 720, i % 2 ? 720 : 1280, 24, 5.2)));
const base = await makeClip('BASE', 'plum', 720, 1280, 30, 6, true);
const pipSrc = await makeClip('PIP', 'orange', 1280, 720, 30, 4);
const cutSrc = await makeClip('CUT', 'green', 1080, 1920, 25, 2);

const mixed: JoinCase = {
  name: 'mixed sizes/fps, clamps, hard cut',
  clips: [
    { ...A, use: 2.55, srcSeconds: 3.2 }, { ...B, use: 2.3, srcSeconds: 3.0 }, { ...C, use: 2.0, srcSeconds: 1.5 },
    { ...D, use: 1.5, srcSeconds: 2.0 }, { ...E, use: 0.3, srcSeconds: 0.5 }, { ...F, use: 3.1, srcSeconds: 3.5 },
  ],
  transitions: [
    { type: 'whip', duration: 0.35 }, { type: 'fade', duration: 0.5 }, null,
    { type: 'slideleft', duration: 1.0 }, { type: 'wipeleft', duration: 0.6 },
  ],
};
const thirty: JoinCase = {
  name: '30 s, 6 transitions',
  clips: [4, 5, 4, 5, 4, 4, 4].map((use, i) => ({ ...T[i]!, use, srcSeconds: 5.2 })),
  transitions: (['fade', 'dissolve', 'wiperight', 'slideright', 'zoomin', 'whip'] as const).map((type) => ({ type, duration: 0.6 })),
};

const timings: string[] = [];
for (const [aspect, size] of Object.entries(SIZES)) {
  const tag = aspect.replace(':', 'x');
  console.log(`\n== ${aspect} (${size.width}x${size.height} @ ${size.fps})`);

  console.log('joinClips');
  for (const c of [mixed, thirty]) {
    const out = join(OUT, `join-${tag}-${c === mixed ? 'mixed' : '30s'}.mp4`);
    const r = await verifyJoin(c, size, out);
    await transitionSheets(c, out, r.starts, r.hold, `${tag}-${c === mixed ? 'mixed' : '30s'}`);
    if (c === thirty) timings.push(`${aspect} 30 s join, 7 clips, 6 transitions: ${r.secs.toFixed(2)} s`);
  }
  if (aspect === '9:16') {
    // Today's path for comparison: normalize each clip, then stream-copy concat (hard cuts only).
    const [, secs] = await timed(async () => {
      const norm: string[] = [];
      for (const [i, k] of thirty.clips.entries()) {
        const f = join(OUT, `base-norm-${i}.mp4`);
        await normalizeClip(k.file, f, k.use, '9:16');
        norm.push(f);
      }
      await concatClips(norm, join(OUT, 'base-list.txt'), join(OUT, 'base-concat.mp4'));
    });
    timings.push(`9:16 30 s baseline normalizeClip x7 + concat (hard cuts): ${secs.toFixed(2)} s`);
  }

  console.log('addOverlays');
  {
    const out = join(OUT, `overlay-${tag}.mp4`);
    const pip = { x: 0.55, y: 0.06, w: 0.4 };
    const imgRect = { x: 0.06, y: 0.62, w: 0.36, h: 0.22 };
    const [, secs] = await timed(() => addOverlays(base.file, [
      { file: cutSrc.file, kind: 'video', start: 1.0, end: 2.5, fadeIn: 0.2, fadeOut: 0.2 },
      { file: pipSrc.file, kind: 'video', start: 2.0, end: 5.5, rect: pip, radius: 18, border: { px: 4, color: 'white' }, shadow: true, fadeIn: 0.3, fadeOut: 0.3 },
      { file: imgLand, kind: 'image', start: 3.0, end: 6.0, rect: imgRect, radius: 30, shadow: true },
    ], out, size));
    timings.push(`${aspect} overlays (cutaway + 2 PiP) on 6 s base: ${secs.toFixed(2)} s`);
    const W = size.width;
    const H = size.height;
    check(Math.abs(probeDuration(out) - 6) <= 1 / fps + 0.03, `duration ${probeDuration(out).toFixed(3)} == base 6 s`);
    check(hasAudio(out), 'base audio kept');
    const ow = 2 * Math.round((pip.w * W) / 2);
    const oh = 2 * Math.round((ow * 720) / 1280 / 2);
    const ox = Math.round(pip.x * W);
    const oy = Math.round(pip.y * H);
    const at = (s: number) => Math.round(s * fps);
    const fr = readFrames(out, size, [at(0.5), at(0.9), at(1.5), at(2.6), at(1.9), at(2.45), at(4.0), at(5.6), at(2.9), at(4.5)]);
    const cen = (f: number) => nearest(colorAt(fr.get(at(f))!, size, W * 0.1, H * 0.3));
    check(cen(0.5) === 'plum', `0.5 s base visible (${cen(0.5)})`);
    check(cen(0.9) === 'plum', `0.9 s cutaway not yet in (${cen(0.9)})`);
    check(cen(1.5) === 'green', `1.5 s full-frame cutaway (${cen(1.5)})`);
    const cutT = barTime(fr.get(at(1.5))!, size);
    check(cutT !== null && clockDiff(cutT, 0.5) <= 1.5 / fps, `cutaway plays from its own t=0 at start: local ${cutT?.toFixed(3)} vs 0.500`);
    check(cen(2.6) === 'plum', `2.6 s cutaway gone (${cen(2.6)})`);
    const pipC = (f: number) => nearest(colorAt(fr.get(at(f))!, size, ox + ow * 0.12, oy + oh * 0.2));
    check(pipC(1.9) === 'green', `1.9 s PiP not yet shown, cutaway underneath (${pipC(1.9)})`);
    check(pipC(2.45) === 'orange', `2.45 s PiP shown on top of the cutaway (${pipC(2.45)})`);
    check(pipC(4.0) === 'orange', `4.0 s PiP shown (${pipC(4.0)})`);
    const pipAt = (f: number) => colorAt(fr.get(at(f))!, size, ox + ow * 0.12, oy + oh * 0.2);
    check(dist(pipAt(5.6), pipAt(0.5)) < 30, `5.6 s PiP gone after its end (rgb ${pipAt(5.6).map(Math.round)} vs base ${pipAt(0.5).map(Math.round)})`);
    const f4 = fr.get(at(4.0))!;
    const inset = 20;
    const pipT = barTime(f4, size, { x: ox + inset, y: oy + inset, w: ow - 2 * inset, h: oh - 2 * inset });
    check(pipT !== null && clockDiff(pipT, 2.0) <= 3 / fps, `PiP plays from its own t=0 at start: local ${pipT?.toFixed(3)} vs 2.000 (small bars, ±3 frames)`);
    const corner = colorAt(f4, size, ox + 1, oy + 1);
    check(nearest(corner) !== 'orange' && luma(corner) < 150, `PiP corner pixel is cut away by the rounding (rgb ${corner.map(Math.round)})`);
    const border = colorAt(f4, size, ox + ow / 2, oy - 2);
    check(luma(border) > 200, `border above the PiP is white (luma ${luma(border).toFixed(0)})`);
    const shadowPx = colorAt(f4, size, ox + ow / 2, oy + oh + 4 + 9);
    const plain = colorAt(fr.get(at(0.5))!, size, ox + ow / 2, oy + oh + 4 + 9);
    check(luma(shadowPx) < luma(plain) - 6, `shadow darkens below the PiP (luma ${luma(shadowPx).toFixed(0)} vs ${luma(plain).toFixed(0)})`);
    const ix = Math.round(imgRect.x * W + imgRect.w * W * 0.5);
    const iy = Math.round(imgRect.y * H + imgRect.h * H * 0.5);
    const before = colorAt(fr.get(at(2.9))!, size, ix, iy);
    const during = colorAt(fr.get(at(4.5))!, size, ix, iy);
    check(nearest(before) === 'plum' && dist(before, during) > 40, `image PiP appears at 3 s (rgb ${during.map(Math.round)})`);
    await sheet(out, [0.9, 1.05, 1.5, 2.45, 1.95, 2.15, 4.0, 5.4, 5.9].map(at), join(SHEETS, `overlay-${tag}.png`), aspect === '9:16' ? 5 : 3, 220);
    // Full-resolution crop of the PiP at 4 s to inspect corners, border and shadow.
    await ffmpeg(['-i', out, '-vf', `select='eq(n,${at(4.0)})',crop=${Math.min(W - ox + 20, ow + 60)}:${oh + 60}:${Math.max(0, ox - 30)}:0,scale=iw*2:-1:flags=neighbor`, '-fps_mode', 'passthrough', '-frames:v', '1', '-update', '1', join(SHEETS, `overlay-${tag}-pip-zoom.png`)]);
    await ffmpeg(['-i', out, '-vf', `select='eq(n,${at(4.5)})',crop=${Math.round(imgRect.w * W + 80)}:${Math.round(imgRect.h * H + 80)}:${Math.max(0, Math.round(imgRect.x * W) - 30)}:${Math.round(imgRect.y * H) - 30},scale=iw*2:-1:flags=neighbor`, '-fps_mode', 'passthrough', '-frames:v', '1', '-update', '1', join(SHEETS, `overlay-${tag}-img-zoom.png`)]);
  }

  console.log('addOverlays: square PiP, off-grid window');
  {
    // radius 0 with a border and shadow must still be opaque (the rounded-rect mask once gave 50% alpha at r=0),
    // and an image overlay at 1.01-2.01 s must cover exactly the base frames with start <= t < end (25..48).
    const out = join(OUT, `overlay-${tag}-square.mp4`);
    const rect = { x: 0.1, y: 0.1, w: 0.5 };
    await addOverlays(base.file, [
      { file: pipSrc.file, kind: 'video', start: 1.0, end: 2.0, rect, radius: 0, border: { px: 3, color: 'white' }, shadow: true },
      { file: imgLand, kind: 'image', start: 3.01, end: 4.01, rect: { x: 0.5, y: 0.7, w: 0.4 }, radius: 0 },
    ], out, size);
    const W = size.width;
    const H = size.height;
    const ow = 2 * Math.round((rect.w * W) / 2);
    const fr = readFrames(out, size, [36, 72, 73, 96, 97]);
    const inner = colorAt(fr.get(36)!, size, rect.x * W + ow * 0.12, rect.y * H + 8);
    check(dist(inner, PALETTE.orange) < 25, `radius 0 PiP is opaque (rgb ${inner.map(Math.round)} vs orange ${PALETTE.orange})`);
    // Top-right of the image overlay: clear of the base's centred bars and label in every aspect.
    const im = (f: number) => colorAt(fr.get(f)!, size, 0.9 * W - 12, 0.7 * H + 12);
    const isBase = (f: number) => nearest(im(f)) === 'plum';
    check(isBase(72) && !isBase(73) && !isBase(96) && isBase(97),
      `off-grid 3.01-4.01 s shows on frames 73..96 only (72 ${isBase(72) ? 'base' : 'image'}, 73 ${isBase(73) ? 'base' : 'image'}, 96 ${isBase(96) ? 'base' : 'image'}, 97 ${isBase(97) ? 'base' : 'image'})`);
  }
  if (aspect === '9:16') {
    console.log('addOverlays: base with video and audio starting at different times');
    // A flash at video t=2 s and a beep at audio t=2 s, muxed with one stream 0.5 s later than the other: the
    // composite must keep the source's flash-to-beep gap (rebasing only the picture once moved it by 0.5 s).
    const v = join(SRC, 'av-v.mp4');
    const a = join(SRC, 'av-a.m4a');
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${size.width}x${size.height}:r=${fps}:d=5`, '-vf', "drawbox=c=white:t=fill:enable='between(t,2,2.2)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
    await ffmpeg(['-f', 'lavfi', '-i', "sine=f=1000:d=5,volume='if(between(t,2,2.2),1,0)':eval=frame", '-c:a', 'aac', a]);
    for (const late of ['video', 'audio'] as const) {
      const src = join(SRC, `av-${late}-late.mp4`);
      const out = join(OUT, `overlay-av-${late}-late.mp4`);
      const offV = late === 'video' ? ['-itsoffset', '0.5'] : [];
      const offA = late === 'audio' ? ['-itsoffset', '0.5'] : [];
      await ffmpeg([...offV, '-i', v, ...offA, '-i', a, '-map', '0:v', '-map', '1:a', '-c', 'copy', src]);
      await addOverlays(src, [{ file: pipSrc.file, kind: 'video', start: 4, end: 4.5, rect: { x: 0.1, y: 0.1, w: 0.3 } }], out, size);
      const before = flashAndBeep(src);
      const after = flashAndBeep(out);
      check(Math.abs((after.flash - after.beep) - (before.flash - before.beep)) <= 1.5 / fps,
        `${late} starts 0.5 s late: flash ${after.flash.toFixed(3)} s, beep ${after.beep.toFixed(3)} s (source ${before.flash.toFixed(3)} / ${before.beep.toFixed(3)})`);
    }
  }

  console.log('splitScreen');
  for (const layout of ['lr', 'tb'] as const) {
    const out = join(OUT, `split-${tag}-${layout}.mp4`);
    const [, secs] = await timed(() => splitScreen(B.file, D.file, layout, out, 2.5, size, 6));
    timings.push(`${aspect} split ${layout} 2.5 s: ${secs.toFixed(2)} s`);
    const W = size.width;
    const H = size.height;
    check(frameCount(out) === Math.round(2.5 * fps), `${layout}: ${frameCount(out)} frames == ${Math.round(2.5 * fps)}`);
    const f = readFrames(out, size, [30]).get(30)!;
    const a = nearest(colorAt(f, size, 3, 3));
    const b = nearest(colorAt(f, size, W - 4, H - 4));
    const g = colorAt(f, size, W / 2, H / 2);
    const mid = layout === 'lr' ? colorAt(f, size, W / 2, H * 0.1) : colorAt(f, size, W * 0.1, H / 2);
    check(a === 'green' && b === 'yellow', `${layout}: halves filled edge to edge (corners ${a} / ${b})`);
    check(luma(mid) > 200, `${layout}: white divider at the centre line (luma ${luma(mid).toFixed(0)}, centre ${luma(g).toFixed(0)})`);
    await sheet(out, [0, 30, 59], join(SHEETS, `split-${tag}-${layout}.png`), 3, 200);
  }

  console.log('kenBurns');
  const moves: KenBurnsMove[] = ['in', 'out', 'left', 'right', 'up', 'down'];
  const img = aspect === '9:16' ? imgLand : imgPort;
  const kbFiles: string[] = [];
  for (const move of moves) {
    const out = join(OUT, `kb-${tag}-${move}.mp4`);
    const [, secs] = await timed(() => kenBurns(img, out, 3, size, move));
    kbFiles.push(out);
    const all = readAll(out, size);
    const track = all.map((f) => markerAt(f, size));
    const ok = track.every(Boolean);
    const xs = track.map((p) => (p ? (move === 'in' || move === 'out' ? Math.hypot(p[0] - size.width / 2, p[1] - size.height / 2) : move === 'left' || move === 'right' ? p[0] : p[1]) : 0));
    const dir = { in: 1, out: -1, left: 1, right: -1, up: 1, down: -1 }[move];
    const monotonic = xs.every((v, i) => i === 0 || (v - xs[i - 1]!) * dir >= -0.15);
    const { max: jitter, rms } = wobble(xs);
    const black = [0, all.length - 1].some((i) => [[1, 1], [size.width - 2, size.height - 2]].some(([x, y]) => luma(colorAt(all[i]!, size, x!, y!)) < 12));
    check(all.length === 3 * fps && ok && monotonic && !black,
      `${move}: ${all.length} frames, marker ${xs[0]!.toFixed(1)} -> ${xs.at(-1)!.toFixed(1)} px, monotonic ${monotonic}, ${secs.toFixed(2)} s`);
    // Ideal eased motion has |2nd diff| under 0.1 px here; the rest is centroid measurement noise (about 0.2 px
    // rms on pans, 0.3 on zooms where the marker also grows; a lossless render measures the same). Plain zoompan
    // measures 0.75 rms on a zoom and 1.7 on a pan.
    check(rms < (move === 'in' || move === 'out' ? 0.4 : 0.3) && jitter < 1.2, `${move}: smooth — 2nd diff of marker position rms ${rms.toFixed(3)} px, max ${jitter.toFixed(3)} px`);
  }
  // The same move without supersampling, to show what the 4x step buys.
  {
    const out = join(OUT, `kb-${tag}-naive.mp4`);
    const n = 3 * fps;
    await ffmpeg(['-i', img, '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},zoompan=z='1.18':x='(iw-iw/zoom)*(1-cos(PI*on/${n - 1}))/2':y='(ih-ih/zoom)/2':d=${n}:s=${size.width}x${size.height}:fps=${fps}`, '-frames:v', String(n), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
    const w = wobble(readAll(out, size).map((f) => markerAt(f, size)?.[0] ?? 0));
    console.log(`  (reference: plain zoompan 'right': 2nd diff rms ${w.rms.toFixed(3)} px, max ${w.max.toFixed(3)} px)`);
    const zin = join(OUT, `kb-${tag}-naive-in.mp4`);
    await ffmpeg(['-i', img, '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},zoompan=z='1+0.25*(1-cos(PI*on/${n - 1}))/2':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${n}:s=${size.width}x${size.height}:fps=${fps}`, '-frames:v', String(n), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', zin]);
    const wz = wobble(readAll(zin, size).map((f) => { const p = markerAt(f, size); return p ? Math.hypot(p[0] - size.width / 2, p[1] - size.height / 2) : 0; }));
    console.log(`  (reference: plain zoompan 'in': 2nd diff rms ${wz.rms.toFixed(3)} px, max ${wz.max.toFixed(3)} px)`);
  }
  // One row per move: frames 0, 24, 48, 71.
  const rows = kbFiles.map((f, i) => `[${i}:v]select='eq(n,0)+eq(n,24)+eq(n,48)+eq(n,71)',scale=150:-2,tile=4x1:padding=3:color=white[r${i}]`);
  await ffmpeg([...kbFiles.flatMap((f) => ['-i', f]), '-filter_complex', `${rows.join(';')};${kbFiles.map((_, i) => `[r${i}]`).join('')}vstack=inputs=${kbFiles.length}[o]`, '-map', '[o]', '-fps_mode', 'passthrough', '-frames:v', '1', '-update', '1', join(SHEETS, `kb-${tag}.png`)]);
}

/** Time of the first bright frame and of the first loud audio block. */
function flashAndBeep(file: string): { flash: number; beep: number } {
  const rows = (args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'csv=p=0']).toString().trim().split('\n').map((l) => l.split(',').map(Number));
  const flash = rows(['-f', 'lavfi', '-i', `movie=${file},signalstats`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.signalstats.YAVG'])
    .find(([, y]) => y! > 128)?.[0] ?? NaN;
  const beep = rows(['-f', 'lavfi', '-i', `amovie=${file},aresample=44100,asetnsamples=441,astats=metadata=1:reset=1`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.astats.Overall.RMS_level'])
    .find(([, r]) => r! > -30)?.[0] ?? NaN;
  return { flash, beep };
}

/** Frame-to-frame acceleration of a tracked position: smooth motion keeps it near zero, jitter does not. */
function wobble(xs: number[]) {
  const d2 = xs.slice(2).map((v, i) => Math.abs(v - 2 * xs[i + 1]! + xs[i]!));
  return { max: Math.max(...d2), rms: Math.sqrt(d2.reduce((s, v) => s + v * v, 0) / d2.length) };
}

/** Sub-pixel centroid of the red marker square. */
function markerAt(f: Buffer, size: FrameSpec): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const o = (y * size.width + x) * 3;
    const r = f[o]!;
    const g = f[o + 1]!;
    const b = f[o + 2]!;
    const w = Math.max(0, Math.min(r - 140, 100) - Math.max(g, b)) / 100;
    if (w > 0) { sx += x * w; sy += y * w; n += w; }
  }
  return n > 20 ? [sx / n, sy / n] : null;
}

console.log('\nTimings');
for (const t of timings) console.log(`  ${t}`);
console.log(`\nOutputs in ${OUT}\nContact sheets in ${SHEETS}`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
