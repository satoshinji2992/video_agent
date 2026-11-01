// Thin adapter over the Ark-style async video task API (Volcengine Ark / BytePlus ModelArk):
// POST {base}/contents/generations/tasks -> { id }; GET {base}/contents/generations/tasks/{id}
// -> { status: queued|running|succeeded|failed|expired|cancelled, content.video_url, error }.
// A relay may differ; only submitTask/getTask need changing. Result URLs expire after 24 h,
// so callers download immediately.
import { writeFile } from 'node:fs/promises';
import { config, RESOLUTION, seedanceMocked, type Aspect } from '../core/config.ts';
import { createLimiter } from '../core/limiter.ts';
import { atomicOutput, makePlaceholderClip } from '../core/ffmpeg.ts';
import { BUDGET_EXHAUSTED, ledger, pricing, seedanceTokens, seedanceUsd } from '../core/ledger.ts';
import { seedanceModel } from '../core/settings.ts';

export interface SeedanceJob {
  prompt: string;
  seconds: number;
  aspect: Aspect;
  imageUrls?: string[];
  /** Image (data: URL or asset://) the clip starts from, e.g. a generated poster or presenter still. */
  firstFrame?: string;
  /** Generate synced sound with the picture. */
  audio?: boolean;
  /** Model id; the one selected in the system panel when omitted. */
  model?: string;
}

type TaskState = { status: string; videoUrl?: string; error?: string; tokens?: number };

/**
 * What went wrong, for the caller's decision: 'refused' = the provider turned the input down (nothing was
 * generated or billed); 'submit' = any other failed submission; 'failed' = the task ended without a clip;
 * 'timeout'; 'download' = the clip exists and is paid for but could not be fetched yet (worth retrying later).
 */
export type SeedanceErrorKind = 'refused' | 'submit' | 'failed' | 'timeout' | 'download';
export interface SeedanceError extends Error { kind: SeedanceErrorKind; status?: number; imageRefused?: boolean }
const fail = (kind: SeedanceErrorKind, message: string, extra: Partial<SeedanceError> = {}) => Object.assign(new Error(message), { kind, ...extra }) as SeedanceError;

const limit = createLimiter(config.seedance.maxConcurrent);

async function submitTask(job: SeedanceJob): Promise<string> {
  const content: unknown[] = [{ type: 'text', text: job.prompt }];
  // data: URLs for uploaded images, or asset://<id> for assets managed on the provider's platform.
  if (job.firstFrame) content.push({ type: 'image_url', image_url: { url: job.firstFrame }, role: 'first_frame' });
  for (const url of job.imageUrls ?? []) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
  const body = {
    model: job.model ?? seedanceModel().id,
    content,
    // With a first-frame image the provider takes the ratio from the image and refuses an explicit one.
    ...(job.firstFrame ? {} : { ratio: job.aspect }),
    duration: job.seconds,
    resolution: RESOLUTION,
    draft: config.seedance.draft,
    generate_audio: Boolean(job.audio),
    watermark: false,
  };
  const res = await fetch(`${config.seedance.baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.seedance.apiKey}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: string } };
  if (!res.ok || !json.id) {
    const reason = `${json.error?.code ?? ''} ${json.error?.message ?? JSON.stringify(json).slice(0, 300)}`.trim();
    // A 4xx is the provider turning the request down: nothing was created. A 5xx or a gateway error may come
    // after the task was accepted upstream, so it is not treated as "nothing happened".
    const refused = res.status >= 400 && res.status < 500 && res.status !== 429;
    const imageRefused = refused && Boolean(job.firstFrame || job.imageUrls?.length) && /SensitiveContent|sensitive|real.?person|privacy|portrait|face|risk/i.test(reason) && !/InvalidParameter/i.test(reason);
    throw fail(refused ? 'refused' : 'submit', `Seedance submit failed (${res.status}): ${reason}`, { status: res.status, imageRefused });
  }
  return json.id;
}

async function getTask(id: string): Promise<TaskState> {
  const res = await fetch(`${config.seedance.baseUrl}/contents/generations/tasks/${id}`, {
    headers: { Authorization: `Bearer ${config.seedance.apiKey}` },
  });
  const json = (await res.json().catch(() => ({}))) as {
    status?: string;
    content?: { video_url?: string };
    error?: { message?: string; code?: string };
    usage?: { completion_tokens?: number; total_tokens?: number };
  };
  if (!res.ok) throw new Error(`Seedance query failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  return { status: normalizeStatus(json.status), videoUrl: json.content?.video_url, error: json.error?.message ?? json.error?.code, tokens: json.usage?.completion_tokens ?? json.usage?.total_tokens };
}

// Providers document two status vocabularies: queued/running/succeeded/failed/cancelled/expired and
// queued/in_progress/completed/failed. Map both onto the first.
function normalizeStatus(s?: string) {
  const v = (s ?? 'unknown').toLowerCase();
  return ({ in_progress: 'running', processing: 'running', completed: 'succeeded', success: 'succeeded' } as Record<string, string>)[v] ?? v;
}

/** Actual charge for a task from the provider's billing endpoint, converted to USD; null when unavailable. */
async function actualUsd(id: string): Promise<number | null> {
  if (!config.seedance.usageUrl) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.seedance.usageUrl}?task_id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${config.seedance.apiKey}` },
      });
      if (res.ok) {
        const j = (await res.json()) as { actual_amount?: number | string; currency?: string; data?: { actual_amount?: number | string; currency?: string } };
        const d = j.data ?? j;
        const amount = Number(d.actual_amount);
        const currency = (d.currency ?? '').toUpperCase();
        if (Number.isFinite(amount) && currency === 'USD') return amount;
        if (Number.isFinite(amount) && currency === 'CNY') return amount / pricing.usdCnyRate;
      }
    } catch {
      // billing lookups are best effort
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

export const estimateClipUsd = (job: Pick<SeedanceJob, 'seconds' | 'aspect'>) =>
  seedanceMocked() ? 0 : seedanceUsd(seedanceTokens(job.seconds, job.aspect));

/** Where a task stands across restarts: its provider id, when it was submitted, whether it is booked. */
export interface TaskRecord { taskId: string; createdAt: number; charged: boolean }

/**
 * Generates one clip into outPath. No retries: a failure is reported back so the agent can ask the user.
 * Charges go to the global ledger; returns the ledger's one-time budget warning, if any.
 * `track` persists the task the moment it is submitted and when it is booked, so a restart can pick it up;
 * with `resume`, an already submitted task is polled again instead of being submitted a second time.
 */
export async function generateClip(
  job: SeedanceJob,
  outPath: string,
  onStatus: (s: string) => void,
  meta: { session: string; item: string },
  track?: { submitted?: (taskId: string) => void; charged?: (taskId: string) => void; resume?: TaskRecord },
): Promise<string | null> {
  if (seedanceMocked()) {
    onStatus('mock');
    await makePlaceholderClip(outPath, job.seconds, job.aspect, job.prompt);
    return null;
  }
  return limit(async () => {
    let id: string;
    let charged = track?.resume?.charged ?? false;
    if (track?.resume) id = track.resume.taskId;
    else {
      const estimate = estimateClipUsd(job);
      if (!ledger.canSpend(estimate)) throw new Error(BUDGET_EXHAUSTED);
      id = await submitTask(job);
      track?.submitted?.(id);
    }
    const charge = async (tokens?: number) => {
      if (charged) return null;
      charged = true;
      const t = tokens ?? seedanceTokens(job.seconds, job.aspect);
      const actual = await actualUsd(id);
      const warning = ledger.record({
        session: meta.session, item: `${meta.item}${job.audio ? ' · 含声音' : ''} (${id})`, model: job.model ?? seedanceModel().id,
        usage: `${t} tokens`, usd: actual ?? seedanceUsd(t), basis: actual !== null ? 'actual' : 'estimate',
      });
      track?.charged?.(id);
      return warning;
    };
    // A task picked up after a restart is asked about at once, and given until its result link would expire
    // (24 h), however long the server was down: a finished, paid clip is never given up on.
    const deadline = track?.resume
      ? Math.max(track.resume.createdAt + 23 * 3600_000, Date.now() + 2 * config.seedance.pollIntervalMs)
      : Date.now() + config.seedance.timeoutMs;
    let last = '';
    let terminal = false;
    let first = Boolean(track?.resume);
    try {
      while (Date.now() < deadline) {
        if (!first) await new Promise((r) => setTimeout(r, config.seedance.pollIntervalMs));
        first = false;
        let t: TaskState;
        try {
          t = await getTask(id);
        } catch {
          continue; // transient query errors: keep polling until the deadline
        }
        if (t.status !== last) onStatus((last = t.status));
        if (t.status === 'succeeded' && t.videoUrl) {
          const warning = await charge(t.tokens);
          // The link stays valid for a day: a few tries now, and if they all fail the task stays open so the
          // heartbeat or a restart fetches it again, instead of paying for a new one.
          let lastError = '';
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const video = await fetch(t.videoUrl, { signal: AbortSignal.timeout(120_000) });
              if (!video.ok) throw new Error(`HTTP ${video.status}`);
              const data = Buffer.from(await video.arrayBuffer());
              await atomicOutput(outPath, (tmp) => writeFile(tmp, data));
              return warning;
            } catch (e) {
              lastError = (e as Error).message;
              await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
            }
          }
          terminal = true;
          throw fail('download', `Seedance download failed: ${lastError}`);
        }
        if (['failed', 'expired', 'cancelled'].includes(t.status)) {
          terminal = true;
          throw fail('failed', `Seedance task ${t.status}: ${t.error ?? 'no reason given'}`);
        }
      }
      throw fail('timeout', 'Seedance task timed out');
    } finally {
      // Anything but a terminal failure may still be billed by the provider, so book at least the estimate.
      if (!terminal) await charge();
    }
  });
}
