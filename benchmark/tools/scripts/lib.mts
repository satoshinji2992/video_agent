// Shared helpers for building the VideoAgentBench v1 packs. Imports the video agent's relay adapters
// from the read-only snapshot by absolute path; nothing here writes into the snapshot or the repo.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { generateClip, type SeedanceJob } from '../../../src/providers/seedance.ts';
import { generateImages, imageToVideoInput, type ImageModel, type ImageShape, type ImageRef } from '../../../src/providers/images.ts';
import { RESOLUTION, config } from '../../../src/core/config.ts';
import { readEntries } from '../../../src/core/ledger.ts';

export { RESOLUTION, config };
/** benchmark/tools: work/, log/, tmp/ and data/ live here (git-ignored); specs/ hold paths relative to it. */
export const GEN = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
/** benchmark/packs: the shipped task folders. */
export const PACK = join(GEN, '..', 'packs');
const at = (p: string) => (isAbsolute(p) ? p : join(GEN, p));
export const MODEL = process.env.BENCH_SEEDANCE_MODEL ?? 'doubao-seedance-2-5-260628';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

export const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

export function log(file: string, rec: object) {
  appendFileSync(`${GEN}/log/${file}`, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
}

export interface Probe {
  vcodec?: string; width?: number; height?: number; fps?: string; duration: number;
  audio: boolean; acodec?: string; sampleRate?: number; channels?: number; bitrate?: number;
}
export function probe(file: string): Probe {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const a = j.streams.find((s: any) => s.codec_type === 'audio');
  return {
    vcodec: v?.codec_name, width: v?.width, height: v?.height, fps: v?.avg_frame_rate, duration: Number(j.format.duration),
    audio: Boolean(a), acodec: a?.codec_name, sampleRate: a ? Number(a.sample_rate) : undefined, channels: a?.channels,
    bitrate: Number(j.format.bit_rate),
  };
}

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** Six frames spread over the clip (4 %…96 %), each stamped with its time, tiled 3×2. */
export function sheet(video: string, out: string, frameWidth: number, frames = 6) {
  const d = probe(video).duration;
  const tmp = `${out}.frames`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (let i = 0; i < frames; i++) {
      const t = d * (0.04 + (0.92 * i) / (frames - 1));
      ff(['-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf',
        `scale=${frameWidth}:-2,drawtext=fontfile=${FONT}:text='${t.toFixed(1)}s':fontsize=${Math.round(frameWidth / 14)}:fontcolor=yellow:box=1:boxcolor=black@0.6:x=6:y=6`,
        `${tmp}/${String(i).padStart(2, '0')}.png`]);
    }
    ff(['-i', `${tmp}/%02d.png`, '-vf', `tile=3x${Math.ceil(frames / 3)}:padding=6:color=white`, '-frames:v', '1', '-q:v', '3', out]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Loudness and peak of a clip's audio (integrated LUFS, true peak dBTP), or null without audio. */
export function loudness(file: string): { lufs: number; tp: number; lra: number } | null {
  if (!probe(file).audio) return null;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.stderr ?? '');
  if (!m) return null;
  const j = JSON.parse(m[0]);
  return { lufs: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra) };
}

export interface ClipSpec {
  id: string; slug: string; task: string; seconds: number; aspect: '9:16' | '16:9'; audio: boolean; prompt: string;
  firstFrame?: string; refs?: string[]; role?: string; defect?: string;
}

const itemRe = (item: string) => new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( · 含声音)? \\(`);

/** One Seedance attempt for a clip spec, written to tools/work/<task>/<id>/<tryLabel>.mp4 plus a contact sheet. */
export async function runClip(spec: ClipSpec, tryLabel: string) {
  spec = { ...spec, ...(spec.firstFrame ? { firstFrame: at(spec.firstFrame) } : {}), ...(spec.refs ? { refs: spec.refs.map(at) } : {}) };
  const dir = `${GEN}/work/${spec.task}/${spec.id}`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${tryLabel}.mp4`;
  if (existsSync(out)) throw new Error(`${out} exists; pick a new try label`);
  const item = `${spec.task}/${spec.id}/${tryLabel}`;
  const job: SeedanceJob = {
    prompt: spec.prompt, seconds: spec.seconds, aspect: spec.aspect, audio: spec.audio, model: MODEL,
    ...(spec.firstFrame ? { firstFrame: imageToVideoInput(spec.firstFrame) } : {}),
    ...(spec.refs?.length ? { imageUrls: spec.refs.map((r) => imageToVideoInput(r)) } : {}),
  };
  const t0 = Date.now();
  let error: string | null = null;
  const statuses: string[] = [];
  try {
    await generateClip(job, out, (s) => { statuses.push(s); console.log(`[${item}] ${s}`); }, { session: 'bench-v1', item });
  } catch (e) {
    error = (e as Error).message;
  }
  const entry = readEntries().filter((e) => itemRe(item).test(e.item)).at(-1) ?? null;
  const ok = !error && existsSync(out);
  const rec = {
    item, id: spec.id, slug: spec.slug, task: spec.task, try: tryLabel, model: MODEL, resolution: RESOLUTION,
    draft: config.seedance.draft, seconds: spec.seconds, aspect: spec.aspect, audio: spec.audio, prompt: spec.prompt,
    firstFrame: spec.firstFrame ?? null, firstFrameSha256: spec.firstFrame ? sha256(spec.firstFrame) : null,
    refs: spec.refs ?? [], refsSha256: (spec.refs ?? []).map(sha256),
    ok, error, statuses, elapsedS: Math.round((Date.now() - t0) / 1000),
    taskId: entry ? /\(([^)]+)\)$/.exec(entry.item)?.[1] ?? null : null,
    usd: entry?.usd ?? null, basis: entry?.basis ?? null, usage: entry?.usage ?? null,
    out: ok ? out : null, sha256: ok ? sha256(out) : null, probe: ok ? probe(out) : null,
  };
  log('attempts.jsonl', rec);
  if (ok) sheet(out, `${dir}/${tryLabel}.sheet.jpg`, spec.aspect === '9:16' ? 300 : 480);
  console.log(`[${item}] ${ok ? `OK ${rec.probe!.width}x${rec.probe!.height} ${rec.probe!.duration.toFixed(2)}s audio=${rec.probe!.audio} $${rec.usd?.toFixed(3)} (${rec.basis})` : `FAIL ${error}`}`);
  return rec;
}

export interface StillSpec {
  stem: string; model: ImageModel; shape: ImageShape; prompt: string; n?: number; refs?: string[]; extra?: Record<string, unknown>;
}

/** Generates stills into tools/work/stills/<stem>-<i>.<ext>; logs prompt, model and outputs. */
export async function runStill(s: StillSpec) {
  s = { ...s, ...(s.refs ? { refs: s.refs.map(at) } : {}) };
  const outDir = `${GEN}/work/stills`;
  const refs: ImageRef[] = (s.refs ?? []).map((p) => ({ bytes: readFileSync(p), type: p.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
  const t0 = Date.now();
  try {
    const r = await generateImages({ prompt: s.prompt, shape: s.shape, model: s.model, n: s.n ?? 1, refs, extra: s.extra }, outDir, s.stem);
    const rec = { stem: s.stem, model: r.model, shape: s.shape, prompt: s.prompt, refs: s.refs ?? [], ok: true, files: r.files.map((f) => ({ ...f, sha256: sha256(f.path) })), usd: r.usd, usage: r.usage, warning: r.warning ?? null, elapsedS: Math.round((Date.now() - t0) / 1000) };
    log('stills.jsonl', rec);
    console.log(`[still ${s.stem}] OK ${r.files.map((f) => `${basename(f.path)} ${f.width}x${f.height}`).join(', ')}${r.warning ? ` warn=${r.warning}` : ''}`);
    return rec;
  } catch (e) {
    const rec = { stem: s.stem, model: s.model, shape: s.shape, prompt: s.prompt, refs: s.refs ?? [], ok: false, error: (e as Error).message, elapsedS: Math.round((Date.now() - t0) / 1000) };
    log('stills.jsonl', rec);
    console.log(`[still ${s.stem}] FAIL ${rec.error}`);
    return rec;
  }
}

export const here = (p: string) => dirname(p);
