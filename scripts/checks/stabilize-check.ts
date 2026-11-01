// Checks src/media/stabilize.ts on the development set's shake clips (DEVSET, default ../video_agent_devset;
// its defects/ hold one static talking shot shaken by a known path at 3/8/16/30 px peak, the same shot unshaken,
// and a walk-forward shot shaken at 12 px) plus synthetic clips made here.
//
// Dev set: the 8 / 30 px takes and the walk come out under a third of their shake (and well under 手抖), with at
// most the 12 % zoom cap, no black fill band on any frame edge, every frame kept; the walk keeps its movement (a
// smoothed path, not tripod); the steady reference and a clean clip whose 'shake' is a person moving (kneading)
// are passed through untouched (zoom 1, residual = before) instead of cropped; a cut span keeps its length and
// audio, audio: 'drop' drops it, a hard zoom budget is kept; the deshake fallback, forced, still takes at least
// half the shake out without black corners. Without the dev set those cases are skipped (reported, not failed).
//
// Synthetic: a bright texture (any uncovered frame edge reads as black) shot through a hand-shake path of a few
// sines at 2-7 Hz, held still (must be locked off: tripod mode) and over a slow pan (a smoothed path); an
// unshaken copy must measure ~0 with both measures. Set STAB_CHECK_KEEP=<dir> to copy the outputs there for
// viewing. Everything else is written under a fresh os.tmpdir() folder that is removed at the end.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasVidstab, measureShake, SHAKE_LIMIT, stabilize, type StabilizeOptions, type StabilizeResult } from '../../src/media/stabilize.ts';

const DEVSET = process.env.DEVSET ?? new URL('../../../video_agent_devset', import.meta.url).pathname;
const DIR = await mkdtemp(join(tmpdir(), 'stabilize-check-'));
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const p = (name: string) => join(DIR, name);

/** Runs a command, resolving with stdout (raw) and stderr; rejects on failure or after 5 minutes. */
function sh(cmd: string, args: string[], onStdout?: (b: Buffer) => void): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d: Buffer) => (onStdout ? onStdout(d) : (out += d)));
    c.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => c.kill('SIGKILL'), 300_000);
    c.on('error', reject);
    c.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`));
    });
  });
}
const ffmpeg = (args: string[]) => sh('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args]);

/** Frame count, duration and whether there is an audio stream. */
async function probe(file: string) {
  const { out } = await sh('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out) as { streams: Array<{ codec_type: string; nb_read_frames?: string }>; format: { duration: string } };
  return {
    frames: Number(j.streams.find((s) => s.codec_type === 'video')?.nb_read_frames ?? 0),
    duration: Number(j.format.duration),
    audio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** Per frame at 180x320: the darkest 8x8 corner's mean luma, and the most outer-edge pixels on any one side of
 *  one frame that are vidstab's black fill (Y < 9; real video black is 16). A dark detail touching the edge
 *  gives a few; an uncovered edge gives a band along most of the side. */
async function edges(file: string) {
  const W = 180, H = 320;
  let buf: Buffer = Buffer.alloc(0);
  let darkestCorner = 255, band = 0, frames = 0;
  const frame = (fr: Buffer) => {
    frames++;
    for (const [cx, cy] of [[0, 0], [W - 8, 0], [0, H - 8], [W - 8, H - 8]] as const) {
      let s = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += fr[(cy + y) * W + cx + x]!;
      darkestCorner = Math.min(darkestCorner, s / 64);
    }
    const side = [0, 0, 0, 0];
    for (let x = 0; x < W; x++) { side[0] += Number(fr[x]! < 9); side[1] += Number(fr[(H - 1) * W + x]! < 9); }
    for (let y = 0; y < H; y++) { side[2] += Number(fr[y * W]! < 9); side[3] += Number(fr[y * W + W - 1]! < 9); }
    band = Math.max(band, side[0]! / W, side[1]! / W, side[2]! / H, side[3]! / H);
  };
  await sh('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}:flags=neighbor,format=yuv420p,extractplanes=y`, '-f', 'rawvideo', '-'], (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= W * H) {
      frame(buf.subarray(0, W * H));
      buf = buf.subarray(W * H);
    }
  });
  return { darkestCorner, band, frames };
}

/** Steadies `file` into the temp folder, printing the result and the time it took. */
async function steady(file: string, name: string, opts?: StabilizeOptions): Promise<[StabilizeResult, string]> {
  const out = p(`${name}.stab.mp4`);
  const t0 = Date.now();
  const r = await stabilize(file, out, opts);
  console.log(`${name}: ${JSON.stringify(r)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (process.env.STAB_CHECK_KEEP) await copyFile(out, join(process.env.STAB_CHECK_KEEP, `check-${name}.mp4`));
  return [r, out];
}

/** A seeded hand-shake path: a few sines at 2-7 Hz summing to about ±`amp` (an ffmpeg expression in t). */
function shakeExpr(seed: number, amp: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const terms = Array.from({ length: 3 }, (_, i) =>
    `${((amp / 2) * (0.6 + 0.6 * rnd()) / (i + 1) ** 0.5).toFixed(2)}*sin(2*PI*${(2 + 5 * rnd()).toFixed(2)}*t+${(6.28 * rnd()).toFixed(2)})`);
  return terms.join('+');
}

const CAP = 1.12 + 1e-9;
try {
  const vidstab = await hasVidstab();
  console.log(`vidstab in this ffmpeg: ${vidstab}`);

  // ---- dev set ------------------------------------------------------------------------------------------
  const dev = (rel: string) => join(DEVSET, rel);
  if (!existsSync(dev('defects/shake_a30px.mp4'))) {
    console.log(`SKIP dev-set cases: ${DEVSET} not found (set DEVSET=<dir>)`);
  } else {
    console.log(`dev set: ${DEVSET}`);
    for (const [name, want] of [['shake_a8px', 0.3], ['shake_a30px', 0.3], ['shake_walk_a12px', 0.3]] as const) {
      const file = dev(`defects/${name}.mp4`);
      const [r, out] = await steady(file, name);
      check(r.before > 0.3, `${name}: input reads as shaky (${r.before})`);
      check(r.residual <= r.before * want && r.residual < SHAKE_LIMIT / 2,
        `${name}: shake down to under ${want * 100}% and well under 手抖 (${r.before} → ${r.residual}, ${Math.round((1 - r.residual / r.before) * 100)}% off)`);
      check(r.zoom > 1 && r.zoom <= CAP, `${name}: zoom ${r.zoom} within the 1.12 cap`);
      if (name === 'shake_walk_a12px' && vidstab) check(!r.tripod && r.smoothing === 24, `${name}: keeps its walk (smoothed path, smoothing ${r.smoothing}, tripod ${r.tripod})`);
      const again = await measureShake(out);
      check(Math.abs(again - r.residual) <= 0.1, `${name}: reported residual agrees with a fresh measure of the file (${r.residual} vs ${again})`);
      const e = await edges(out);
      check(e.band < 0.25 && e.darkestCorner > 15, `${name}: no black fill band (most of one side ${(e.band * 100).toFixed(1)}%), darkest corner ${e.darkestCorner.toFixed(0)}`);
      const [pi, po] = [await probe(file), await probe(out)];
      check(po.frames === pi.frames, `${name}: ${po.frames} frames out for ${pi.frames} in`);
    }
    // Nothing to gain: kept as it is, at full frame.
    for (const rel of ['defects/shake_reference_a0px.mp4', 'footage/bakery/bakery_02_kneading.mp4']) {
      const name = rel.replace(/^.*\/|\.mp4$/g, '');
      const [r, out] = await steady(dev(rel), name);
      check(r.zoom === 1 && r.residual === r.before, `${name}: passed through untouched (zoom ${r.zoom}, ${r.before} → ${r.residual})`);
      check((await probe(out)).frames === (await probe(dev(rel))).frames, `${name}: every frame kept`);
    }
    // A cut span keeps its own length and its sound; 'drop' leaves the sound out; a hard budget is kept.
    const a16 = dev('defects/shake_a16px.mp4');
    const [cut, cutOut] = await steady(a16, 'cut', { from: 1, seconds: 2 });
    const pc = await probe(cutOut);
    check(pc.frames === 48 && Math.abs(pc.duration - 2) < 0.1 && pc.audio && cut.residual < SHAKE_LIMIT,
      `span 1–3 s: ${pc.frames} frames, ${pc.duration.toFixed(2)} s, audio ${pc.audio}, shake ${cut.before} → ${cut.residual}`);
    const [, muteOut] = await steady(a16, 'mute', { from: 1, seconds: 2, audio: 'drop' });
    check(!(await probe(muteOut)).audio, `audio: 'drop' writes video only`);
    const [tight, tightOut] = await steady(dev('defects/shake_a30px.mp4'), 'tight', { zoom: 1.05 });
    check(tight.zoom <= 1.05 + 1e-9 && tight.limited && tight.residual < SHAKE_LIMIT,
      `zoom budget 1.05 kept and still steadier than 手抖 (${tight.zoom}, limited ${tight.limited}, ${tight.before} → ${tight.residual})`);
    check((await edges(tightOut)).band < 0.25, 'zoom budget 1.05: no black fill band');
    if (vidstab) {
      const [d, dOut] = await steady(a16, 'deshake', { method: 'deshake' });
      check(d.method === 'deshake' && d.residual <= d.before * 0.5 && d.zoom <= CAP, `forced deshake: ${d.before} → ${d.residual} at zoom ${d.zoom}`);
      check((await edges(dOut)).darkestCorner > 15, 'forced deshake: no black corner');
    }
  }

  // ---- synthetic --------------------------------------------------------------------------------------------
  console.log('synthetic');
  const W = 720, H = 1280, FPS = 30, SECONDS = 4;
  // A bright texture (luma 70-230) with strong lines, larger than the frame so the shaken crop never leaves it.
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x320:d=1,noise=alls=90:allf=u,gblur=sigma=1.2', '-vf',
    'scale=1600:1600:flags=bicubic,lutyuv=y=70+val*0.62,drawgrid=w=160:h=120:t=4:color=white@0.8,drawbox=x=500:y=600:w=300:h=200:color=0xc04020:t=fill',
    '-frames:v', '1', p('texture.png')]);
  const shot = (name: string, pan: string, shake: boolean) => ffmpeg([
    '-loop', '1', '-framerate', String(FPS), '-i', p('texture.png'), '-f', 'lavfi', '-i', `sine=f=440:d=${SECONDS}`, '-filter_complex',
    `[0:v]${shake ? `rotate=a='0.004*sin(2*PI*3.3*t)+0.003*sin(2*PI*5.1*t+1)',` : ''}` +
    `crop=w=${W}:h=${H}:x='(iw-${W})/2+${pan}${shake ? `+${shakeExpr(7, 22)}` : ''}':y='(ih-${H})/2${shake ? `+${shakeExpr(11, 22)}` : ''}'[v]`,
    '-map', '[v]', '-map', '1:a', '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', p(`${name}.mp4`)]);
  await shot('steady', '0', false);
  await shot('shaky', '0', true);
  await shot('pan', `-120+60*t`, true);
  const inFrames = (await probe(p('shaky.mp4'))).frames;
  check(inFrames === FPS * SECONDS, `synthetic clips have ${FPS * SECONDS} frames (got ${inFrames})`);
  const still = await measureShake(p('steady.mp4'));
  check(still < 0.05, `unshaken clip measures ~0 (${still})`);
  // The measure used without vidstab (deshake's motion log) must tell the two apart as well.
  const [dSteady, dShaky] = [await measureShake(p('steady.mp4'), { kind: 'deshake' }), await measureShake(p('shaky.mp4'), { kind: 'deshake' })];
  check(dSteady < 0.1 && dShaky > SHAKE_LIMIT, `deshake-log measure: unshaken ${dSteady}, shaky ${dShaky}`);
  for (const [name, what] of [['shaky', 'held-still shake'], ['pan', 'shake over a slow pan']] as const) {
    const [r, out] = await steady(p(`${name}.mp4`), `synthetic-${name}`);
    check(r.before > SHAKE_LIMIT && r.residual <= r.before * 0.4, `${what}: shake down by ≥60% (${r.before} → ${r.residual})`);
    check(r.zoom >= 1 && r.zoom <= CAP, `${what}: zoom ${r.zoom} within the cap`);
    if (vidstab && name === 'shaky') check(r.tripod, `${what}: held still (tripod mode)`);
    if (vidstab && name === 'pan') check(!r.tripod && r.smoothing === FPS, `${what}: smoothed path (smoothing ${r.smoothing}; one second = ${FPS} frames)`);
    const e = await edges(out);
    check(e.darkestCorner > 40 && (!vidstab || e.band === 0), `${what}: no black corner (${e.darkestCorner.toFixed(0)}) or fill (${(e.band * 100).toFixed(1)}%)`);
    const pr = await probe(out);
    check(pr.frames === inFrames && pr.audio, `${what}: ${pr.frames} frames out for ${inFrames} in, audio kept`);
  }
  // Relative paths work (ffmpeg runs in a temporary folder).
  const here = process.cwd();
  process.chdir(DIR);
  try {
    const r = await stabilize('shaky.mp4', 'relative.mp4', { seconds: 1 });
    check(existsSync(p('relative.mp4')) && r.zoom >= 1, `relative paths (${r.before} → ${r.residual})`);
  } finally {
    process.chdir(here);
  }
} catch (e) {
  check(false, `threw: ${(e as Error).message}`);
} finally {
  await rm(DIR, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok');
process.exit(failures.length ? 1 : 0);
