import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { config, FRAME_SIZE, type Aspect } from './config.ts';

export const CJK_FONT_FILE = (() => {
  try {
    return execFileSync('fc-match', ['-f', '%{file}', 'Noto Sans CJK SC:style=Bold']).toString().trim();
  } catch {
    return '';
  }
})();

export function ffmpeg(args: string[], stdin?: (w: NodeJS.WritableStream) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    let failed: Error | null = null;
    p.stderr.on('data', (d) => (err += d));
    // EPIPE when ffmpeg exits early must not become an uncaught exception.
    p.stdin.on('error', (e) => (failed ??= e));
    p.on('error', reject);
    p.on('close', (code) =>
      failed ? reject(failed) : code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)));
    if (stdin) {
      stdin(p.stdin).then(
        () => p.stdin.end(),
        (e) => {
          failed ??= e;
          p.stdin.destroy();
          p.kill('SIGKILL');
        },
      );
    } else p.stdin.end();
  });
}

/** Produces `out` only on success: the producer writes a temp file that is renamed into place. */
export async function atomicOutput(out: string, produce: (tmp: string) => Promise<void>) {
  const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp.mp4`;
  try {
    await produce(tmp);
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export function probeDuration(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
  return Number(out) || 0;
}

const escapeDrawtext = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%');

/** Stand-in for a Seedance clip when no API key is configured. */
export async function makePlaceholderClip(final: string, seconds: number, aspect: Aspect, prompt: string) {
  await atomicOutput(final, (out) => placeholder(out, seconds, aspect, prompt));
}

async function placeholder(out: string, seconds: number, aspect: Aspect, prompt: string) {
  const { width, height } = FRAME_SIZE[aspect];
  const label = escapeDrawtext(prompt.replace(/\s+/g, ' ').slice(0, 60));
  const font = CJK_FONT_FILE ? `fontfile='${CJK_FONT_FILE}':` : '';
  await ffmpeg([
    '-f', 'lavfi', '-i', `gradients=s=${width}x${height}:d=${seconds}:speed=0.02:r=${config.fps}`,
    '-vf', [
      `drawtext=${font}text='示意画面':fontsize=28:fontcolor=white:x=(w-tw)/2:y=h*0.42:box=1:boxcolor=black@0.4:boxborderw=12`,
      `drawtext=${font}text='${label}':fontsize=14:fontcolor=white@0.85:x=(w-tw)/2:y=h*0.52`,
    ].join(','),
    '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', out,
  ]);
}

/** Re-encode any clip to the project's exact size/fps/length so clips can be joined losslessly. */
/** `pre` is a filter run on the source picture first (a crop that removes baked-in bars). */
export async function normalizeClip(input: string, final: string, seconds: number, aspect: Aspect, pre?: string) {
  const { width, height } = FRAME_SIZE[aspect];
  await atomicOutput(final, (out) => ffmpeg([
    '-i', input,
    '-vf', `${pre ? `${pre},` : ''}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${config.fps},tpad=stop_mode=clone:stop_duration=${seconds},setsar=1`,
    '-t', String(seconds), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out,
  ]));
}

export async function concatClips(clips: string[], listFile: string, out: string) {
  await writeFile(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
}

/**
 * A sound placed on the timeline: a voiceover line, a realistic shot's own sound, or the user's footage's own
 * sound. `filter` replaces the plain `volume` (a level that moves over time, see ambience.ts); a `bed` is
 * on-location sound under everything else: it does not push the music down the way speech does.
 */
export interface AudioItem { file: string; start: number; duration?: number; volume?: number; filter?: string; bed?: boolean; vo?: boolean }

/**
 * A voiceover line's polish: rumble below 80 Hz cut, sibilance tamed, and a gentle 2.5:1 compression so quiet
 * words are not lost under the music. Light enough that the voice still sounds natural.
 */
const VO_CHAIN = 'highpass=f=80,deesser=i=0.35:m=0.5:f=0.5,acompressor=threshold=0.1:ratio=2.5:attack=8:release=150:makeup=1.6';
/** Music level between lines and under them (linear), and how long it takes to slide between the two. */
const MUSIC_GAP = 0.55;
const MUSIC_UNDER = 0.17;
const MUSIC_RAMP = 0.4;
/** Above this many separate speech stretches the envelope expression grows too long for ffmpeg. */
const MAX_DUCK_SPANS = 80;

/**
 * Final mux: subtitles burned in; voiceover and shot sound laid at their offsets; background music lowered,
 * faded, and ducked under any voice (sidechain); trimmed to the picture.
 */
/**
 * `bgmOffset`: where in the music track to start (seconds), so its beats meet the cuts. `speech`: when someone
 * speaks on the timeline; the music then follows a smooth volume envelope around those stretches (down a
 * little before a line, back up after it) instead of a compressor reacting to the voice, which pumps.
 */
export async function finalize(video: string, out: string, assFile: string | null, bgm?: string, voices: AudioItem[] = [], bgmOffset = 0, speech?: Array<[number, number]>) {
  const seconds = probeDuration(video);
  const inputs = ['-i', video];
  const graph: string[] = [];
  const subs = assFile ? `subtitles='${assFile.replace(/'/g, "\\'")}'${CJK_FONT_FILE ? `:fontsdir='${CJK_FONT_FILE.replace(/\/[^/]+$/, '')}'` : ''}` : 'null';
  graph.push(`[0:v]${subs}[vout]`);
  const fmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
  voices.forEach((v, i) => {
    inputs.push('-i', v.file);
    const ms = Math.max(0, Math.round(v.start * 1000));
    const trim = v.duration ? `atrim=0:${v.duration.toFixed(3)},asetpts=PTS-STARTPTS,` : '';
    graph.push(`[${i + 1}:a]${trim}${fmt},${v.vo ? `${VO_CHAIN},` : ''}${v.filter ?? `volume=${(v.volume ?? 1).toFixed(2)}`},adelay=${ms}|${ms}[v${i}]`);
  });
  // Speech (voiceover, people on camera) is one bus, which the music ducks under; on-location beds another.
  const bus = (items: number[], name: string) => {
    if (!items.length) return '';
    if (items.length === 1) return `[v${items[0]}]`;
    graph.push(`${items.map((i) => `[v${i}]`).join('')}amix=inputs=${items.length}:normalize=0:dropout_transition=0[${name}]`);
    return `[${name}]`;
  };
  const voice = bus(voices.flatMap((v, i) => (v.bed ? [] : [i])), 'voice');
  const beds = bus(voices.flatMap((v, i) => (v.bed ? [i] : [])), 'beds');
  let music = '';
  let ducked = false;
  if (bgm) {
    if (bgmOffset > 0) inputs.push('-ss', bgmOffset.toFixed(3));
    inputs.push('-stream_loop', '-1', '-i', bgm);
    const envelope = speech?.length && voice ? duckEnvelope(speech) : null;
    graph.push(`[${voices.length + 1}:a]${fmt},${envelope ?? `volume=${MUSIC_GAP}`},afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, seconds - 1.5).toFixed(2)}:d=1.5[bgm]`);
    music = '[bgm]';
    if (envelope) ducked = true;
  }
  let mixed = '';
  if (voice && music && ducked) {
    graph.push(`${voice}${music}amix=inputs=2:normalize=0:duration=longest[speechmix]`);
    mixed = '[speechmix]';
  } else if (voice && music) {
    // Without the speech stretches (or too many of them) the voice drives a compressor on the music, set
    // gently: a slow attack and release and a moderate ratio, so it does not pump. The voice is padded with
    // silence so the ducking key never ends: otherwise the music stops with the last spoken line.
    graph.push(`${voice}apad,asplit=2[vkey][vmix]`, `${music}[vkey]sidechaincompress=threshold=0.05:ratio=4:attack=80:release=700[ducked]`, `[ducked][vmix]amix=inputs=2:normalize=0[speechmix]`);
    mixed = '[speechmix]';
  } else {
    mixed = voice || music;
  }
  if (mixed && beds) {
    graph.push(`${mixed}${beds}amix=inputs=2:normalize=0:duration=longest[aout]`);
  } else if (mixed || beds) {
    graph.push(`${mixed || beds}anull[aout]`);
  } else {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    graph.push(`[${voices.length + 1}:a]anull[aout]`);
  }
  await ffmpeg([
    ...inputs, '-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-t', seconds.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
  ]);
}

/**
 * (The limiter sits at about -3 dBFS: AAC encoding afterwards overshoots between samples, and a limit near
 * -1.5 dBFS still left true peaks above 0.)
 * Brings a finished file to about -16 LUFS (the loudness of finished online videos) with one fixed gain
 * worked out from its measured loudness, so quiet and loud passages keep their balance. Near-silence
 * (under -40) is left alone rather than turned into loud hiss. The picture is copied as is.
 */
export async function normalizeLoudness(file: string, lufs: number | null) {
  if (lufs === null || !Number.isFinite(lufs) || lufs < -40 || Math.abs(-16 - lufs) < 0.5) return;
  const gain = Math.max(-12, Math.min(20, -16 - lufs));
  await atomicOutput(file, (out) => ffmpeg(['-i', file, '-map', '0', '-c:v', 'copy', '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.7:level=false`, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', out]));
}

/** Whether a file has an audio stream (a realistic shot generated with sound). */
export function hasAudio(file: string) {
  try {
    return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).toString().trim().length > 0;
  } catch {
    return false;
  }
}

/** A grid of evenly spaced frames, small enough to hand to the model for a visual check. */
export async function contactSheet(video: string, out: string, frames = 6) {
  const duration = Math.max(probeDuration(video), 0.5);
  const cols = 3;
  const rows = Math.ceil(frames / cols);
  await ffmpeg([
    '-i', video,
    '-vf', `fps=${frames / duration},scale=200:-2,tile=${cols}x${rows}:padding=4:color=white`,
    '-frames:v', '1', out,
  ]);
}

/** A contact sheet of the frames at `times` (seconds), in order, 3 per row. */
export async function contactSheetAt(video: string, out: string, times: number[]) {
  const dir = `${out}.frames`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    for (const [i, t] of times.entries()) {
      await ffmpeg(['-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=200:-2', `${dir}/${String(i).padStart(2, '0')}.png`]);
    }
    const rows = Math.ceil(times.length / 3);
    await ffmpeg(['-i', `${dir}/%02d.png`, '-vf', `tile=3x${rows}:padding=4:color=white`, '-frames:v', '1', out]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Frames decoded to 32x32 grey, one Buffer of 1024 bytes each. */
function greyFrames(args: string[]): Buffer[] {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  const out: Buffer[] = [];
  for (let i = 0; i + 1024 <= raw.length; i += 1024) out.push(raw.subarray(i, i + 1024));
  return out;
}

const spread = (b: Buffer) => {
  const mean = b.reduce((a, x) => a + x, 0) / b.length;
  return Math.sqrt(b.reduce((a, x) => a + (x - mean) ** 2, 0) / b.length);
};

/**
 * Whether a clip opens (or closes) on a flat, single-colour frame that gives way to the picture in a sweep or
 * a cut within three frames: a "wipe" painted into the shot itself, which flashes when the shot is cut in.
 * Fades (every pixel part-way between the colour and the picture) and elements popping in on an unchanged
 * background are not flagged.
 */
export function edgeFlash(file: string): { start: boolean; end: boolean } {
  const border = (b: Buffer) => {
    const px: number[] = [];
    for (let k = 0; k < 32; k++) px.push(b[k]!, b[31 * 32 + k]!, b[k * 32]!, b[k * 32 + 31]!);
    return px.sort((a, c) => a - c)[px.length >> 1]!;
  };
  // frames[0] is the edge frame, the last one the settled picture about 0.3 s in.
  const painted = (frames: Buffer[]) => {
    const edge = frames[0];
    const settled = frames.at(-1);
    if (!edge || !settled || frames.length < 5 || spread(edge) >= 3) return false;
    const v = edge.reduce((a, x) => a + x, 0) / edge.length;
    if (Math.abs(v - border(settled)) <= 25) return false;
    // Only pixels where the settled picture is clearly not the flat colour say anything.
    const telling: number[] = [];
    for (let i = 0; i < settled.length; i++) if (Math.abs(settled[i]! - v) > 60) telling.push(i);
    if (telling.length < settled.length * 0.2) return false;
    // A colour card held for a frame or two and then cut away also flashes; a fast fade does not count,
    // since its frames in between are no longer the plain colour.
    let held = true;
    for (const mid of frames.slice(1, 4)) {
      // Each pixel's progress from the flat colour (0) to the settled picture (1). A fade moves every pixel
      // by about the same amount; a sweep leaves some at 0 and puts the rest at 1; a cut puts all at 1.
      let none = 0;
      let full = 0;
      let exact = 0;
      for (const i of telling) {
        const a = (mid[i]! - v) / (settled[i]! - v);
        if (a < 0.08) none++;
        else if (a > 0.92) full++;
        if (a > 0.97) exact++;
      }
      const n = telling.length;
      if ((none >= n * 0.15 && full >= n * 0.15 && none + full >= n * 0.7) || (held && exact >= n * 0.9)) return true;
      held = none >= n * 0.9;
    }
    return false;
  };
  try {
    const head = greyFrames(['-i', file, '-frames:v', '8']);
    const tail = greyFrames(['-sseof', '-0.4', '-i', file]).slice(-8).reverse();
    return { start: painted(head), end: painted(tail) };
  } catch {
    return { start: false, end: false };
  }
}

export async function posterFrame(video: string, out: string, at = 0.5) {
  await ffmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=240:-2', out]);
}

/**
 * The music's volume over the timeline as an ffmpeg `volume` filter: MUSIC_GAP between lines, MUSIC_UNDER while
 * someone speaks, sliding over MUSIC_RAMP seconds (starting before a line so its first word is clear). null when
 * there are too many separate stretches for one expression.
 */
function duckEnvelope(speech: Array<[number, number]>): string | null {
  const spans = [...speech].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    // Lines closer than two ramps apart stay ducked between them: dipping back up for a moment pumps too.
    if (last && a - last[1] < MUSIC_RAMP * 2.5) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (!merged.length || merged.length > MAX_DUCK_SPANS) return null;
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const inside = merged.map(([a, b]) => {
    const from = a - MUSIC_RAMP;
    return `min(t${from >= 0 ? '-' : '+'}${n(Math.abs(from))},${n(b + MUSIC_RAMP)}-t)`;
  });
  const deepest = inside.reduceRight((acc, term) => `max(${term},${acc})`);
  const duck = `clip(${deepest}/${n(MUSIC_RAMP)},0,1)`;
  return `volume=${`${n(MUSIC_GAP)}-${n(MUSIC_GAP - MUSIC_UNDER)}*${duck}`.replace(/,/g, '\\,')}:eval=frame`;
}
