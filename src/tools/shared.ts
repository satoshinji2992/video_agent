// Shared pieces of the studio tools: the session context, result helpers, shot bookkeeping and contact sheets.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { HEADERS as FOOTAGE_HEADERS, safeFetch, type FootageCandidate } from '../media/footage.ts';
import { type FrameIssue } from '../media/framecheck.ts';
import { CJK_FONT_FILE, ffmpeg, posterFrame } from '../core/ffmpeg.ts';
import { type ProjectStore, type Shot } from '../media/project.ts';
import { join } from 'node:path';


export type Emit = (event: Record<string, unknown>) => void;

export interface Ctx {
  store: ProjectStore;
  sessionId: string;
  emit: Emit;
  /** Shows an "allow once / deny" card to the user and resolves with their decision. */
  requestApproval: (title: string, detail: string) => Promise<boolean>;
  /** Id of the running turn, for per-turn limits. */
  turnId: () => string;
  /** A background job finished (or failed); the session shows it and decides whether to wake the agent. */
  jobEvent?: (e: JobEvent) => void;
}

export interface JobEvent { shotId: string; ok: boolean; error?: string; note?: string }

export const text = (t: string) => ({ type: 'text' as const, text: t });
export const fail = (t: string) => ({ content: [text(t)], isError: true });
export const fileUrl = (ctx: Ctx, rel: string) => `/files/${ctx.sessionId}/${rel}`;

/** A 384 px wide PNG of an image, for the model to look at. */
export async function ffmpegPreview(src: string, out: string) {
  if (!existsSync(out)) await ffmpeg(['-y', '-i', src, '-vf', 'scale=384:-2', '-frames:v', '1', out]);
}

export async function imageBlock(file: string) {
  return { type: 'image' as const, data: (await readFile(file)).toString('base64'), mimeType: 'image/png' };
}

function shotView(ctx: Ctx, s: Shot) {
  return {
    id: s.id, seconds: s.seconds, kind: s.kind, brief: s.brief, status: s.status, segment: s.segment, vo: Boolean(s.vo), audio: Boolean(s.audio), role: s.role ?? 'main',
    thumb: s.thumbFile ? fileUrl(ctx, s.thumbFile) : undefined, error: s.error,
    clip: s.status === 'ready' && s.clipFile ? fileUrl(ctx, s.clipFile) : undefined,
  };
}

export function emitPlan(ctx: Ctx) {
  const p = ctx.store.project;
  ctx.emit({ type: 'plan', title: p.title, aspect: p.aspect, seconds: ctx.store.totalSeconds(), shots: p.shots.map((s) => shotView(ctx, s)) });
}

export function setShot(ctx: Ctx, s: Shot, patch: Partial<Shot>) {
  Object.assign(s, patch);
  emitPlan(ctx);
}

/** The live shot with this id, if it still matches what a background job was started for. */
export function liveShot(ctx: Ctx, id: string, kind: Shot['kind'], seconds: number, aspect: string) {
  const s = ctx.store.project.shots.find((x) => x.id === id);
  return s && s.kind === kind && s.seconds === seconds && ctx.store.project.aspect === aspect ? s : undefined;
}

/**
 * What the frame check found in a finished archive shot, for the agent: broken frames and bars that are still
 * in the picture are problems; a designed title card is only mentioned. Times count from the shot's start.
 */
export function shotFrameProblems(issues: FrameIssue[]) {
  const broken = issues.filter((i) => i.kind === 'flat-block' && !i.card);
  const bars = issues.filter((i) => i.kind !== 'flat-block');
  return [
    ...broken.map((i) => `有坏画面：${i.detail}`),
    ...bars.map((i) => `有黑边或片框没裁掉：${i.detail}`),
  ];
}

export async function attachClip(ctx: Ctx, s: Shot, inputHash: string) {
  const clip = `clips/${inputHash}.mp4`;
  const thumb = `clips/${inputHash}.jpg`;
  if (!existsSync(ctx.store.path(thumb))) await posterFrame(ctx.store.path(clip), ctx.store.path(thumb), Math.min(1, s.seconds / 2));
  setShot(ctx, s, { inputHash, clipFile: clip, thumbFile: thumb, status: 'ready', error: undefined });
  await ctx.store.save();
}

/**
 * Numbered thumbnails of footage candidates in one image, for the agent to look at. Thumbnails that fail to
 * download or decode are left grey; null if none could be fetched.
 */
/** `get` fetches a thumbnail (footage hosts by default; models pass their own allowlisted fetch). */
export async function footageSheet(found: Array<Pick<FootageCandidate, 'thumb'> & { kind?: string }>, out: string, get = (url: string) => safeFetch(url, { signal: AbortSignal.timeout(15_000), headers: FOOTAGE_HEADERS })): Promise<string | null> {
  if (existsSync(out)) return out;
  const dir = `${out}.parts`;
  await mkdir(dir, { recursive: true });
  try {
    let ok = 0;
    await Promise.all(found.map(async (c, i) => {
      const part = join(dir, `${String(i).padStart(2, '0')}.png`);
      const label = `drawtext=${CJK_FONT_FILE ? `fontfile='${CJK_FONT_FILE}':` : ''}text='${i + 1}${c.kind === 'video' ? ' ▶' : ''}':x=6:y=4:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
      try {
        const res = await get(c.thumb);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!res.ok || bytes.length > 4 << 20) throw new Error('thumb');
        const raw = join(dir, `${i}.raw`);
        await writeFile(raw, bytes);
        await ffmpeg(['-i', raw, '-frames:v', '1', '-vf', `scale=240:135:force_original_aspect_ratio=decrease,pad=240:135:(ow-iw)/2:(oh-ih)/2:color=0x222222,${label}`, part]);
        ok++;
      } catch {
        await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x444444:s=240x135', '-frames:v', '1', '-vf', label, part]);
      }
    }));
    if (!ok) return null;
    const rows = Math.ceil(found.length / 4);
    await ffmpeg(['-i', join(dir, '%02d.png'), '-vf', `tile=4x${rows}:padding=4:color=white`, '-frames:v', '1', out]);
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tool failures go back to the model as an error result instead of breaking the turn. */
export const safe = <A, R>(h: (args: A, extra: unknown) => Promise<R>) => async (args: A, extra: unknown): Promise<R> => {
  try {
    return await h(args, extra);
  } catch (e) {
    return fail(`出错了：${String((e as Error).message).slice(0, 600)}`) as R;
  }
};
