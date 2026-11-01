// Evens out exposure and white balance across a user's own phone clips before a colour preset (tools.ts GRADES)
// is applied: shots filmed minutes apart come out a stop apart or tinted by the light they were shot in, and a
// reviewer reads a dark pinkish close-up between bright neutral shots as a mistake.
//
// colourStats() decodes three small frames a second (96x96 RGB, streamed; at most ~5 MB kept) and measures the
// mean luma, its 5th and 95th percentiles, and the colour of the light from mid-tone pixels (clipped highlights
// and near-black shadows left out). Plain grey-world reads a shop full of wood, bread, food and skin as a strong
// warm cast, so the light is taken from the near-grey mid-tones only (walls, counters, steel: (max-min)/max under
// 0.25); only when fewer than 5 % of pixels are near grey (a wall drowned in a strong cast) does it fall back to
// the grey-world mean of all mid-tones. Under a real cast the truly grey pixels are no longer near grey, so the
// first reading under-reads it (the dev set's cool cast of ln r/b −0.34 read −0.10, a strong green ln 0.31 read
// 0.18); grey is therefore judged once more under the light found, which reads them −0.21 and 0.31 and the
// warm casts at 95–100 % of their size. A second extra pass gained little on casts but walked warm scenes further
// toward their content (a dusk street 0.10 → 0.20 → 0.31), so there is one.
//
// correctionFilter() turns the stats into a lutrgb pass, plus a colorchannelmixer when the exposure changes.
// Phone white-balance errors are gains (one channel recorded a fixed share too high or low at every level), so
// the cast is undone with a gain per channel, the same ln offset in the shadows as in the mid-tones; a
// per-channel power curve is right only at the measured mid-tone and swings the shadows past neutral into the
// opposite colour. Near white each gain rolls off to 1 (out = y·e^(m·(1−y^p))), so a boosted channel never
// clips and a blown window stays white rather than tinted. The colour target is moved part of the way to
// neutral: green/magenta tint 85 %, a cool cast 75 %, a warm cast 75 % of what lies beyond a kept warmth (ln r/b
// 0.12) and at most ~20 %, each move at most ~30 %. Warmth is held back because the light reading cannot tell a
// warm cast from warm content: a shelf of bread on wood with no grey in view reads ln r/b 0.97, a strong warm
// cast 0.84.
//
// Exposure is a power curve y = x^k on all three channels alike: black and white stay put, nothing new clips,
// and a gain cast stays a gain cast. x^k also scales every colour's ratio to grey by k (a darkened clip turns
// more saturated, a lifted one washed out), which the colorchannelmixer undoes with a saturation of 1/k around
// luma (eq=saturation shifts neutral shadows green, the mixer keeps grey exactly grey). The mean luma moves
// toward the project's shared target, past a dead band that leaves ordinary scene-to-scene differences alone:
// a clip more than 0.2 stop darker is lifted 90 % of the rest, at most +0.8 stop (further mostly lifts noise,
// and a night shot should stay a night shot), and never by more than its highlights allow (p95 up to 0.8: a
// dark close-up of red roses has mean luma 0.19 but highlights at 0.65, so it is low-key, not underexposed); a
// clip more than 0.3 stop brighter gives up 70 % of the rest, at most 0.7 stop.
//
// Calibrated on the development set (30 phone clips of five shops, plus copies with known casts and exposure
// offsets; never the held-out benchmark): the clean clips' mean luma is 0.19–0.48 with project medians 0.33–0.40,
// so the target band is 0.32–0.50 (the old 0.42–0.52 lifted every clean clip of a dim shop by up to +0.68 stop).
// Their near-grey light reads ln r/b −0.09…+0.27 and tint −0.06…+0.05. Result (scripts/checks/colormatch-check.ts measures it
// pixel by pixel against the clean original): a clean clip in its own shop's project moves 0.12 stop on average
// (at most 0.56: the one clip a stop brighter than its siblings) and its colour by at most 0.11 (0.16 on the
// bread shelf); two takes of one scene 0.7 stop under and over end 0.23 and 0.35 stop off; the mild casts (warm
// ln r/b 0.19, magenta tint −0.16, green +0.13) are left at 0.04 / −0.01 / +0.01, the strong magenta −0.37 at
// −0.10 and the strong green +0.32 at +0.05; the cool cast −0.36 at −0.23; the medium and strong warm casts
// 0.39 / 0.69 at 0.19 / 0.47 (the cooling cap); a clip 1 stop under is brought to −0.33, 2 stops to −1.35.
import { spawn } from 'node:child_process';

/** Result of {@link colourStats}; every value is on a 0–1 scale (gamma-encoded, as stored). */
export interface ColourStats {
  /** Mean luma of the whole picture. */
  luma: number;
  /** Mean of each channel over the near-grey mid-tones (the light's colour); all equal to `luma` when unknown. */
  r: number;
  g: number;
  b: number;
  /** 5th and 95th percentile of luma. */
  p5: number;
  p95: number;
}

/** Analysis frame: each sampled frame is squeezed to this many pixels a side (aspect does not matter here). */
const BOX = 96;
/** Frames sampled per second, and at most this many seconds are read. */
const FPS = 3;
const MAX_SECONDS = 60;
const TIMEOUT_MS = 60_000;
/** A mid-tone pixel: luma inside these bounds and no channel clipped. */
const MID_LO = 0.1;
const MID_HI = 0.9;
const CHANNEL_LO = 0.02;
const CHANNEL_HI = 0.97;
/** A near-grey pixel: (max - min) / max under this. */
const GREY_CHROMA = 0.25;
/** Share of all pixels a set must cover to be trusted for the light's colour. */
const MIN_SHARE = 0.05;

/** Default target mean luma, and the band a project's shared target is held to. */
const TARGET_LUMA = 0.4;
const TARGET_LO = 0.32;
const TARGET_HI = 0.5;
/** A clip darker than the target by more than LIFT_FROM stops is lifted LIFT_SHARE of the rest, at most
 *  MAX_LIFT, and at most as far as takes its 95th percentile to HEADROOM. */
const LIFT_FROM = 0.2;
const LIFT_SHARE = 0.9;
const MAX_LIFT = 0.8;
const HEADROOM = 0.8;
/** A clip brighter than the target by more than DROP_FROM stops loses DROP_SHARE of the rest, at most MAX_DROP. */
const DROP_FROM = 0.3;
const DROP_SHARE = 0.7;
const MAX_DROP = 0.7;
/** Exposure moves smaller than this many stops are not worth a re-render. */
const MIN_STOPS = 0.1;
/** Share of a green/magenta tint taken out; share of a cool cast, and of a warm cast beyond WARM_KEEP. */
const TINT_STRENGTH = 0.85;
const TEMP_STRENGTH = 0.75;
/** Warmth (ln r/b of the light) that is always kept, and the most a warm cast is cooled, in ln units. */
const WARM_KEEP = 0.12;
const MAX_COOLING = 0.2;
/** Largest temperature or tint move in ln units (about ±30 %). */
const MAX_CAST_MOVE = 0.3;
/** Smallest temperature / tint move applied, in ln units (tint shows sooner than warmth). */
const MIN_TEMP_MOVE = 0.025;
const MIN_TINT_MOVE = 0.025;
/** Bounds on the exposure exponent: below 0.7 the curve lifts the shadows (and their noise) steeply. */
const MIN_EXPONENT = 0.7;
const MAX_EXPONENT = 1.4;
/** Largest gain on one channel, in ln units (about ±25 %). */
const MAX_GAIN = 0.25;
/** Highlight roll-off: the gain fades as y^p near white, p = ROLLOFF / largest boost (keeps the curve rising). */
const ROLLOFF = 0.85;
const MAX_P = 10;
/** Pictures darker than this are black (a slate, a lens cap) and are not corrected. */
const BLACK_LUMA = 0.03;

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/**
 * Exposure and white-balance statistics of a clip or still (or of `from`..`to` seconds of a clip): three frames
 * a second, at most 60 s, each squeezed to 96x96. `luma` is the mean luma, `p5`/`p95` its percentiles, and
 * `r`/`g`/`b` the colour of the light, from the near-grey mid-tones (grey-world over all mid-tones when too
 * few pixels are near grey), with grey judged a second time under the light the first pass found. Rejects if
 * ffmpeg fails, yields no frame, or runs over 60 s.
 */
export async function colourStats(file: string, opts?: { from?: number; to?: number }): Promise<ColourStats> {
  if (!file) throw new Error('colourStats: missing file');
  const from = Math.max(0, opts?.from ?? 0);
  const span = opts?.to != null ? Math.max(0.05, opts.to - from) : MAX_SECONDS;
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...(from > 0 ? ['-ss', from.toFixed(3)] : []),
    '-protocol_whitelist', 'file,pipe', '-i', file,
    '-t', String(Math.min(span, MAX_SECONDS)), '-map', '0:v:0', '-an', '-sn', '-dn',
    // eof_action=pass keeps the single frame of a still image.
    '-vf', `fps=${FPS}:eof_action=pass,scale=${BOX}:${BOX}:flags=area,format=rgb24`,
    '-f', 'rawvideo', 'pipe:1',
  ];
  const hist = new Float64Array(256);
  let sum = 0;
  let px = 0;
  // The mid-tone pixels are kept (at most 180 frames of 96x96, 5 MB) for the light's two passes.
  const kept: Buffer[] = [];
  const onBytes = (d: Buffer, end: number) => {
    const mid = Buffer.allocUnsafe(end);
    let n = 0;
    for (let i = 0; i < end; i += 3) {
      const r = d[i]! / 255, g = d[i + 1]! / 255, b = d[i + 2]! / 255;
      const y = LR * r + LG * g + LB * b;
      sum += y;
      hist[Math.min(255, Math.round(y * 255))]!++;
      px++;
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
      if (y < MID_LO || y > MID_HI || hi > CHANNEL_HI || lo < CHANNEL_LO) continue;
      mid[n++] = d[i]!; mid[n++] = d[i + 1]!; mid[n++] = d[i + 2]!;
    }
    if (n) kept.push(mid.subarray(0, n));
  };

  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let carry: Buffer = Buffer.alloc(0);
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, TIMEOUT_MS);
    p.stdout.on('data', (d: Buffer) => {
      // Whole pixels only; a pixel split across chunks waits for the next one.
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const end = buf.length - (buf.length % 3);
      onBytes(buf, end);
      carry = buf.subarray(end);
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
      if (timedOut) reject(new Error(`色彩统计超时（ffmpeg 超过 ${TIMEOUT_MS / 1000} 秒未完成）`));
      else if (code !== 0) reject(new Error(`色彩统计失败：ffmpeg exited ${code}: ${err.slice(-600)}`));
      else resolve();
    });
  });
  if (!px) throw new Error('色彩统计失败：读不到画面');

  const pct = (q: number) => {
    let seen = 0;
    for (let k = 0; k < 256; k++) if ((seen += hist[k]!) >= q * px) return k / 255;
    return 1;
  };
  const luma = sum / px;
  /** Mean colour of the near-grey mid-tones, grey judged after scaling each channel by `gain` (the light found
   *  so far undone); the mean of all mid-tones when too few are near grey; null when even those are too few. */
  const lightOf = (gain: readonly [number, number, number]): [number, number, number] | null => {
    const mid = [0, 0, 0, 0];
    const grey = [0, 0, 0, 0];
    for (const buf of kept) {
      for (let i = 0; i < buf.length; i += 3) {
        const r = buf[i]!, g = buf[i + 1]!, b = buf[i + 2]!;
        mid[0] += r; mid[1] += g; mid[2] += b; mid[3]++;
        const a = r * gain[0], c = g * gain[1], e = b * gain[2];
        const hi = Math.max(a, c, e);
        if (hi > 0 && (hi - Math.min(a, c, e)) / hi < GREY_CHROMA) { grey[0] += r; grey[1] += g; grey[2] += b; grey[3]++; }
      }
    }
    const set = grey[3]! >= MIN_SHARE * px ? grey : mid[3]! >= MIN_SHARE * px ? mid : null;
    return set ? [set[0]! / set[3]! / 255, set[1]! / set[3]! / 255, set[2]! / set[3]! / 255] : null;
  };
  let light = lightOf([1, 1, 1]);
  if (light) {
    const m = (light[0] + light[1] + light[2]) / 3;
    light = lightOf([m / light[0], m / light[1], m / light[2]]) ?? light;
  }
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return {
    luma: round(luma),
    r: round(light ? light[0] : luma),
    g: round(light ? light[1] : luma),
    b: round(light ? light[2] : luma),
    p5: round(pct(0.05)),
    p95: round(pct(0.95)),
  };
}

/**
 * A shared exposure target for the user's clips in one project: the median mean-luma of the clips that are
 * neither black nor nearly white, held to 0.32–0.50 so a project shot mostly in dim rooms or against bright
 * windows is not pushed toward its own extreme. With no usable clip, the default 0.40.
 */
export function projectTarget(stats: ColourStats[]): { luma: number } {
  const l = stats.map((s) => s.luma).filter((v) => v > 0.08 && v < 0.85).sort((a, b) => a - b);
  if (!l.length) return { luma: TARGET_LUMA };
  const m = l.length % 2 ? l[(l.length - 1) / 2]! : (l[l.length / 2 - 1]! + l[l.length / 2]!) / 2;
  return { luma: Math.round(clamp(m, TARGET_LO, TARGET_HI) * 1000) / 1000 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * An ffmpeg filter chain (a lutrgb, plus a colorchannelmixer when the exposure changes; no quotes or escaping)
 * that evens out a clip measured by {@link colourStats}. Exposure: one power curve on all channels (its
 * saturation change undone by the mixer) moves the mean luma toward `target.luma` (default 0.40; pass
 * {@link projectTarget} so a project's clips match each other): a clip more than 0.2 stop darker is lifted 90 %
 * of the rest, at most +0.8 stop and no further than its 95th percentile reaching 0.8; a clip more than 0.3 stop
 * brighter gives up 70 % of the rest, at most 0.7 stop. Colour: a gain per channel (equal at every level, fading
 * to none at white) takes out 85 % of a green/magenta tint, 75 % of a cool cast, and 75 % of a warm cast beyond
 * a kept warmth but at most ~20 %, so warm-lit places stay warm. Returns '' when the clip is within tolerance
 * (or black).
 */
export function correctionFilter(stats: ColourStats, target?: { luma?: number }): string {
  const L = stats.luma;
  if (!(L >= BLACK_LUMA) || !(stats.r > 0 && stats.g > 0 && stats.b > 0)) return '';
  const T = clamp(target?.luma ?? TARGET_LUMA, 0.2, 0.7);

  // Exposure, in stops of linear light (stored values are ~gamma 2.2).
  const off = 2.2 * Math.log2(T / L);
  // A lift goes no further than the highlights allow: a low-key picture with bright parts is not underexposed.
  const headroom = 2.2 * Math.log2(HEADROOM / Math.max(0.05, stats.p95));
  let stops = off > 0
    ? Math.min(MAX_LIFT, LIFT_SHARE * Math.max(0, Math.min(off, headroom) - LIFT_FROM))
    : -Math.min(MAX_DROP, DROP_SHARE * Math.max(0, -off - DROP_FROM));
  if (Math.abs(stops) < MIN_STOPS) stops = 0;

  // The exposure curve y = x^k takes the mean luma L to L·2^(stops/2.2).
  const ln = (v: number) => Math.log(clamp(v, 0.03, 0.97));
  const k = stops ? Math.round(clamp(1 + (Math.log(2) * stops) / 2.2 / ln(L), MIN_EXPONENT, MAX_EXPONENT) * 1000) / 1000 : 1;
  const lr = ln(stats.r), lg = ln(stats.g), lb = ln(stats.b);
  // The light's colour in ln units: temperature (r over b, warm positive) and tint (g over r·b, magenta negative).
  const temp = lr - lb;
  const tint = lg - (lr + lb) / 2;
  let dTemp = temp < 0 ? -TEMP_STRENGTH * temp : -Math.min(MAX_COOLING, TEMP_STRENGTH * Math.max(0, temp - WARM_KEEP));
  let dTint = -TINT_STRENGTH * tint;
  dTemp = clamp(dTemp, -MAX_CAST_MOVE, MAX_CAST_MOVE);
  dTint = clamp(dTint, -MAX_CAST_MOVE, MAX_CAST_MOVE);
  if (Math.abs(dTemp) < MIN_TEMP_MOVE) dTemp = 0;
  if (Math.abs(dTint) < MIN_TINT_MOVE) dTint = 0;
  if (k === 1 && !dTemp && !dTint) return '';

  // Per-channel gains (ln units) that change temperature by dTemp and tint by dTint at unchanged luma.
  let gr = dTemp / 2 - dTint / 3, gb = -dTemp / 2 - dTint / 3, gg = (2 * dTint) / 3;
  const keep = LR * gr + LG * gg + LB * gb;
  // x^k scales ln ratios to grey by k and the mixer after it by 1/k, so a gain inside the curve is applied k-fold.
  [gr, gg, gb] = [gr - keep, gg - keep, gb - keep].map((m) => k * clamp(m, -MAX_GAIN, MAX_GAIN)) as [number, number, number];
  // ln out = k·ln x + m·(1 − y^p): the full gain m below the highlights, none at white. ln out keeps rising with
  // x as long as m·p < 1, so a boosted channel rolls into white instead of clipping.
  const p = Math.min(MAX_P, ROLLOFF / Math.max(0.01, gr, gg, gb));
  const num = (v: number) => v.toFixed(4).replace(/\.?0+$/, '');
  const curve = (m: number) => {
    const y = k === 1 ? 'log(val/maxval)' : `${num(k)}*log(val/maxval)`;
    if (Math.abs(m) < 0.002) return k === 1 ? 'val' : `maxval*exp(${y})`;
    return `maxval*exp(${y}${m < 0 ? '-' : '+'}${num(Math.abs(m))}*(1-exp(${num(p)}*${y})))`;
  };
  const lut = `lutrgb=r=${curve(gr)}:g=${curve(gg)}:b=${curve(gb)}`;
  if (k === 1) return lut;
  // Saturation s around luma: out = Y + s·(in − Y), each row summing to 1 so greys stay exactly grey.
  const sat = 1 / k;
  const w = { r: LR, g: LG, b: LB };
  const mix = (['r', 'g', 'b'] as const).flatMap((o) =>
    (['r', 'g', 'b'] as const).map((i) => `${o}${i}=${num((1 - sat) * w[i] + (o === i ? sat : 0))}`));
  return `${lut},colorchannelmixer=${mix.join(':')}`;
}
