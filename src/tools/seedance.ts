// generate_seedance_shot and the background Seedance jobs it starts (resumed after a restart).
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config, RESOLUTION, seedanceMocked, type Aspect } from '../core/config.ts';
import { jobStore, type Job } from '../core/jobs.ts';
import { estimateClipUsd, generateClip, type SeedanceError } from '../providers/seedance.ts';
import { BUDGET_EXHAUSTED, ledger } from '../core/ledger.ts';
import { hashInputs, type Shot } from '../media/project.ts';
import { settings, seedanceModel } from '../core/settings.ts';
import { imageToVideoInput } from '../providers/images.ts';
import { attachClip, type Ctx, fail, liveShot, safe, setShot, text } from './shared.ts';

export const pendingSeedance = new Map<string, Promise<void>>();
export const pendingSeedanceCount = () => pendingSeedance.size;
export const hasPendingSeedance = (sessionId: string) => [...pendingSeedance.keys()].some((k) => k.startsWith(sessionId + ':'));
/** Estimated cost of Seedance jobs already submitted but not yet booked in the ledger. */
let reservedUsd = 0;

interface SeedanceRun {
  shotId: string; inputHash: string; prompt: string; seconds: number; aspect: Aspect; audio: boolean; model: string;
  imageUrls: string[]; firstFrame?: string; estimate: number;
  /** An already submitted task, picked up again after a restart. */
  resume?: Job;
  /** Second try without the reference images the provider refused. */
  textOnly?: boolean;
}

/** In-flight generations, keyed by session, shot and the shot's content hash (a reworked shot is a new key). */
export const seedanceKey = (sessionId: string, shotId: string, inputHash: string) => `${sessionId}:${shotId}:${inputHash}`;

/**
 * Runs one Seedance generation in the background: recorded in jobs.json the moment it is submitted (so a
 * restart polls it again instead of paying twice), attached to its shot when done, and reported to the
 * session either way. A submission refused because of its reference images (a too-real face, say) is
 * retried once from the text alone; the same in-flight entry covers the retry.
 */
function runSeedance(ctx: Ctx, r: SeedanceRun) {
  const key = seedanceKey(ctx.sessionId, r.shotId, r.inputHash);
  const job: Promise<void> = driveSeedance(ctx, r)
    .catch((e) => console.error('seedance job', key, e))
    .finally(() => { if (pendingSeedance.get(key) === job) pendingSeedance.delete(key); });
  pendingSeedance.set(key, job);
}

async function driveSeedance(ctx: Ctx, r: SeedanceRun): Promise<void> {
  reservedUsd += r.estimate;
  let taskId = r.resume?.taskId ?? '';
  let retry: SeedanceRun | null = null;
  try {
    const warning = await generateClip(
      { prompt: r.prompt, seconds: r.seconds, aspect: r.aspect, imageUrls: r.imageUrls, audio: r.audio, model: r.model, firstFrame: r.firstFrame },
      ctx.store.path(`clips/${r.inputHash}.mp4`),
      (status) => ctx.emit({ type: 'shot_status', id: r.shotId, status }),
      { session: ctx.sessionId, item: `${ctx.store.project.title} / ${r.shotId}` },
      {
        submitted: (id) => {
          taskId = id;
          jobStore.add({
            taskId: id, kind: 'seedance', session: ctx.sessionId, shotId: r.shotId, inputHash: r.inputHash,
            outPath: `clips/${r.inputHash}.mp4`, item: `${ctx.store.project.title} / ${r.shotId}`,
            params: { prompt: r.prompt, seconds: r.seconds, aspect: r.aspect, audio: r.audio, model: r.model },
          });
        },
        charged: (id) => jobStore.update(id, { charged: true }),
        resume: r.resume ? { taskId: r.resume.taskId, createdAt: Date.parse(r.resume.createdAt), charged: r.resume.charged } : undefined,
      },
    );
    if (taskId) jobStore.update(taskId, { status: 'done' });
    if (warning) ctx.emit({ type: 'toast', level: 'warn', text: warning });
    ctx.emit({ type: 'budget' });
    const live = liveShot(ctx, r.shotId, 'seedance', r.seconds, r.aspect);
    // A clip whose shot was reworked or removed meanwhile is kept on disk (an identical shot reuses it) but
    // is not news for the user or the agent.
    if (live && live.inputHash === r.inputHash) {
      await attachClip(ctx, live, r.inputHash);
      ctx.jobEvent?.({ shotId: r.shotId, ok: true, ...(r.textOnly ? { note: '参考图被视频模型拦下，这个镜头改用纯文字描述生成' } : {}) });
    }
  } catch (e) {
    const err = e as SeedanceError;
    const message = String(err.message);
    // The clip exists and is paid for but could not be fetched, or the task is just slow: it stays open and
    // the heartbeat asks again, until its result link (24 h) can no longer work.
    const age = Date.now() - (r.resume ? Date.parse(r.resume.createdAt) : Date.now());
    if ((err.kind === 'download' || err.kind === 'timeout') && taskId && age < 24 * 3600_000) return;
    if (taskId) jobStore.update(taskId, { status: 'failed', error: message.slice(0, 300) });
    if (err.kind === 'refused' && err.imageRefused && !r.textOnly) {
      retry = { ...r, imageUrls: [], firstFrame: undefined, textOnly: true, resume: undefined };
    } else {
      const live = liveShot(ctx, r.shotId, 'seedance', r.seconds, r.aspect);
      if (live && live.inputHash === r.inputHash) {
        // Turned down at submission: nothing was generated or billed, so a retry needs no approval.
        setShot(ctx, live, { status: 'failed', error: message.slice(0, 300), ...(err.kind === 'refused' ? { generatedOnce: false } : {}) });
        await ctx.store.save();
        ctx.jobEvent?.({ shotId: r.shotId, ok: false, error: message.slice(0, 300) });
      }
    }
  } finally {
    reservedUsd -= r.estimate;
  }
  if (retry) await driveSeedance(ctx, retry);
}

/** After a restart (or from the heartbeat): polls this session's submitted Seedance tasks again, never resubmitting. */
export function resumeSeedanceJobs(ctx: Ctx) {
  for (const j of jobStore.open().filter((x) => x.session === ctx.sessionId)) {
    if (pendingSeedance.has(seedanceKey(ctx.sessionId, j.shotId, j.inputHash))) continue;
    const p = j.params;
    runSeedance(ctx, {
      shotId: j.shotId, inputHash: j.inputHash, prompt: p.prompt, seconds: p.seconds, aspect: p.aspect as Aspect, audio: p.audio, model: p.model,
      imageUrls: [], estimate: j.charged ? 0 : estimateClipUsd({ seconds: p.seconds, aspect: p.aspect as Aspect }), resume: j,
    });
  }
}

/** Shots of this session whose current version is still being generated (a superseded generation does not count). */
export function pendingShotIds(sessionId: string, shots?: Shot[]) {
  const ids = new Set<string>();
  for (const k of pendingSeedance.keys()) {
    if (!k.startsWith(sessionId + ':')) continue;
    const [, shotId, hash] = k.split(':');
    if (!shots || shots.some((s) => s.id === shotId && s.inputHash === hash)) ids.add(shotId!);
  }
  return [...ids];
}

export function seedanceTools(ctx: Ctx) {
  const generateSeedanceShot = tool(
    'generate_seedance_shot',
    `Start generating a realistic AI video shot with Seedance (${RESOLUTION}; the model is chosen in the system panel, Seedance 2.5 by default; optionally with synced sound such as a person speaking a line on camera, in Chinese or English). Returns immediately; the clip keeps generating in the background. Submit all realistic shots, make the code shots, then end the turn: each finished clip is shown to the user automatically, and the system calls you when they are all done, which is when you assemble. Each generation costs money. Calling it again for a shot that was already generated shows the user an approval card and waits for their answer, so only do that when a redo is really needed.`,
    {
      shot_id: z.string(),
      prompt: z.string().describe('Visual description: subject, action, setting, lighting, camera movement, mood. Must not ask for any on-screen text, logos or captions. No real or famous people.'),
      reference_assets: z.array(z.string()).optional().describe('Reference images to keep the product or person consistent across shots: file names of images in assets/ (uploads or look images made with generate_image), or asset://<id> for an asset the user manages on the video platform (including authorized real-person assets).'),
      first_frame: z.string().optional().describe('An image file in assets/ (an upload or one made with generate_image) this one clip opens on, when the shot needs that exact opening frame (for consistency across shots use reference_assets instead, or every shot opens on the same picture). The prompt then describes the motion from that frame.'),
      audio: z.boolean().optional().describe('Generate the clip with its own synced sound. Use it when someone speaks on camera (write the exact line and language into the prompt, e.g. She says in English: "...") or when ambience matters. Defaults to the plan\'s setting for this shot.'),
    },
    safe(async ({ shot_id, prompt, reference_assets, audio: wantAudio, first_frame }) => {
      let s: Shot;
      try { s = ctx.store.shot(shot_id); } catch (e) { return fail((e as Error).message); }
      if (s.kind !== 'seedance') return fail(`镜头 ${shot_id} 的类型是 ${s.kind}，不是 seedance。`);
      const p = ctx.store.project;
      const refs = reference_assets ?? [];
      const audio = wantAudio ?? s.audio ?? settings.get().syncAudio;
      const model = seedanceModel().id;
      const inputHash = hashInputs('seedance', prompt, s.seconds, p.aspect, refs, model, config.seedance.draft, seedanceMocked(), audio, first_frame ?? null);
      if (existsSync(ctx.store.path(`clips/${inputHash}.mp4`))) {
        await attachClip(ctx, s, inputHash);
        return { content: [text(`镜头 ${shot_id} 已有相同内容的片段，直接复用，没有重新生成。`)] };
      }
      if (pendingSeedance.has(seedanceKey(ctx.sessionId, shot_id, inputHash))) return fail(`镜头 ${shot_id} 正在生成中，不要重复提交。`);
      if (s.generatedOnce && !seedanceMocked()) {
        const ok = await ctx.requestApproval(
          `重新生成写实镜头「${s.brief.slice(0, 20)}」`,
          '该镜头已生成，重新生成将再次调用写实镜头服务。',
        );
        if (!ok) return fail(`用户没有同意重新生成镜头 ${shot_id}。用一句话说明保留原来的片段（或者这个镜头可以改成动画），不要再问一遍。`);
      }
      let firstFrame: string | undefined;
      if (first_frame) {
        const f = ctx.store.path('assets', basename(first_frame));
        if (!existsSync(f)) return fail(`找不到首帧图片 ${first_frame}`);
        firstFrame = imageToVideoInput(f);
      }
      const imageUrls: string[] = [];
      for (const name of refs) {
        if (/^asset:\/\/[\w-]+$/.test(name)) {
          imageUrls.push(name);
          continue;
        }
        const f = ctx.store.path('assets', basename(name));
        if (!existsSync(f)) return fail(`找不到上传的素材 ${name}`);
        // Same handling as a first frame: the real type from the bytes, large or odd formats re-encoded.
        imageUrls.push(imageToVideoInput(f));
      }
      const estimate = estimateClipUsd({ seconds: s.seconds, aspect: p.aspect });
      if (!ledger.canSpend(estimate + reservedUsd)) {
        setShot(ctx, s, { status: 'failed', error: BUDGET_EXHAUSTED });
        await ctx.store.save();
        return fail(`生成额度已经用完，这个写实镜头没有提交。只对用户说一句"${BUDGET_EXHAUSTED}"，不要提任何数字；可以把这个镜头改成动画来做。`);
      }
      setShot(ctx, s, { status: 'working', error: undefined, inputHash, generatedOnce: true, audio });
      await ctx.store.save();
      // Kept beside the clip: the spoken line in it steers the transcript used for subtitles.
      if (audio) await writeFile(ctx.store.path(`clips/${inputHash}.prompt.txt`), prompt);
      runSeedance(ctx, { shotId: shot_id, inputHash, prompt, seconds: s.seconds, aspect: p.aspect, audio, model, imageUrls, firstFrame, estimate });
      await writeFile(ctx.store.path(`shots/${inputHash}.seedance.txt`), prompt);
      return { content: [text(`镜头 ${shot_id} 已提交（${seedanceMocked() ? '示意画面' : `${RESOLUTION}`}），在后台生成，一般一两分钟。每好一个，界面会自动把预览发给用户；全部好了（或者有失败）系统会再叫你，那时再合成。现在接着做别的镜头，都提交完就用一句话告诉用户写实部分在拍、好一个发一个，然后结束这一轮，不要等。`)] };
    }),
  );
  return { generateSeedanceShot };
}
