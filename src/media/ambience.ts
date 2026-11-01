// Keeps the user's own on-location sound (a mixer, a wok, a wrench, street noise, people chatting)
// audible in the cut: it sits under the voiceover and comes back up in the gaps between lines, instead of
// being muted or left at one fixed low level where the voiceover and the music bury it.
//
// ambienceProfile() says whether a clip's own sound is worth keeping. One async ffmpeg pass measures the
// integrated loudness (ebur128) and streams a 16 kHz mono copy to Node, which looks at 32 ms frames (16 ms
// hop): is the frame voiced (normalised autocorrelation peak at a speaking pitch, 80–400 Hz, with energy in
// the 300–3400 Hz band), how much energy sits below 150 Hz (wind rumble), how many samples are near full
// scale (clipping). Speech is told from ambience over 1.6 s windows: a window is speech when a fifth of its
// frames are voiced AND the speech-band envelope swings at a syllable rate (3–8 Hz). A mixer or a burner is a
// steady noise (not voiced); a held tone or a hum is voiced but does not swing; a person talking is both.
// Inside speech windows, the time someone is actually talking is the frames whose own ±0.25 s is at least a
// quarter voiced: a 1.6 s window counts whole when a cue fills a third of it, which made a few short coaching
// cues over gym music read as 64 % speech. A whisper transcript, when the caller has one, can only confirm
// speech the audio already hints at (whisper invents lines on quiet room tone, and its timings span the
// whole clip).
//
// Calibrated on the development set's 25 phone clips with sound (21 on-location ambience, 4 people talking,
// labelled from spectrograms) and its wind and clipping copies; never on the held-out benchmark. Talking time:
// the speech clips 32–66 % of the clip, the ambience clips with a brief voice (a few cues over gym music, a
// word in a street queue) 25 % and 18 %, the rest 0. Low rumble below 150 Hz: wind 88 % and 94 % of the
// energy, everything else at most 64 % (a wok's burner; 76 % on a 0.8 s cut of it). Near-full-scale samples:
// the clipped copies 0.40 % and 0.93 %, everything else 0. Loudness: −36 to −13 LUFS (the −13 is gym music,
// labelled ambience); the clipped copies −10 and −8.
//
// ambienceVolume() builds the ffmpeg volume expression that ducks one clip's own sound under the voiceover
// lines and lifts it in the gaps with short ramps, computed from the known line timings, so no sidechain has
// to listen for the voice at mix time; voiceGaps() lists the gaps long enough for the ambience to be heard.
import { spawn } from 'node:child_process';
import type { SpeechLine } from '../providers/transcribe.ts';

/** Analysis sample rate, frame length and hop (samples), and FFT size (frames are zero-padded to it). */
const RATE = 16000;
const WIN = 512;
const HOP = 256;
const NFFT = 1024;
const FPS = RATE / HOP;
/** Only this much of a clip is analysed. */
const MAX_SECONDS = 120;
const TIMEOUT_MS = 60_000;

/** Quieter than this (integrated LUFS) is nothing worth keeping. */
const NONE_LUFS = -50;
/** Louder than this (integrated LUFS) is too hot to sit under a voiceover as it is. */
const HOT_LUFS = -9;
/** Clipping: more than this share of samples at 0.9 of full scale or above. */
const HOT_SHARE = 0.002;
/** Wind: more than this share of the energy below 150 Hz, at a level that matters. */
const WIND_SHARE = 0.82;
const WIND_LUFS = -35;
/** A frame is active when within this many dB of the clip's loud frames (top tenth). */
const ACTIVE_DB = 30;
/** A frame is voiced: autocorrelation peak at a speaking pitch of at least HARM, BAND_SHARE in 300–3400 Hz. */
const HARM = 0.75;
const BAND_SHARE = 0.1;
/** Speech windows: length and hop in frames (1.6 s, 0.8 s), voiced share, 3–8 Hz modulation index. */
const SPAN = 100;
const SPAN_HOP = 50;
const SPAN_VOICED = 0.2;
const SPAN_MOD = 0.35;
/** Talking: a frame of a speech window whose ±TALK_HALF frames (0.25 s) are at least TALK_VOICED voiced. */
const TALK_HALF = 15;
const TALK_VOICED = 0.25;
/** Speech present: at least SPEECH_S seconds or SPEECH_SHARE of the clip talking; mostly speech: MOSTLY of it
 *  (talking time, pauses between phrases left out, so a third of the clip is a person carrying the clip). */
const SPEECH_S = 1;
const SPEECH_SHARE = 0.2;
const MOSTLY = 0.29;
/** A transcript counts only when at least this share of frames is voiced (whisper invents lines on hiss). */
const TRANSCRIPT_VOICED = 0.08;
/** Speaking rates used to turn a transcript into seconds of speech. */
const CJK_PER_S = 4.5;
const WORDS_PER_S = 2.5;
/** Voiceover lines closer than this are one stretch for ducking (no pumping up in a breath). */
const MERGE_S = 0.4;

/** Result of {@link ambienceProfile}. */
export interface AmbienceProfile {
  /** Integrated loudness in LUFS (ebur128; -70 for digital silence), or null when the file has no sound. */
  loudness: number | null;
  /** Someone talks in the clip for a noticeable stretch (at least 1 s of talking, or a fifth of it). */
  speech: boolean;
  /**
   * 'none': silent, nearly silent or no audio stream; 'speech': mostly someone talking (keep it up front at
   * ~0.9 with no voiceover over it, or mute it); 'loud': clipped, wind-blown or very hot (keep it low or drop
   * it); 'ambience': on-location sound worth keeping, ducked under the voiceover and raised in the gaps.
   */
  character: 'none' | 'ambience' | 'speech' | 'loud';
}

/** The measurements behind a profile. */
export interface AmbienceFeatures {
  loudness: number | null;
  /** Seconds analysed. */
  seconds: number;
  /** Share of samples (mono mix) at or above 0.9 of full scale. */
  hotShare: number;
  /** Share of the active frames' energy below 150 Hz. */
  lowShare: number;
  /** Median spectral flatness (0 tonal – 1 white noise) of the active frames, 100–7900 Hz. */
  flatness: number;
  /** Share of all frames that are voiced. */
  voiced: number;
  /** Median 3–8 Hz modulation index of the speech-band envelope over the windows. */
  modulation: number;
  /** Share of the clip someone is talking (voiced stretches inside speech windows). */
  speechShare: number;
}

// ---- FFT ----------------------------------------------------------------------------------------------------

const LOG2 = Math.log2(NFFT);
const REV = new Uint16Array(NFFT);
for (let i = 0; i < NFFT; i++) {
  let r = 0;
  for (let b = 0; b < LOG2; b++) r |= ((i >> b) & 1) << (LOG2 - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(NFFT / 2);
const SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / NFFT);
  SIN[i] = -Math.sin((2 * Math.PI * i) / NFFT);
}

/** In-place radix-2 FFT of (re, im), length NFFT; `inverse` flips the exponent's sign (no 1/N scaling). */
function fft(re: Float64Array, im: Float64Array, inverse = false) {
  for (let i = 0; i < NFFT; i++) {
    const j = REV[i]!;
    if (j > i) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  const s = inverse ? -1 : 1;
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step]!;
        const sn = s * SIN[k * step]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * c - im[b]! * sn;
        const ti = re[b]! * sn + im[b]! * c;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

const HANN = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
/** The Hann window's own normalised autocorrelation, divided out of the frame's (Boersma 1993). */
const HANN_AC = new Float64Array(WIN);
{
  let r0 = 0;
  for (let i = 0; i < WIN; i++) r0 += HANN[i]! * HANN[i]!;
  for (let l = 0; l < WIN; l++) {
    let r = 0;
    for (let i = 0; i + l < WIN; i++) r += HANN[i]! * HANN[i + l]!;
    HANN_AC[l] = r / r0;
  }
}

const bin = (hz: number) => Math.round((hz * NFFT) / RATE);
const ALL_LO = bin(20);
const LOW_HI = bin(150);
const FLAT_LO = bin(100);
const BAND_LO = bin(300);
const BAND_HI = bin(3400);
const TOP = bin(7900);
/** Pitch lags: 400 Hz down to 80 Hz. */
const LAG_LO = Math.floor(RATE / 400);
const LAG_HI = Math.ceil(RATE / 80);

/** One analysis frame: level (dBFS), band energies, flatness and harmonicity (0–1). */
interface Frame { db: number; low: number; band: number; all: number; flat: number; harm: number }

const re = new Float64Array(NFFT);
const im = new Float64Array(NFFT);
const pw = new Float64Array(NFFT / 2 + 1);

function analyseFrame(x: Float32Array): Frame {
  let ms = 0;
  for (let i = 0; i < WIN; i++) {
    ms += x[i]! * x[i]!;
    re[i] = x[i]! * HANN[i]!;
    im[i] = 0;
  }
  re.fill(0, WIN);
  im.fill(0, WIN);
  fft(re, im);
  let low = 0, band = 0, all = 0, logSum = 0, linSum = 0;
  for (let k = 0; k <= NFFT / 2; k++) {
    const p = re[k]! * re[k]! + im[k]! * im[k]!;
    pw[k] = p;
    if (k < ALL_LO || k > TOP) continue;
    all += p;
    if (k <= LOW_HI) low += p;
    if (k >= BAND_LO && k <= BAND_HI) band += p;
    if (k >= FLAT_LO) {
      logSum += Math.log(p + 1e-20);
      linSum += p;
    }
  }
  const nFlat = TOP - FLAT_LO + 1;
  const flat = linSum > 0 ? Math.exp(logSum / nFlat) / (linSum / nFlat) : 0;
  // Autocorrelation = inverse FFT of the power spectrum (the zero padding keeps it linear up to WIN lags).
  for (let k = 0; k < NFFT; k++) {
    re[k] = pw[k <= NFFT / 2 ? k : NFFT - k]!;
    im[k] = 0;
  }
  fft(re, im, true);
  let harm = 0;
  if (re[0]! > 1e-12) for (let l = LAG_LO; l <= LAG_HI; l++) harm = Math.max(harm, re[l]! / re[0]! / HANN_AC[l]!);
  return { db: 10 * Math.log10(ms / WIN + 1e-12), low, band, all, flat, harm: Math.min(1, harm) };
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

/** The 3–8 Hz modulation index of `env` (one value per frame): its in-band standard deviation over its mean. */
function syllabic(env: number[]): number {
  const n = env.length;
  const mean = env.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0 || n < 8) return 0;
  let power = 0;
  for (let k = Math.max(1, Math.ceil((3 * n) / FPS)); k <= Math.floor((8 * n) / FPS) && k < n / 2; k++) {
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const v = env[i]! - mean;
      a += v * Math.cos((2 * Math.PI * k * i) / n);
      b -= v * Math.sin((2 * Math.PI * k * i) / n);
    }
    power += a * a + b * b;
  }
  return Math.sqrt(2 * power) / n / mean;
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Measures a clip's own sound over its first 120 s: integrated loudness, share of near-full-scale samples,
 * low rumble, flatness, voicing, syllabic modulation and the share covered by speech. A file without an audio
 * stream gives loudness null and zeros. Rejects if ffmpeg fails otherwise or runs over 60 s.
 */
export async function ambienceFeatures(file: string): Promise<AmbienceFeatures> {
  if (!file) throw new Error('ambienceFeatures: missing file');
  const args = [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
    '-t', String(MAX_SECONDS), '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    // rematrix_maxval=1 keeps the mono mix at the channels' level (the default stereo downmix adds 3 dB and
    // would make every hot clip look clipped).
    '-af', `ebur128=framelog=quiet,aresample=${RATE}:ochl=mono:rematrix_maxval=1,aformat=sample_fmts=flt:channel_layouts=mono`,
    '-f', 'f32le', 'pipe:1',
  ];
  const frames: Frame[] = [];
  const buf = new Float32Array(WIN);
  let filled = 0;
  let samples = 0;
  let hot = 0;
  const onSample = (v: number) => {
    samples++;
    if (v >= 0.9 || v <= -0.9) hot++;
    buf[filled++] = v;
    if (filled === WIN) {
      frames.push(analyseFrame(buf));
      buf.copyWithin(0, HOP);
      filled = WIN - HOP;
    }
  };

  const log = await new Promise<string | null>((resolve, reject) => {
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
      for (; off + 4 <= pending.length; off += 4) onSample(pending.readFloatLE(off));
      pending = pending.subarray(off);
    });
    // Only the tail matters (the ebur128 summary comes last); the head describes the input.
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 16000) err = err.slice(-8000);
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`环境声分析超时（ffmpeg 超过 ${TIMEOUT_MS / 1000} 秒未完成）`));
      else if (code !== 0 && /matches no streams|does not contain any stream/i.test(err)) resolve(null);
      else if (code !== 0) reject(new Error(`环境声分析失败：ffmpeg exited ${code}: ${err.slice(-600)}`));
      else resolve(err);
    });
  });
  if (log === null) return { loudness: null, seconds: 0, hotShare: 0, lowShare: 0, flatness: 0, voiced: 0, modulation: 0, speechShare: 0 };
  // A clip shorter than one frame still gets one (zero-padded).
  if (!frames.length && filled > 0) {
    buf.fill(0, filled);
    frames.push(analyseFrame(buf));
  }
  const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/i.exec(log);
  const loudness = m ? (m[1] === '-inf' ? -70 : Math.max(-70, Number(m[1]))) : null;

  const levels = frames.map((f) => f.db).sort((a, b) => a - b);
  const floor = Math.max(-75, median(levels.slice(Math.floor(levels.length * 0.9))) - ACTIVE_DB);
  const active = frames.map((f) => f.db > floor);
  const voiced = frames.map((f, i) => active[i]! && f.harm >= HARM && f.band >= BAND_SHARE * f.all);
  let lowE = 0, allE = 0;
  const flats: number[] = [];
  frames.forEach((f, i) => {
    if (!active[i]) return;
    lowE += f.low;
    allE += f.all;
    flats.push(f.flat);
  });

  // Speech windows; a frame is speech when a speech window holds it.
  const env = frames.map((f) => Math.sqrt(f.band));
  const spans: Array<[number, number]> = [];
  if (frames.length <= SPAN) spans.push([0, frames.length]);
  else {
    for (let s = 0; s + SPAN < frames.length; s += SPAN_HOP) spans.push([s, s + SPAN]);
    spans.push([frames.length - SPAN, frames.length]);
  }
  const mods: number[] = [];
  const speechFrame = new Uint8Array(frames.length);
  for (const [a, b] of spans) {
    const share = voiced.slice(a, b).filter(Boolean).length / (b - a);
    const mod = syllabic(env.slice(a, b));
    mods.push(mod);
    if (share >= SPAN_VOICED && mod >= SPAN_MOD) speechFrame.fill(1, a, b);
  }
  // Talking time: speech-window frames whose own neighbourhood is voiced enough.
  const cum = new Int32Array(frames.length + 1);
  voiced.forEach((v, i) => (cum[i + 1] = cum[i]! + (v ? 1 : 0)));
  let talk = 0;
  for (let i = 0; i < frames.length; i++) {
    if (!speechFrame[i]) continue;
    const a = Math.max(0, i - TALK_HALF), b = Math.min(frames.length, i + TALK_HALF + 1);
    if ((cum[b]! - cum[a]!) / (b - a) >= TALK_VOICED) talk++;
  }
  const n = frames.length || 1;
  return {
    loudness,
    seconds: round(samples / RATE, 2),
    hotShare: round(samples ? hot / samples : 0, 5),
    lowShare: round(allE > 0 ? lowE / allE : 0),
    flatness: round(median(flats)),
    voiced: round(voiced.filter(Boolean).length / n),
    modulation: round(median(mods)),
    speechShare: round(talk / n),
  };
}

/** Seconds of speech a transcript stands for, from how much it says (whisper's timings are too coarse). */
function spokenSeconds(lines: SpeechLine[]): number {
  let s = 0;
  for (const l of lines) {
    const cjk = l.text.match(/[㐀-鿿]/g)?.length ?? 0;
    const words = l.text.replace(/[㐀-鿿]/g, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    s += cjk / CJK_PER_S + words / WORDS_PER_S;
  }
  return s;
}

/**
 * Whether a clip's own sound is worth keeping, and how. 'none' below -50 LUFS or with no audio stream;
 * 'loud' when more than 0.2 % of samples sit at 0.9 of full scale or above (clipping), when it is hotter than
 * -9 LUFS, or when over 82 % of the energy is wind rumble below 150 Hz; 'speech' when someone is talking for
 * at least 29 % of it (talking time, pauses left out); 'ambience' otherwise (a mixer, a wok, tools, street
 * sound, music, a room full of chatter, a short line or two). `speech` is true when someone talks for at least
 * 1 s (talking time, pauses left out) or a fifth of the clip, even
 * if the rest is ambience. Pass the clip's whisper `transcript` when there is one: it can confirm a short line
 * the acoustic check misses, never on its own (whisper invents lines on hiss). Heuristic, no API calls; reads
 * the first 120 s. Rejects if ffmpeg fails or runs over 60 s.
 */
export async function ambienceProfile(file: string, transcript?: SpeechLine[]): Promise<AmbienceProfile> {
  const f = await ambienceFeatures(file);
  if (f.loudness === null || f.seconds <= 0) return { loudness: f.loudness, speech: false, character: 'none' };
  let share = f.speechShare;
  if (transcript?.length && f.voiced >= TRANSCRIPT_VOICED) share = Math.max(share, Math.min(1, spokenSeconds(transcript) / f.seconds));
  const speech = share * f.seconds >= SPEECH_S || share >= SPEECH_SHARE;
  let character: AmbienceProfile['character'];
  if (f.loudness < NONE_LUFS) character = 'none';
  else if (f.hotShare > HOT_SHARE || f.loudness > HOT_LUFS || (f.lowShare > WIND_SHARE && f.loudness > WIND_LUFS)) character = 'loud';
  else if (share >= MOSTLY) character = 'speech';
  else character = 'ambience';
  return { loudness: f.loudness, speech: speech && character !== 'none', character };
}

/** Sorted, cleaned intervals with any two closer than `within` seconds joined. */
function merged(voice: Array<[number, number]>, within: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const sorted = voice.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] < within) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** A number for an ffmpeg expression: at most 3 decimals, no exponent, no "-0". */
const num = (v: number) => {
  const r = round(v);
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * The ffmpeg `volume` filter that ducks one clip's own sound under the voiceover and lifts it in the gaps,
 * ready to drop into a filter chain: commas inside the expression are escaped (`\,`), so it goes straight
 * between two filters of an `-af` or `-filter_complex` graph, e.g.
 * `[2:a]atrim=0:4.2,aresample=44100,${ambienceVolume(...)},adelay=6300|6300[a2]`.
 *
 * `clipStart` is where the clip sits on the timeline and `voice` the voiceover lines as timeline [start, end]
 * seconds; the expression runs on the clip's own time, so place it where `t` is 0 at the clip's first sample:
 * after the trim (add `asetpts=PTS-STARTPTS` after an `atrim` that does not start at 0) and before `adelay`.
 * The level is `under` (linear gain) wherever a voiceover line plays and `gap` elsewhere. Rendered with a voice
 * at -18 LUFS over each of the dev set's 21 ambience clips (under 0.3, gap 0.75, as tools.ts mixes them): the
 * bed sits 12–28 dB under the voice for clips of -21 LUFS and quieter, but only 9 dB under it for a -20 LUFS
 * wok and 5 dB for -13 LUFS gym music (scale `under` down for hot clips: ~0.3 suits -24…-34 LUFS); in the gaps
 * it comes back to 1–24 LU under the voice level, audible in every case; it starts sliding down `ramp` seconds (default 0.3) before a line so the
 * line starts on a ducked bed, and slides back up over `ramp` seconds after it. Lines closer than 0.4 s are
 * treated as one; lines outside the clip (plus the ramp) are left out, so the expression stays short. A clip
 * that starts or ends inside a line starts or ends ducked. Returns a plain `volume=<gain>` when nothing
 * changes over the clip, otherwise `volume=<expression>:eval=frame` (re-evaluated every audio frame, ~23 ms).
 */
export function ambienceVolume(opts: { clipStart: number; clipSeconds: number; voice: Array<[number, number]>; under: number; gap: number; ramp?: number }): string {
  const { clipStart, clipSeconds, under, gap } = opts;
  const ramp = Math.max(0.05, opts.ramp ?? 0.3);
  const lines = merged(opts.voice.map(([a, b]) => [a - clipStart, b - clipStart] as [number, number]), MERGE_S)
    .filter(([a, b]) => b + ramp > 0 && a - ramp < clipSeconds);
  if (!lines.length || num(under) === num(gap)) return `volume=${num(gap)}`;
  if (lines.some(([a, b]) => a <= 0 && b >= clipSeconds)) return `volume=${num(under)}`;
  // How far into the ducked plateau t is, per line: min(t - (a - ramp), (b + ramp) - t), positive inside
  // the line and its ramps; the duck is that, over the ramp, clipped to 0–1, for the line closest to it.
  const inside = lines.map(([a, b]) => {
    const from = a - ramp;
    return `min(t${from >= 0 ? '-' : '+'}${num(Math.abs(from))},${num(b + ramp)}-t)`;
  });
  const deepest = inside.reduceRight((acc, term) => `max(${term},${acc})`);
  const duck = `clip(${deepest}/${num(ramp)},0,1)`;
  const expr = under < gap ? `${num(gap)}-${num(gap - under)}*${duck}` : `${num(gap)}+${num(under - gap)}*${duck}`;
  return `volume=${expr.replace(/,/g, '\\,')}:eval=frame`;
}

/**
 * The stretches of the timeline [0, `total`] with no voiceover line, at least `minGap` seconds long, as
 * [start, end] seconds: where a clip's own sound can be heard on its own. Overlapping or touching lines count
 * as one; lines outside the timeline are clipped to it.
 */
export function voiceGaps(voice: Array<[number, number]>, total: number, minGap = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const [a, b] of merged(voice.map(([a, b]) => [Math.max(0, a), Math.min(total, b)] as [number, number]), 0)) {
    if (a - at >= minGap - 1e-9) out.push([round(at), round(a)]);
    at = Math.max(at, b);
  }
  if (total - at >= minGap - 1e-9) out.push([round(at), round(total)]);
  return out;
}
