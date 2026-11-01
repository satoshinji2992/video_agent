// Checks src/media/colormatch.ts on the development set (DEVSET, default ../video_agent_devset: 30 clean
// phone clips of five shops plus copies of some with known colour casts and exposure offsets) and on synthetic
// clips.
//
// Dev set, each shop's clips taken as one project (projectTarget over all of them, the rounded target the
// caller uses), then with the cast / exposure copies of that shop's clips added: every clip is corrected and
// compared pixel by pixel with the clean original (mean ln ratio per channel over its mid-tones: stops, ln r/b,
// tint). Clean clips must stay nearly as they are; mild casts must be mostly taken out, strong ones reduced and
// none pushed past neutral; two takes of one scene 0.7 stop apart must end up closer; a clip a stop under must be
// lifted. Without the dev set this part is skipped (reported, not failed).
//
// Synthetic (540x960, 24 fps, light grain): a grey card under a magenta cast (10-bit, like iPhone HEVC) is
// neutralised within a small tolerance after correction; a card drowned in a strong cast is moved toward grey
// without overshooting; a warm tungsten card is cooled by at most ~20 % and stays clearly warm; grey ramps
// (eleven steps from near-black to near-white, plus a blown strip) under a magenta and a cool gain cast come out
// with the cast reduced the same way at every level, neither the shadows swinging past neutral into the opposite
// colour nor the highlights left tinted, and white staying white; an underexposed grey card is lifted but not
// past the +0.8 stop cap; a night street with a few lamps is not lifted past the cap and its lamps stay white; a
// correctly exposed neutral clip yields ''; projectTarget takes the median and holds it to its band; a still
// image is measured too. Everything is written under a fresh os.tmpdir() folder that is removed at the end.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colourStats, correctionFilter, projectTarget, type ColourStats } from '../../src/media/colormatch.ts';

const DEVSET = process.env.DEVSET ?? new URL('../../../video_agent_devset', import.meta.url).pathname;
const DIR = await mkdtemp(join(tmpdir(), 'colormatch-check-'));
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

/** Runs ffmpeg, killed after 120 s. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}

const p = (name: string) => join(DIR, `${name}.mp4`);
/** A 2 s clip of a flat colour with light grain, plus `draw` on top. */
async function card(name: string, colour: string, opts: { draw?: string; tenBit?: boolean } = {}) {
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${colour}:s=540x960:r=24:d=2`,
    '-vf', [opts.draw, 'noise=alls=6:allf=t'].filter(Boolean).join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', opts.tenBit ? 'yuv420p10le' : 'yuv420p', '-an', p(name)]);
  return p(name);
}
/** The clip with `vf` applied, re-encoded the way a shot is cut (8-bit x264). */
async function corrected(name: string, vf: string) {
  await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', p(name), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', p(`${name}.fixed`)]);
  return colourStats(p(`${name}.fixed`));
}
/** Mean RGB (0–255) of each ramp step's inner columns, and of the blown strip on top, in the clip's first frame. */
const STEPS = [0.06, 0.1, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const STEP_W = 49;
async function rampPatches(file: string): Promise<{ steps: number[][]; white: number[] }> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-frames:v', '1',
      '-vf', 'format=rgb24', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
  const mean = (x0: number, x1: number, y0: number, y1: number) => {
    const acc = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x++) {
      const k = (y * 540 + x) * 3;
      acc[0] += raw[k]!; acc[1] += raw[k + 1]!; acc[2] += raw[k + 2]!; n++;
    }
    return acc.map((v) => v / n);
  };
  return { steps: STEPS.map((_, i) => mean(i * STEP_W + 12, i * STEP_W + STEP_W - 12, 200, 940)), white: mean(20, 520, 30, 90) };
}
/** A ramp clip under a gain cast (each channel's share of grey), 10-bit, with a blown strip across the top. */
async function ramp(name: string, gain: [number, number, number]) {
  const hex = (v: number, g: number) => Math.round(Math.min(1, v * g) * 255).toString(16).padStart(2, '0');
  const boxes = STEPS.map((v, i) => `drawbox=x=${i * STEP_W}:y=120:w=${i === STEPS.length - 1 ? 540 - i * STEP_W : STEP_W}:h=840:color=0x${gain.map((g) => hex(v, g)).join('')}:t=fill`);
  return card(name, '0x' + gain.map((g) => hex(0.45, g)).join(''), { draw: ['format=gbrp', 'drawbox=x=0:y=0:w=540:h=120:color=white:t=fill', ...boxes].join(','), tenBit: true });
}
const tempOf = (c: number[]) => Math.log(c[0]! / c[2]!);
const tintOf = (c: number[]) => Math.log(c[1]!) - (Math.log(c[0]!) + Math.log(c[2]!)) / 2;

const temp = (s: ColourStats) => Math.log(s.r / s.b);
const tint = (s: ColourStats) => Math.log(s.g) - (Math.log(s.r) + Math.log(s.b)) / 2;
const stops = (a: ColourStats, b: ColourStats) => 2.2 * Math.log2(b.luma / a.luma);
const f3 = (v: number) => v.toFixed(3);
const show = (s: ColourStats) => `luma ${f3(s.luma)} temp ${f3(temp(s))} tint ${f3(tint(s))}`;

// ---- dev set helpers ----------------------------------------------------------------------------------------
/** The clip's frames as the caller sees them (720x1280 scaled to 360x640, then `vf`), three a second at 96x96. */
function devFrames(file: string, vf: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chain = ['scale=360:640', vf, 'fps=3', 'scale=96:96:flags=area', 'format=rgb24'].filter(Boolean).join(',');
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-vf', chain, '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
    });
  });
}
/** How `a` differs from `ref` (same frames, pixel for pixel, over ref's mid-tones): stops of exposure and the
 *  ln r/b (temp) and tint shift. */
function pixelDiff(a: Buffer, ref: Buffer) {
  let lr = 0, lg = 0, lb = 0, ly = 0, k = 0;
  for (let i = 0; i + 2 < Math.min(a.length, ref.length); i += 3) {
    const r0 = ref[i]!, g0 = ref[i + 1]!, b0 = ref[i + 2]!;
    if (Math.min(r0, g0, b0) < 13 || Math.max(r0, g0, b0) > 242) continue;
    const r1 = Math.max(1, a[i]!), g1 = Math.max(1, a[i + 1]!), b1 = Math.max(1, a[i + 2]!);
    lr += Math.log(r1 / r0); lg += Math.log(g1 / g0); lb += Math.log(b1 / b0);
    ly += Math.log((0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1) / (0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0));
    k++;
  }
  return { stops: (2.2 * ly) / k / Math.LN2, temp: (lr - lb) / k, tint: (lg - (lr + lb) / 2) / k };
}
const fd = (d: { stops: number; temp: number; tint: number }) => `${d.stops >= 0 ? '+' : ''}${d.stops.toFixed(2)} stop, ln r/b ${d.temp >= 0 ? '+' : ''}${d.temp.toFixed(3)}, tint ${d.tint >= 0 ? '+' : ''}${d.tint.toFixed(3)}`;
/** Corrects every clip of a project the way render_clip_shot does (rounded shared target); returns the frames of
 *  each clip before and after. */
async function project(files: string[]) {
  const stats = await Promise.all(files.map((f) => colourStats(f)));
  const luma = Math.round(projectTarget(stats).luma * 50) / 50;
  const out = new Map<string, { before: Buffer; after: Buffer; vf: string }>();
  await Promise.all(files.map(async (f, i) => {
    const vf = correctionFilter(stats[i]!, { luma });
    out.set(f, { before: await devFrames(f, ''), after: await devFrames(f, vf), vf });
  }));
  return { luma, clips: out };
}
const SHOPS: Record<string, string[]> = {
  bakery: ['bakery_01_exterior', 'bakery_02_kneading', 'bakery_03_croissants', 'bakery_04_customer', 'bakery_05_shelves', 'bakery_06_slicing'],
  flower_shop: ['flower_01_exterior', 'flower_02_arranging', 'flower_03_roses', 'flower_04_customer', 'flower_05_interior', 'flower_06_trimming'],
  car_repair: ['garage_01_exterior', 'garage_02_wrench', 'garage_03_engine', 'garage_04_customer', 'garage_05_workshop', 'garage_06_tyre'],
  gym: ['gym_01_exterior', 'gym_02_coaching', 'gym_03_dumbbells', 'gym_04_class', 'gym_05_space', 'gym_06_ropes'],
  street_food: ['stall_01_exterior', 'stall_02_jianbing', 'stall_03_skewers', 'stall_04_queue', 'stall_05_cart', 'stall_06_wok'],
};
/** Cast copies: file, its clean original, and which axis the cast is on. */
const CASTS: Array<[string, string, 'temp' | 'tint', 'mild' | 'strong']> = [
  ['cast_warm_mild', 'bakery/bakery_04_customer', 'temp', 'mild'],
  ['cast_warm_medium', 'bakery/bakery_04_customer', 'temp', 'strong'],
  ['cast_warm_strong', 'bakery/bakery_04_customer', 'temp', 'strong'],
  ['cast_magenta_mild', 'flower_shop/flower_05_interior', 'tint', 'mild'],
  ['cast_magenta_strong', 'flower_shop/flower_05_interior', 'tint', 'strong'],
  ['cast_green_mild', 'car_repair/garage_04_customer', 'tint', 'mild'],
  ['cast_green_strong', 'car_repair/garage_04_customer', 'tint', 'strong'],
  ['cast_cool_medium', 'gym/gym_02_coaching', 'temp', 'strong'],
];

try {
  console.log('magenta cast on a grey card (10-bit)');
  {
    await card('magenta', '0x8C7A8C', { tenBit: true });
    const s = await colourStats(p('magenta'));
    const vf = correctionFilter(s, { luma: s.luma });
    check(tint(s) < -0.1, `the cast is measured (${show(s)})`);
    check(vf !== '', `a correction is returned (${vf.slice(0, 60)}…)`);
    const a = await corrected('magenta', vf);
    check(Math.abs(tint(a)) < 0.035 && Math.abs(temp(a)) < 0.035, `neutral after correction (${show(a)})`);
    check(Math.abs(stops(s, a)) < 0.15, `brightness kept (${f3(stops(s, a))} stop)`);
  }

  console.log('strong magenta cast');
  {
    await card('strong', '0xA06EA0');
    const s = await colourStats(p('strong'));
    const a = await corrected('strong', correctionFilter(s, { luma: s.luma }));
    check(tint(a) < 0 && tint(a) > tint(s) * 0.75, `moved toward grey without overshooting (${f3(tint(s))} → ${f3(tint(a))})`);
  }

  for (const [label, gain, axis, of] of [
    ['magenta', [1, 0.88, 1], 'tint', tintOf],
    ['cool', [0.82, 1, 1], 'temp', tempOf],
  ] as const) {
    console.log(`grey ramp under a ${label} gain cast`);
    await ramp(`ramp-${label}`, [...gain]);
    const s = await colourStats(p(`ramp-${label}`));
    const vf = correctionFilter(s, { luma: s.luma });
    check(vf !== '', `a correction is returned (${show(s)})`);
    await corrected(`ramp-${label}`, vf || 'null');
    const before = await rampPatches(p(`ramp-${label}`)), after = await rampPatches(p(`ramp-${label}.fixed`));
    const b = before.steps.map(of), a = after.steps.map(of);
    // The nominal cast in ln units; it is negative on both axes here, so past neutral means positive (green / warm).
    const cast = axis === 'tint' ? Math.log(gain[1]) - (Math.log(gain[0]) + Math.log(gain[2])) / 2 : Math.log(gain[0] / gain[2]);
    const shift = a.map((v, i) => v - b[i]!);
    console.log(`       ${axis} per step ${STEPS.map((v, i) => `${v}: ${f3(b[i]!)}→${f3(a[i]!)}`).join('  ')}`);
    // The deepest step is a few 8-bit code values, whose rounding alone moves it by several hundredths.
    check(a.slice(1).every((v) => v < 0.035) && a[0]! < 0.06, `no step swings past neutral into the opposite colour (deepest ${f3(a[0]!)})`);
    // The deepest step (a few 8-bit code values) is left out of the level-by-level checks; the steps themselves
    // carry ±0.02 of rounding, while a per-channel power curve spreads the shift by 0.3 or more.
    const body = shift.slice(1, -1);
    check(body.every((v) => v > 0.45 * -cast), `at least ~half the cast taken out at every step 0.1–0.8 (cast ${f3(cast)}, shifts ${body.map(f3).join(' ')})`);
    check(Math.max(...body) - Math.min(...body) < 0.05, `the same correction at every level (spread ${f3(Math.max(...body) - Math.min(...body))})`);
    check(shift[STEPS.length - 1]! > 0.3 * -cast, `the 0.9 step is corrected too (${f3(b[STEPS.length - 1]!)} → ${f3(a[STEPS.length - 1]!)})`);
    check(Math.min(...after.white) > 248, `white stays white (${after.white.map((v) => v.toFixed(0)).join('/')})`);
  }

  console.log('warm tungsten light');
  {
    await card('warm', '0xB4966E');
    const s = await colourStats(p('warm'));
    const a = await corrected('warm', correctionFilter(s, { luma: s.luma }) || 'null');
    check(temp(s) - temp(a) <= 0.22, `cooled by at most ~20 % (${f3(temp(s))} → ${f3(temp(a))})`);
    check(temp(a) > 0.25, 'still clearly warm');
  }

  console.log('underexposed grey card');
  {
    await card('under', '0x404040');
    const s = await colourStats(p('under'));
    const vf = correctionFilter(s);
    const a = await corrected('under', vf || 'null');
    const up = stops(s, a);
    check(up > 0.4, `lifted (${f3(s.luma)} → ${f3(a.luma)}, +${f3(up)} stop)`);
    check(up <= 0.9, 'not past the +0.8 stop cap');
    check(Math.abs(tint(a)) < 0.02 && Math.abs(temp(a)) < 0.02, `stays neutral (${show(a)})`);
  }

  console.log('night street');
  {
    const lamps = [[80, 200], [400, 260], [250, 600], [60, 820]].map(([x, y]) => `drawbox=x=${x}:y=${y}:w=24:h=24:color=0xFFF4E0:t=fill`).join(',');
    await card('night', '0x141820', { draw: `drawbox=x=0:y=700:w=540:h=260:color=0x2A2622:t=fill,${lamps}` });
    const s = await colourStats(p('night'));
    const vf = correctionFilter(s);
    const a = await corrected('night', vf || 'null');
    const up = stops(s, a);
    check(up <= 0.9, `not lifted past the cap (${f3(s.luma)} → ${f3(a.luma)}, +${f3(up)} stop)`);
    check(a.luma < 0.16, 'still reads as night');
    // The lamps (a 24 px box, sampled at its centre) stay white.
    const lamp = await new Promise<number[]>((resolve) => {
      const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', p('night.fixed'), '-frames:v', '1',
        '-vf', 'crop=8:8:408:268,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const out: number[] = [];
      proc.stdout.on('data', (d: Buffer) => out.push(...d));
      proc.on('close', () => resolve(out));
    });
    check(lamp.length === 3 && Math.min(...lamp) > 200, `lamps stay white (${lamp.join('/')})`);
  }

  console.log('correctly exposed neutral clip');
  {
    await card('good', '0x6A6A6A', { draw: 'drawbox=x=0:y=0:w=540:h=300:color=0xB4B4B4:t=fill,drawbox=x=0:y=700:w=540:h=260:color=0x404040:t=fill' });
    const s = await colourStats(p('good'));
    const vf = correctionFilter(s);
    check(vf === '', `left alone (${show(s)}${vf ? `, got ${vf}` : ''})`);
    check(correctionFilter(s, projectTarget([s])) === '', 'left alone against its own project target');
  }

  console.log('blown-out clip');
  {
    await card('bright', '0xEEEEEE', { draw: 'drawbox=x=0:y=0:w=540:h=400:color=white:t=fill' });
    const s = await colourStats(p('bright'));
    const vf = correctionFilter(s);
    const a = await corrected('bright', vf || 'null');
    check(stops(s, a) >= -0.75, `darkened by at most ~0.7 stop (${f3(stops(s, a))})`);
    check(a.p95 >= 0.97, `whites stay white (p95 ${f3(a.p95)})`);
  }

  console.log('projectTarget');
  {
    const at = (luma: number): ColourStats => ({ luma, r: luma, g: luma, b: luma, p5: luma / 4, p95: Math.min(1, luma * 1.8) });
    check(projectTarget([at(0.34), at(0.4), at(0.36), at(0.95), at(0.01)]).luma === 0.36, 'median of the usable clips (black and blown ones left out)');
    check(projectTarget([at(0.2), at(0.25), at(0.3)]).luma === 0.32, 'a dim project is held to 0.32');
    check(projectTarget([at(0.7), at(0.75)]).luma === 0.5, 'a bright project is held to 0.5');
    check(projectTarget([]).luma === 0.4, 'default with no clip');
    check(correctionFilter(at(0.01)) === '', 'a black clip is not corrected');
  }

  console.log('still image, range and errors');
  {
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x8C7A8C:s=300x400', '-frames:v', '1', join(DIR, 'card.png')]);
    const s = await colourStats(join(DIR, 'card.png'));
    check(Math.abs(s.luma - 0.497) < 0.03 && tint(s) < -0.1, `a still is measured (${show(s)})`);
    const r = await colourStats(p('under'), { from: 0.5, to: 1.5 });
    check(Math.abs(r.luma - 0.25) < 0.03, `a range of a clip is measured (luma ${f3(r.luma)})`);
    const missing = await colourStats(join(DIR, 'nope.mp4')).then(() => false, () => true);
    check(missing, 'a missing file rejects');
  }
  console.log(`dev set (${DEVSET})`);
  if (!existsSync(join(DEVSET, 'truth.json'))) {
    console.log(`SKIP dev-set cases: ${DEVSET} not found (set DEVSET=<dir>)`);
  } else {
    const foot = (shop: string, clip: string) => join(DEVSET, 'footage', shop, `${clip}.mp4`);
    const def = (name: string) => join(DEVSET, 'defects', `${name}.mp4`);
    // Clean clips, each shop's six as one project: little change.
    const changes: Array<{ name: string; d: ReturnType<typeof pixelDiff> }> = [];
    for (const [shop, clips] of Object.entries(SHOPS)) {
      const pr = await project(clips.map((c) => foot(shop, c)));
      for (const c of clips) {
        const x = pr.clips.get(foot(shop, c))!;
        changes.push({ name: c, d: pixelDiff(x.after, x.before) });
      }
      console.log(`       ${shop}: target ${pr.luma}; ${clips.map((c, i) => `${c.replace(/^[a-z]+_\d+_/, '')} ${changes[changes.length - clips.length + i]!.d.stops.toFixed(2)}`).join(', ')} stop`);
    }
    const st = changes.map((c) => Math.abs(c.d.stops)), col = changes.map((c) => Math.max(Math.abs(c.d.temp), Math.abs(c.d.tint)));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    check(mean(st) <= 0.2 && Math.max(...st) <= 0.65, `clean clips in their shop's project: exposure moved ${mean(st).toFixed(2)} stop on average, at most ${Math.max(...st).toFixed(2)}`);
    check(mean(col) <= 0.05 && Math.max(...col) <= 0.2, `clean clips: colour moved ${mean(col).toFixed(3)} on average, at most ${Math.max(...col).toFixed(3)} (${changes[col.indexOf(Math.max(...col))]!.name})`);

    // Casts: each shop's project with that shop's cast copies added; compared with the clean original.
    for (const shop of Object.keys(SHOPS)) {
      const casts = CASTS.filter(([, base]) => base.startsWith(`${shop}/`));
      if (!casts.length) continue;
      const pr = await project([...SHOPS[shop]!.map((c) => foot(shop, c)), ...casts.map(([n]) => def(n))]);
      for (const [name, base, axis, strength] of casts) {
        const clean = pr.clips.get(foot(shop, base.split('/')[1]!))!.before;
        const x = pr.clips.get(def(name))!;
        const was = pixelDiff(x.before, clean)[axis], left = pixelDiff(x.after, clean)[axis];
        const keep = strength === 'mild' ? 0.4 : name.includes('warm') ? 0.75 : 0.7;
        check(Math.abs(left) <= keep * Math.abs(was) && left * was > -0.05 * Math.abs(was),
          `${name}: ${axis} ${was.toFixed(3)} → ${left.toFixed(3)} against the clean clip (at most ${Math.round(keep * 100)} % left, not past neutral)`);
      }
    }

    // Exposure: two takes of one scene 0.7 stop apart come closer; a clip a stop under is lifted.
    {
      const base = foot('bakery', 'bakery_02_kneading');
      const pr = await project([base, def('exposure_match_minus0.7stop'), def('exposure_match_plus0.7stop')]);
      const ref = pr.clips.get(base)!.after;
      for (const n of ['exposure_match_minus0.7stop', 'exposure_match_plus0.7stop']) {
        const x = pr.clips.get(def(n))!;
        const [was, left] = [pixelDiff(x.before, ref).stops, pixelDiff(x.after, ref).stops];
        check(Math.abs(left) <= 0.4 && Math.abs(left) < Math.abs(was) - 0.25, `${n} with its sibling: ${was.toFixed(2)} → ${left.toFixed(2)} stop`);
      }
      const under = def('underexposed_minus1stop'), slicing = foot('bakery', 'bakery_06_slicing');
      const pu = await project([...SHOPS.bakery!.map((c) => foot('bakery', c)), under]);
      const x = pu.clips.get(under)!, clean = pu.clips.get(slicing)!.before;
      const [was, left] = [pixelDiff(x.before, clean), pixelDiff(x.after, clean)];
      check(left.stops >= -0.5 && left.stops <= 0.1, `underexposed_minus1stop in the bakery project: ${was.stops.toFixed(2)} → ${left.stops.toFixed(2)} stop`);
      check(Math.abs(left.temp - was.temp) < 0.06 && Math.abs(left.tint - was.tint) < 0.06, `  its colour kept (${fd(left)})`);
    }
  }
} finally {
  await rm(DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
