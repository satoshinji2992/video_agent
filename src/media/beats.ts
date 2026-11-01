// Beat grid of a music track and cut snapping, so shots change on the music instead of every 3–4 s by the
// clock. Reviewers called our edits "mechanical": the cuts ignored the beat and every shot ran the same length.
//
// beatGrid() streams the track through ffmpeg as mono 11025 Hz float PCM into an onset-strength envelope: log
// spectral flux over 36 log-spaced bands (46 ms Hann window every 5.8 ms, compared with the frame 17 ms
// earlier), plus a separate bass (<250 Hz) flux. The tempo is an autocorrelation peak of the envelope in
// 60–180 BPM, chosen in two steps (see estimatePeriod): first the metrical family, using the correlation at
// the beat's multiples up to a bar and at the eighth note to tell the beat from dotted rhythms (3-3-2 house
// and trap, and a backbeat's kick on the 'and' of 3, which correlates at 1.5 beats more strongly than at the
// beat), then the octave, preferring 80–140 BPM. Produced BGM runs at one tempo, so the beats are a rigid grid fitted over the whole track
// (period and phase that collect the most onset strength, bass counted twice since the kick marks the beat);
// a beat tracker (Ellis' dynamic programme) drifted half a beat in every breakdown full of off-beat stabs.
// The tracker still wins for music whose tempo moves. Every 4th beat is a downbeat, at the phase whose beats
// carry the strongest bass onsets.
//
// confidence (0–1) combines how strongly the envelope repeats at the beat period with how sharply the
// grid's folded envelope peaks, above the chance level of grids at unrelated periods. Click tracks and the
// installed BGM come out at 0.86–1, ambient pads and random hits under 0.2; under 0.2 no grid is returned.
//
// snapCuts() moves the planned cut points onto beats by dynamic programming over candidate positions (the
// beats within `tolerance` of each planned cut, and a 50 ms grid of unsnapped positions so a plan always
// stays feasible), keeping every shot inside its [min, max]. It also tries starting the music at each of its
// first few beats and keeps the start that lands the most cuts. Nothing is cached here: the skills folder is
// read-only, so the caller keeps the grid.
//
// Calibrated on synthetic click tracks (beats within 5 ms), rock, drum-and-bass, four-on-the-floor and 3-3-2
// patterns at 60–180 BPM, and the five installed BGM tracks, whose grids were checked by eye on waveform,
// low-passed waveform and spectrogram sheets with the beats drawn on.
import { spawn } from 'node:child_process';

const SR = 11025;
/** FFT window (46 ms) and hop (5.8 ms, ~172 envelope frames a second). */
const N = 512;
const HOP = 64;
const FPS = SR / HOP;
/** Spectral flux compares each frame with the one this many hops earlier (17 ms). */
const FLUX_LAG = 3;
/** Bands below this frequency make the bass envelope (kick), used for placing beats and finding the downbeat. */
const BASS_HZ = 250;
/** Log-spaced bands from BAND_LO_HZ to Nyquist, and the gain before log compression. */
const BANDS = 36;
const BAND_LO_HZ = 30;
const GAMMA = 100;
/** The bass flux is added to the full-band flux at this weight for placing beats. */
const BASS_WEIGHT = 1;
/**
 * Where an onset lands in the envelope relative to the sound, in seconds: the flux of a centred window rises
 * as soon as the hit enters its leading edge, so the peak comes early. Measured on synthetic clicks.
 */
const LATENCY = 0.003;
const MIN_BPM = 60;
const MAX_BPM = 180;
/** Tempi in this range are taken as they are; outside it they lose to their octave inside it. */
const PREFER_LO = 80;
const PREFER_HI = 140;
/** Ellis' tightness: how strongly the beat tracker holds the period against off-grid onsets. */
const TIGHTNESS = 400;
/** Outside PREFER_LO–PREFER_HI a tempo's weight falls off as a Gaussian of this many octaves. */
const PRIOR_WIDTH = 0.3;
/** Weight of the eighth-note correlation (half the lag) when choosing the tempo family. */
const SUBDIVISION = 0.5;
/** A candidate beat's family score averages the correlation at 1..METER times its lag (up to a 4/4 bar). */
const METER = 4;
/** The constant grid is kept unless the free tracker's beats sit on onsets more than 1/0.8 times as strong. */
const GRID_SHARE = 0.8;
/** Periods, as multiples of the beat, whose grids measure the chance level of the fold's clarity. */
const NULL_RATIOS = [0.81, 0.89, 1.12, 1.23];
/** Below this the music has no usable pulse and no grid is returned. */
const MIN_CONFIDENCE = 0.2;
const TIMEOUT_MS = 60_000;

/** Result of {@link beatGrid}. */
export interface BeatGrid {
  /** Tempo in beats per minute (one decimal), or null when the music has no clear pulse. */
  bpm: number | null;
  /** Beat times in seconds from the start of the file (empty when bpm is null). */
  beats: number[];
  /** Every 4th beat, the first beat of each bar. */
  downbeats: number[];
  /** 0–1: how clear the pulse is. Click tracks and drum-led BGM score high, ambient pads near 0. */
  confidence: number;
}

/** In-place radix-2 complex FFT of size N. */
const fft = (() => {
  const levels = Math.log2(N);
  const rev = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(N / 2);
  const sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N);
    sin[i] = -Math.sin((2 * Math.PI * i) / N);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!; re[i] = re[j]!; re[j] = t;
        t = im[i]!; im[i] = im[j]!; im[j] = t;
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k;
          const b = a + half;
          const wr = cos[k * step]!;
          const wi = sin[k * step]!;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  };
})();

/**
 * Onset envelopes of the first `maxSeconds` of `file`: full-band and bass spectral flux, one value per HOP
 * samples, frame k centred on sample k*HOP. Streams the decoded samples; nothing but the envelopes is kept.
 */
function onsetEnvelope(file: string, maxSeconds: number): Promise<{ full: Float64Array; bass: Float64Array; frames: number }> {
  // Log-spaced bands, so the kick's octave counts as much as the hi-hat's dozens of bins.
  const edges: number[] = [1];
  for (let k = 1; k <= BANDS; k++) {
    const hz = BAND_LO_HZ * (SR / 2 / BAND_LO_HZ) ** (k / BANDS);
    const bin = Math.min(N / 2 + 1, Math.round((hz * N) / SR));
    if (bin > edges[edges.length - 1]!) edges.push(bin);
  }
  const bands = edges.length - 1;
  const bassBands = edges.findIndex((e) => (e * SR) / N > BASS_HZ);
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  // The last FLUX_LAG + 1 log band spectra, as references for the flux.
  const history = Array.from({ length: FLUX_LAG + 1 }, () => new Float64Array(bands));
  const cap = Math.ceil((maxSeconds * SR) / HOP) + 4;
  const full = new Float64Array(cap);
  const bass = new Float64Array(cap);
  let frames = 0;
  // Samples not yet consumed, starting N/2 zeros early so frame 0 is centred on sample 0.
  let buf = new Float32Array(N / 2 + 65536);
  let have = N / 2;

  const onFrame = (at: number) => {
    for (let i = 0; i < N; i++) {
      re[i] = buf[at + i]! * hann[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const cur = history[frames % history.length]!;
    for (let k = 0; k < bands; k++) {
      let e = 0;
      for (let b = edges[k]!; b < edges[k + 1]!; b++) e += re[b]! * re[b]! + im[b]! * im[b]!;
      // Magnitude scaled so a full-scale sine reads 1, then log-compressed.
      cur[k] = Math.log1p(GAMMA * Math.sqrt(e / (edges[k + 1]! - edges[k]!)) / (N / 4));
    }
    const ref = history[(frames + 1) % history.length]!; // FLUX_LAG frames back
    let f = 0;
    let lo = 0;
    if (frames >= FLUX_LAG) {
      for (let k = 0; k < bands; k++) {
        const d = cur[k]! - ref[k]!;
        if (d > 0) {
          f += d;
          if (k < bassBands) lo += d;
        }
      }
    }
    if (frames < cap) {
      full[frames] = f;
      bass[frames] = lo;
    }
    frames++;
  };

  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', file,
      '-t', String(maxSeconds), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending: Buffer = Buffer.alloc(0);
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.stdout.on('data', (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      const count = pending.length >> 2;
      if (have + count > buf.length) {
        const next = new Float32Array(Math.max(buf.length, (have + count) * 2));
        next.set(buf.subarray(0, have));
        buf = next;
      }
      for (let i = 0; i < count; i++) buf[have + i] = pending.readFloatLE(i * 4);
      have += count;
      pending = pending.subarray(count * 4);
      let at = 0;
      for (; at + N <= have; at += HOP) onFrame(at);
      buf.copyWithin(0, at, have);
      have -= at;
    });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`节拍分析超时（ffmpeg 超过 ${TIMEOUT_MS / 1000} 秒未完成）`));
      else if (code !== 0) reject(new Error(`节拍分析失败：ffmpeg exited ${code}: ${err.slice(-600)}`));
      else {
        const n = Math.min(frames, cap);
        resolve({ full: full.subarray(0, n), bass: bass.subarray(0, n), frames: n });
      }
    });
  });
}

/** `x` minus its moving average over `win` frames, negative values clipped, scaled to unit standard deviation. */
function detrend(x: Float64Array, win: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + x[i]!;
  const h = Math.floor(win / 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(n, i + h + 1);
    out[i] = Math.max(0, x[i]! - (prefix[b]! - prefix[a]!) / (b - a));
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += out[i]! * out[i]!;
  const sd = Math.sqrt(ss / Math.max(1, n));
  if (sd > 0) for (let i = 0; i < n; i++) out[i] = out[i]! / sd;
  return out;
}

/**
 * Unbiased autocorrelation of the mean-removed `x`: `acf` for lags 0..maxLag, and `corr` for any longer lag,
 * computed on demand (the metrical check needs a few lags up to a bar, not every lag up to 4 s).
 */
function autocorr(x: Float64Array, maxLag: number): { acf: Float64Array; corr: (lag: number) => number } {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= n;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i]! - mean;
  const lagCorr = (lag: number) => {
    if (lag < 0 || lag >= n) return 0;
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += y[i]! * y[i + lag]!;
    return s / (n - lag);
  };
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) acf[lag] = lagCorr(lag);
  const memo = new Map<number, number>();
  const corr = (lag: number) => {
    if (lag <= maxLag) return lag >= 0 ? acf[lag]! : 0;
    let v = memo.get(lag);
    if (v === undefined) memo.set(lag, (v = lagCorr(lag)));
    return v;
  };
  return { acf, corr };
}

/** Linear interpolation of `a` at fractional index `x`. */
const at = (a: Float64Array, x: number) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return i >= 0 && i < a.length ? a[i]! : 0;
  return a[i]! + (a[i + 1]! - a[i]!) * (x - i);
};

/** Weight of a tempo: 1 inside PREFER_LO–PREFER_HI, falling off by octave distance outside. */
function tempoPrior(bpm: number) {
  const d = bpm < PREFER_LO ? Math.log2(PREFER_LO / bpm) : bpm > PREFER_HI ? Math.log2(bpm / PREFER_HI) : 0;
  return Math.exp(-0.5 * (d / PRIOR_WIDTH) ** 2);
}

/**
 * Beat period in frames (fractional) from the autocorrelation (`acf` up to the 60 BPM lag, `corr` beyond), or
 * null when it has no peak in range.
 *
 * Two steps. First the metrical family: each local maximum in 60–180 BPM is scored by the mean correlation
 * at 1, 2, 3 and 4 times its lag (a real beat repeats at every multiple up to the bar) plus half the
 * correlation at half its lag (the eighth notes under a real beat), weighted towards 80–140 BPM. Dotted
 * periods peak on their own but fail at their multiples: house and trap 3-3-2 patterns correlate at 2/3 of
 * the beat about as strongly as the beat itself, and a rock backbeat (kick on 1 and the 'and' of 3, snare on
 * 2 and 4) more strongly at 1.5 beats than at the beat, but 4.5 beats is no bar line. Then the octave: the
 * winner, its double and its half compete on their own correlation alone, with the same weighting, since
 * the eighth-note term would otherwise favour half the tempo whenever the beat itself is the subdivision.
 */
function estimatePeriod(acf: Float64Array, corr: (lag: number) => number): number | null {
  const lo = Math.floor((60 * FPS) / MAX_BPM);
  const hi = Math.ceil((60 * FPS) / MIN_BPM);
  const peak = (lag: number) => lag >= 1 && lag + 1 < acf.length && acf[lag]! >= acf[lag - 1]! && acf[lag]! >= acf[lag + 1]!;
  // Mean correlation at the lag's multiples, each taken as the best within a window that widens with the
  // multiple (the integer lag's rounding error grows with it).
  const metric = (lag: number) => {
    let sum = 0;
    for (let k = 1; k <= METER; k++) {
      let m = 0;
      const r = Math.ceil(k / 2);
      for (let d = -r; d <= r; d++) m = Math.max(m, corr(Math.round(k * lag) + d));
      sum += m;
    }
    return sum / METER;
  };
  let best = -Infinity;
  let family = 0;
  for (let lag = lo; lag <= hi; lag++) {
    if (!peak(lag)) continue;
    const s = (metric(lag) + SUBDIVISION * Math.max(0, at(acf, lag / 2))) * tempoPrior((60 * FPS) / lag);
    if (s > best) { best = s; family = lag; }
  }
  if (!family || best <= 0) return null;
  let bestLag = family;
  let top = acf[family]! * tempoPrior((60 * FPS) / family);
  for (const target of [family / 2, family * 2]) {
    if (target < lo || target > hi) continue;
    // The local maximum nearest the exact octave.
    let lag = Math.round(target);
    for (const d of [0, -1, 1, -2, 2]) if (peak(Math.round(target) + d)) { lag = Math.round(target) + d; break; }
    const v = acf[lag]! * tempoPrior((60 * FPS) / lag);
    if (v > top) { top = v; bestLag = lag; }
  }
  // Parabolic interpolation of the peak.
  const a = acf[bestLag - 1]!, b = acf[bestLag]!, c = acf[bestLag + 1]!;
  const den = a - 2 * b + c;
  const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return bestLag + off;
}

/** Ellis' dynamic-programming beat tracker over the local score `s` with period `period` frames; beat positions in frames, trimmed. */
function trackBeats(s: Float64Array, period: number): number[] {
  const n = s.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = -TIGHTNESS * Math.log(d / period) ** 2;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi && d <= t; d++) {
      const v = score[t - d]! + penalty[d]!;
      if (v > best) { best = v; arg = t - d; }
    }
    // A beat may also start the chain fresh (the first beat, or after silence).
    if (arg >= 0 && best > 0) { score[t] = s[t]! + best; back[t] = arg; } else score[t] = s[t]!;
  }
  // Last beat: the best-scoring frame among the final period's local maxima of the score.
  let end = -1;
  for (let t = Math.max(1, n - Math.ceil(period)); t < n - 1; t++) {
    if (score[t]! >= score[t - 1]! && score[t]! >= score[t + 1]! && (end < 0 || score[t]! > score[end]!)) end = t;
  }
  if (end < 0) end = n - 1;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) beats.push(t);
  beats.reverse();
  // Sub-frame position from the parabola through the local score around each beat frame.
  return trim(s, beats.map((f) => {
    const a = s[f - 1] ?? 0, b = s[f]!, c = s[f + 1] ?? 0;
    const den = a - 2 * b + c;
    return f + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
  }));
}

/** `beats` (frames) without the leading and trailing ones in silence: local score below a third of the median beat's. */
function trim(s: Float64Array, beats: number[]): number[] {
  const v = beats.map((f) => peakNear(s, Math.round(f), 2));
  const sorted = [...v].sort((x, y) => x - y);
  const floor = sorted.length ? 0.3 * sorted[sorted.length >> 1]! : 0;
  let a = 0;
  let z = beats.length;
  while (a < z && v[a]! < floor) a++;
  while (z > a && v[z - 1]! < floor) z--;
  return beats.slice(a, z);
}

/**
 * The constant-tempo grid that best fits the local score: periods within 1.5% of `period` are tried (every 0.1
 * frame, then every 0.01 frame around the best), the score folded modulo each period, and the phase taken at
 * the fold's peak. `clarity` is how far that peak stands above the fold's mean (0 for a flat fold).
 */
function fitGrid(s: Float64Array, period: number): { period: number; beats: number[]; clarity: number } {
  let best = { period, phase: 0, peak: -Infinity, clarity: 0 };
  const bins = Math.ceil(period * 1.02) + 2;
  const fold = new Float64Array(bins);
  const count = new Float64Array(bins);
  const tryPeriod = (p: number) => {
    fold.fill(0);
    count.fill(0);
    for (let t = 0; t < s.length; t++) {
      const k = Math.floor(t % p);
      fold[k] += s[t]!;
      count[k]++;
    }
    const n = Math.floor(p);
    for (let k = 0; k < n; k++) fold[k] = fold[k]! / Math.max(1, count[k]!);
    let mean = 0;
    for (let k = 0; k < n; k++) mean += fold[k]!;
    mean /= n;
    for (let k = 0; k < n; k++) {
      // Peak over 3 neighbouring bins, so a peak split across two bins is not undercounted.
      const v = (fold[(k + n - 1) % n]! + 2 * fold[k]! + fold[(k + 1) % n]!) / 4;
      if (v > best.peak) best = { period: p, phase: k, peak: v, clarity: mean > 0 ? v / mean - 1 : 0 };
    }
  };
  for (let p = period * 0.985; p <= period * 1.015; p += 0.1) tryPeriod(p);
  const coarse = best.period;
  for (let p = coarse - 0.1; p <= coarse + 0.1 + 1e-9; p += 0.01) tryPeriod(p);
  // Sub-frame phase: the offset within ±0.5 frame where the grid collects the most score.
  let phase = best.phase;
  let top = -Infinity;
  for (let d = -0.5; d <= 0.5; d += 0.05) {
    let sum = 0;
    for (let t = best.phase + d; t < s.length; t += best.period) sum += at(s, t);
    if (sum > top) { top = sum; phase = best.phase + d; }
  }
  const beats: number[] = [];
  for (let t = phase; t < s.length; t += best.period) if (t >= 0) beats.push(t);
  return { period: best.period, beats, clarity: best.clarity };
}

/** Lets other requests run between the analysis steps (each takes up to ~20 ms on two minutes of music). */
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Gaussian smoothing with standard deviation `sigma` frames. */
function smooth(x: Float64Array, sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) {
      const v = x[i + j];
      if (v !== undefined) s += v * k[j + r]!;
    }
    out[i] = s;
  }
  return out;
}

/** Largest value of `x` within `r` frames of `i`. */
const peakNear = (x: Float64Array, i: number, r: number) => {
  let m = 0;
  for (let j = Math.max(0, i - r); j <= Math.min(x.length - 1, i + r); j++) m = Math.max(m, x[j]!);
  return m;
};

const NO_GRID: BeatGrid = { bpm: null, beats: [], downbeats: [], confidence: 0 };

/**
 * Beat grid of a music file's first `maxSeconds` (default 120): tempo, beat and downbeat times in seconds,
 * and how clear the pulse is. Tempo is searched in 60–180 BPM and folded into 80–140 when an octave of it
 * fits as well (a 170 BPM track reads as 85). When the pulse is too weak to cut to (confidence below 0.2:
 * ambient pads, speech, silence) bpm is null and no beats are returned. Pure: the caller caches the result.
 * Rejects if ffmpeg cannot decode the file or runs over 60 s.
 */
export async function beatGrid(file: string, opts?: { maxSeconds?: number }): Promise<BeatGrid> {
  if (!file) throw new Error('beatGrid: missing file');
  const maxSeconds = Math.min(600, Math.max(4, opts?.maxSeconds ?? 120));
  const { full, bass, frames } = await onsetEnvelope(file, maxSeconds);
  if (frames < 4 * FPS) return NO_GRID;
  const env = detrend(full, Math.round(0.4 * FPS));
  if (!env.some((v) => v > 0)) return NO_GRID;
  await yieldLoop();
  const { acf, corr } = autocorr(env, Math.ceil((60 * FPS) / MIN_BPM) + 4);
  if (!(acf[0]! > 0)) return NO_GRID;
  const period = estimatePeriod(acf, corr);
  if (!period) return NO_GRID;

  // Beats follow the full-band onsets plus the bass ones: in pop, EDM and hip-hop the kick marks the beat,
  // while loud off-beat hi-hats or stabs would otherwise pull the grid half a beat off.
  const bassEnv = detrend(bass, Math.round(0.4 * FPS));
  const mixed = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) mixed[i] = env[i]! + BASS_WEIGHT * bassEnv[i]!;
  const local = smooth(mixed, period / 32);

  // Produced music runs at one tempo, so a rigid grid fitted over the whole track keeps the beat through
  // breakdowns full of off-beat stabs, where a beat tracker drifts half a beat. The tracker is kept for music
  // whose tempo moves: when its beats sit on clearly stronger onsets than the grid's, it wins.
  await yieldLoop();
  const grid = fitGrid(local, period);
  await yieldLoop();
  const tracked = trackBeats(local, period);
  const strength = (pos: number[]) => pos.reduce((acc, f) => acc + peakNear(local, Math.round(f), 2), 0) / Math.max(1, pos.length);
  const gridPos = trim(local, grid.beats);
  const useGrid = gridPos.length >= 4 && strength(gridPos) >= GRID_SHARE * strength(tracked);
  const pos = useGrid ? gridPos : tracked;
  if (pos.length < 4) return NO_GRID;
  const times = pos.map((f) => Math.max(0, f / FPS + LATENCY));

  // Tempo: the grid's period, or the least-squares slope of the tracked beat times over beat number (numbers
  // from the median gap, so a skipped beat does not bend the fit).
  let beatSeconds = grid.period / FPS;
  if (!useGrid) {
    const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((x, y) => x - y);
    const med = gaps[gaps.length >> 1]!;
    const idx = times.map((t) => Math.round((t - times[0]!) / med));
    const mi = idx.reduce((x, y) => x + y, 0) / idx.length;
    const mt = times.reduce((x, y) => x + y, 0) / times.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < times.length; i++) { sxy += (idx[i]! - mi) * (times[i]! - mt); sxx += (idx[i]! - mi) ** 2; }
    beatSeconds = sxx > 0 ? sxy / sxx : med;
  }

  // Confidence: how strongly the envelope repeats at the beat period (normalised autocorrelation; pads and
  // random hits stay under 0.15, the installed BGM 0.45–0.75) and how far the folded grid's peak stands
  // above its mean (pads under 0.3, sparse random hits up to ~1.2, BGM 2.4–4, clicks 7–10).
  const rho = Math.max(0, at(acf, period) / acf[0]!);
  const ramp = (x: number, a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));
  // The fold of a short or sparse signal has chance peaks at any period, so its clarity is measured against
  // the median clarity of grids at unrelated periods (no small-integer ratio to the beat).
  const chance: number[] = [];
  for (const r of NULL_RATIOS) {
    await yieldLoop();
    chance.push(fitGrid(local, period * r).clarity);
  }
  chance.sort((x, y) => x - y);
  const clarity = grid.clarity - (chance[1]! + chance[2]!) / 2;
  const confidence = Math.round((0.5 * ramp(rho, 0.1, 0.5) + 0.5 * ramp(clarity, 0.5, 2.5)) * 100) / 100;
  if (confidence < MIN_CONFIDENCE) return { ...NO_GRID, confidence };

  // Downbeat phase: which of the 4 beat positions carries the strongest bass (then full-band) onsets.
  let phase = 0;
  let bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    let sum = 0, k = 0;
    for (let i = p; i < pos.length; i += 4) {
      sum += peakNear(bassEnv, Math.round(pos[i]!), 3) + 0.5 * peakNear(env, Math.round(pos[i]!), 2);
      k++;
    }
    const v = k ? sum / k : 0;
    if (v > bestPhase + 1e-9) { bestPhase = v; phase = p; }
  }
  const beats = times.map((t) => Math.round(t * 1000) / 1000);
  return {
    bpm: Math.round(600 / beatSeconds) / 10,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === phase),
    confidence,
  };
}

/** Result of {@link snapCuts}. */
export interface SnappedCuts {
  /** New length of each shot in seconds (millisecond precision), in the order given. */
  seconds: number[];
  /** How many cuts between shots landed on a beat (the end of the last shot is not counted). */
  snapped: number;
  /** Where in the music track (seconds) to start it at video time 0. */
  offset: number;
}

/** Reward for a cut on a beat, extra for a downbeat, and the cost of moving a cut by the full tolerance. */
const ON_BEAT = 1;
const ON_DOWNBEAT = 0.25;
const MOVE_COST = 0.3;
/** The video's end counts this much of a cut: ending on the beat is nice, but cuts between shots matter more. */
const END_WEIGHT = 0.5;
/** Small preference for starting the music on a downbeat, and against starting it late. */
const START_ON_DOWNBEAT = 0.2;
const LATE_START_COST = 0.02;
/** Music start offsets tried: 0 and the first beats within this many seconds of the track. */
const OFFSET_BEATS = 8;
const OFFSET_MAX_S = 6;
/** Unsnapped cut positions are tried on this grid (seconds) within the tolerance. */
const GRID_S = 0.05;

const ms = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Chooses shot lengths so the cuts land on the music's beats. Each shot's planned `seconds` is clamped into
 * its [min, max] (min = voiceover length plus a margin, max = planned + ~0.6 s or the source length); each cut
 * between shots and the video's end then moves by at most `tolerance` seconds (default 0.35) from where the
 * plan put it, onto a beat when one fits, preferring downbeats (`opts.downbeats`, music time). The total
 * length changes by at most 5%. Unless `opts.offset` fixes it, the music start (seconds into the track) is
 * chosen among 0 and the track's first few beats, the one that lands the most cuts. `beats` are music times;
 * a cut at video time t sits on music time t + offset. Deterministic.
 */
export function snapCuts(
  shots: Array<{ seconds: number; min: number; max: number }>,
  beats: number[],
  opts?: { offset?: number; tolerance?: number; downbeats?: number[] },
): SnappedCuts {
  const tol = Math.max(0, opts?.tolerance ?? 0.35);
  const n = shots.length;
  // Bounds rounded inwards to whole milliseconds, so lengths between millisecond cut times stay inside them.
  const lo = shots.map((s) => Math.ceil(Math.max(0.04, Number.isFinite(s.min) ? s.min : 0) * 1000 - 1e-6) / 1000);
  const hi = shots.map((s, i) => Math.max(lo[i]!, Number.isFinite(s.max) ? Math.floor(s.max * 1000 + 1e-6) / 1000 : Infinity));
  const plan = shots.map((s, i) => Math.min(hi[i]!, Math.max(lo[i]!, Number.isFinite(s.seconds) ? s.seconds : lo[i]!)));
  const planned: number[] = [0];
  for (const p of plan) planned.push(planned[planned.length - 1]! + p);
  const total = planned[n]!;
  const fixedOffset = opts?.offset !== undefined && Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : null;
  const plainLengths = () => plan.map((p, i) => Math.min(hi[i]!, Math.max(lo[i]!, ms(p))));
  const sorted = [...new Set(beats.filter((b) => Number.isFinite(b) && b >= 0))].sort((a, b) => a - b);
  if (n === 0) return { seconds: [], snapped: 0, offset: fixedOffset ?? 0 };
  if (!sorted.length || tol === 0) return { seconds: plainLengths(), snapped: 0, offset: fixedOffset ?? 0 };
  const down = new Set((opts?.downbeats ?? []).map(ms));

  const offsets = fixedOffset !== null ? [fixedOffset]
    : [0, ...sorted.slice(0, OFFSET_BEATS).filter((b) => b > 0 && b <= OFFSET_MAX_S).map(ms)];

  type Cand = { pos: number; reward: number; beat: boolean };
  let best: { score: number; cuts: number[]; snapped: number; offset: number } | null = null;
  for (const offset of offsets) {
    // Candidates for cut i (1..n; n is the video's end), in video time.
    const cands: Cand[][] = [[{ pos: 0, reward: 0, beat: false }]];
    for (let i = 1; i <= n; i++) {
      const p = planned[i]!;
      const reach = i === n ? Math.min(tol, 0.05 * total) : tol;
      const weight = i === n ? END_WEIGHT : 1;
      const list: Cand[] = [];
      const cost = (pos: number) => (reach > 0 ? (MOVE_COST * Math.abs(pos - p)) / Math.max(tol, 1e-9) : 0);
      const within = (pos: number) => pos > 0 && Math.abs(pos - p) <= reach + 1e-9;
      for (let k = -Math.ceil(reach / GRID_S); k <= Math.ceil(reach / GRID_S); k++) {
        const pos = k === 0 ? ms(p) : ms(p + k * GRID_S);
        if (within(pos) || k === 0) list.push({ pos, reward: -cost(pos) * weight, beat: false });
      }
      for (const b of sorted) {
        const pos = ms(b - offset);
        if (pos > p + reach + 1e-9) break;
        if (!within(pos)) continue;
        const r = ON_BEAT + (down.has(ms(b)) ? ON_DOWNBEAT : 0);
        list.push({ pos, reward: (r - cost(pos)) * weight, beat: true });
      }
      cands.push(list);
    }
    // DP over the candidates: the best total reward of a chain ending at each candidate.
    let prev = cands[0]!.map(() => ({ score: 0, from: -1 }));
    const trace: Array<Array<{ score: number; from: number }>> = [prev];
    for (let i = 1; i <= n; i++) {
      const cur = cands[i]!.map((c) => {
        let s = -Infinity;
        let from = -1;
        cands[i - 1]!.forEach((q, j) => {
          const len = c.pos - q.pos;
          if (len < lo[i - 1]! - 1e-6 || len > hi[i - 1]! + 1e-6 || prev[j]!.score === -Infinity) return;
          if (prev[j]!.score > s) { s = prev[j]!.score; from = j; }
        });
        return { score: from >= 0 ? s + c.reward : -Infinity, from };
      });
      trace.push(cur);
      prev = cur;
    }
    let end = -1;
    prev.forEach((v, j) => { if (v.score > -Infinity && (end < 0 || v.score > prev[end]!.score)) end = j; });
    if (end < 0) continue;
    const cuts: number[] = new Array(n + 1);
    let snapped = 0;
    for (let i = n, j = end; i >= 0; j = trace[i]![j]!.from, i--) {
      cuts[i] = cands[i]![j]!.pos;
      if (i > 0 && i < n && cands[i]![j]!.beat) snapped++;
    }
    const startBonus = offset > 0 ? (down.has(offset) ? START_ON_DOWNBEAT : 0) - LATE_START_COST * offset : 0;
    const score = prev[end]!.score + startBonus;
    if (!best || score > best.score + 1e-9) best = { score, cuts, snapped, offset };
  }
  if (!best) return { seconds: plainLengths(), snapped: 0, offset: fixedOffset ?? 0 };
  const { cuts, snapped, offset } = best;
  return { seconds: plan.map((_, i) => ms(cuts[i + 1]! - cuts[i]!)), snapped, offset };
}
