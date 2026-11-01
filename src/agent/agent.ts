import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { query, type HookCallback, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config, relayReady } from '../core/config.ts';
import { DEFAULT_BOT } from '../core/bots.ts';
import { enabledSkills, linkSkillsInto, skillsRealRoot } from '../core/skills.ts';
import { appendFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { BUDGET_EXHAUSTED, ledger, pricing } from '../core/ledger.ts';
import { forDisplay, ProjectStore } from '../media/project.ts';
import { CAPABILITIES_VERSION, CAPABILITY_UPDATES, systemPrompt } from './prompt.ts';
import { askStructured, childEnv, claudeExecutable } from '../providers/llm.ts';
import { CHAT_MODELS } from '../core/config.ts';
import { settings } from '../core/settings.ts';
import { memory } from './memory.ts';
import { afterFeedback, afterTurn } from './review.ts';
import { writeOpener } from './opener.ts';
import { jobStore } from '../core/jobs.ts';
import { getUpload, type UploadInfo } from '../media/uploads.ts';
import { ingestMedia, readIndex, registerMedia, updateMedia, type MediaItem } from '../media/ingest.ts';
import { describeMedia } from '../media/describe.ts';
import { transcribe, TRANSCRIBE_USD_PER_MIN } from '../providers/transcribe.ts';
import { createStudio, hasPendingSeedance, pendingShotIds, resumeSeedanceJobs, STUDIO, STUDIO_TOOLS, type JobEvent } from '../tools/index.ts';

/** Last known health of the model connection, for the system panel. */
export const serviceHealth: { claudeOkAt?: number; claudeErrorAt?: number; claudeError?: string } = {};

export type UiEvent = Record<string, unknown> & { type: string };
export interface Upload { name: string; mime: string; data: Buffer }

type Stage = 'research' | 'script' | 'confirm' | 'skill' | 'plan' | 'shots' | 'assemble' | 'check';
const STAGE_NAME: Record<Stage, string> = { research: '查资料', script: '写剧本', confirm: '等你确认剧本', skill: '查镜头卡', plan: '排分镜', shots: '做镜头', assemble: '合成', check: '自检' };
/** Tools whose cards speak to the user: text written right before them is meant to be read. */
const CARD_TOOLS = new Set([`mcp__${STUDIO}__present_script`, `mcp__${STUDIO}__ask_user`]);
const APPROVAL_MS = 10 * 60_000;

/** The progress-card stage of a tool call; `drafting` while the model is still writing the call's input. */
function stageOf(tool: string, input: Record<string, unknown>, drafting: boolean): { stage: Stage; text: string } | null {
  const id = input.shot_id ? String(input.shot_id) : '';
  switch (tool.replace(`mcp__${STUDIO}__`, '')) {
    case 'Skill': case 'Read': case 'Glob': case 'Grep': return { stage: 'skill', text: '正在查阅技能资料' };
    case 'research': return { stage: 'research', text: '正在查资料' };
    case 'find_footage': return { stage: 'research', text: '正在找真实素材' };
    case 'list_media': case 'inspect_media': return { stage: 'research', text: '正在看你的素材' };
    case 'read_document': return { stage: 'research', text: '正在读资料' };
    case 'render_clip_shot': return { stage: 'shots', text: drafting ? '正在剪素材' : `正在剪镜头 ${id}` };
    case 'use_footage': return { stage: 'research', text: '正在下载素材' };
    case 'preview_footage': return { stage: 'research', text: '正在看素材' };
    case 'render_footage_shot': return { stage: 'shots', text: drafting ? '正在剪素材' : `正在剪素材镜头 ${id}` };
    case 'present_script': return { stage: 'script', text: '正在写剧本' };
    case 'ask_user': return { stage: 'confirm', text: '剧本待确认' };
    case 'save_plan': return { stage: 'plan', text: '正在规划分镜' };
    case 'render_code_shot': return { stage: 'shots', text: drafting ? (id ? `正在编写镜头 ${id}` : '正在编写镜头') : `正在渲染镜头 ${id}` };
    case 'generate_seedance_shot': return { stage: 'shots', text: drafting ? '正在编写写实镜头描述' : `正在提交写实镜头 ${id}` };
    case 'assemble_video': return { stage: 'assemble', text: '正在合成' };
  }
  return null;
}

/** A provider error as a short reason the user can follow. */
function friendlyError(e?: string) {
  const m = e ?? '';
  if (/sensitive|risk|审核|违规|real person|real_person|InputImageSensitive|OutputVideoSensitive/i.test(m)) return '画面被视频模型的审核拦下了';
  if (/timed out|超时/i.test(m)) return '生成超时了';
  if (/计划已经改了/.test(m)) return m;
  if (/额度/.test(m)) return m;
  return '视频模型这次没生成成功';
}

/**
 * Whether text the agent wrote before a tool call is meant for the user: a short update in the user's
 * language, not self-talk ("Let me…", "我先调用…") and not a repeat of the last thing shown.
 */
export function isUpdateForUser(text: string, userText: string, lastShown: string) {
  const t = text.trim();
  if (!t || t === lastShown.trim()) return false;
  const cjk = (x: string) => /[㐀-鿿]/.test(x);
  // The user's language decides: a Chinese conversation gets Chinese lines, an English one English.
  if (userText && cjk(userText) !== cjk(t)) return false;
  if (cjk(t) && (t.match(/[A-Za-z]/g)?.length ?? 0) > t.length * 0.3) return false;
  if (/^(let me|let's|i'll|i will|now i|next,? i|okay,? (now|let)|first,? i)\b/i.test(t)) return false;
  if (/(调用|工具|tool|save_plan|render_|generate_|assemble|HTML|渲染参数|我先看看|让我看看|让我想想|我来检查|检查一下抽帧)/i.test(t)) return false;
  return t.length <= 200;
}

/** Ingest stages as the progress card shows them. */
const STAGE_TEXT: Record<string, string> = { probe: '读取信息', proxy: '转码', shots: '分镜头', keyframes: '抽帧', quality: '检查画质', transcript: '听写', text: '读文档', done: '完成' };

const jobStoreHasOpen = (session: string) => jobStore.open().some((j) => j.session === session);

const LANGUAGE_RETRY_MARK = '·重说';
/** How long the end of a turn waits for a line being translated into the user's language. */
const TRANSLATE_WAIT_MS = 30_000;
/** The user's message for the opener: their words, how many pictures, the media ids they attached. */
interface Opening { text: string; images: number; media: string[]; answeredCard?: boolean }
/** Prefix of an in-turn note carrying the opener's line, so the agent keeps what it promised. */
const SAID_MARK = '开场：';
const INTRO_RETRY_MARK = '·介绍';
const EMPTY_RETRY_MARK = '·继续';

/** Text in another language than the user's: a Chinese user getting a mostly English line, or the reverse. */
export function languageMismatch(text: string, userText: string) {
  if (!userText.trim()) return false;
  // Quoted material (a voiceover line, a title, a caption in the language the user asked for) is content,
  // not the reply's language.
  text = text.replace(/“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』|‘[^’]*’/g, ' ');
  // A user asking for another language (an English voiceover, a translation) may well get it.
  if (/英文|英语|翻译|日文|日语|韩文|English|Chinese|translate|中文/i.test(userText)) return false;
  const cjk = (x: string) => (x.match(/[㐀-鿿]/g) ?? []).length;
  const latin = (x: string) => (x.match(/[A-Za-z]/g) ?? []).length;
  // Judged by proportion: a word or two of the other script does not make a message another language.
  const chineseUser = cjk(userText) >= 2 && cjk(userText) * 3 >= latin(userText) / 3;
  if (chineseUser) return cjk(text) === 0 ? latin(text) >= 8 : latin(text) > cjk(text) * 3 && latin(text) > 40;
  return latin(userText) >= 3 && cjk(text) >= 4 && cjk(text) * 3 > latin(text);
}

/**
 * Text as the user should see it: markdown bold is dropped (a chat bubble shows it raw), and in a Chinese
 * conversation an English lead-in that is the model talking to itself ("Plan: 9:16, ~30s…", "The user wants…
 * Reply first.") is cut off up to where the Chinese starts.
 */
export function cleanBubble(text: string, userText: string) {
  // Voice directions quoted from a line (pause marks, interjections) are never shown in chat.
  let t = forDisplay(text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/^#{1,4}\s+/gm, ''));
  if (/[㐀-鿿]/.test(userText)) {
    const lead = /^(?:[㐀-鿿]{1,2}[:：]?\s*)?[^㐀-鿿]{0,3}?((?:[A-Za-z0-9~][\w'’,:;.()~\-/]*\s*){5,}[^㐀-鿿]*)(?=[㐀-鿿])/.exec(t);
    if (lead && /\b(user|reply|plan|let me|i'll|i will|the user|first|then|wait)\b/i.test(lead[1]!)) {
      t = t.slice(lead[0].length);
      // What is left may be the tail of that same self-talk ("…match the user的回复语气。"): one opening on a
      // particle, or too short to be a sentence, is not a message.
      const rest = t.trim();
      if (/^[的了地得着过和与及或是在]/.test(rest) || (rest.match(/[㐀-鿿]/g) ?? []).length < 6) t = '';
    }
    // A lone stray character glued to the front ("柔: The user…" leaves "柔") is dropped with it.
  }
  return t.trim();
}

function makeInbox() {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(m: SDKUserMessage) { items.push(m); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (true) {
        if (items.length) { yield items.shift()!; continue; }
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

export class AgentSession {
  readonly id: string;
  readonly store: ProjectStore;
  readonly history: UiEvent[] = [];
  private listeners = new Set<(e: UiEvent) => void>();
  private inbox: ReturnType<typeof makeInbox> | null = null;
  private q: Query | null = null;
  private sdkSessionId: string | undefined;
  /** The text block being streamed; `held` ones are not shown until it is clear they are a message. */
  private bubble: { id: string; text: string; held: boolean } | null = null;
  /** A finished text block waiting to see what follows it in the same model message. */
  private heldText: { id: string; text: string } | null = null;
  /** Whether this turn's opening line has been shown; later text is held (see endBubble). */
  private openingShown = false;
  /** The opener's line was this turn's opening. */
  private openerSpoke = false;
  /** A question card went out this turn; text after it would only repeat the card. */
  private awaitingAnswer = false;
  /** Messages sent whose turn has not finished yet; several can be queued while the agent works. */
  private pendingTurns = 0;
  /** Whether the current query() has emitted system/init; used to detect a resume that failed to start. */
  private started = false;
  private interrupted = false;
  /** Messages sent while a turn was running; each starts its own turn after the current one ends. */
  private waiting: Array<{ id: string; msg: SDKUserMessage; opening: Opening | null }> = [];
  private stage: Stage | '' = '';
  /** id of the user message whose turn is running; the trajectory groups lines by it. */
  private turnId = '';
  private stageText = '';
  /** Whether the current turn has produced a video (so the model is now looking it over). */
  private turnVideo = false;
  /** The preference block this session's agent was started with; the opener writes in the same light. */
  private remembered = '';
  /** The tool call whose input the model is streaming right now. */
  private drafting: { name: string; json: string; shot: string } | null = null;
  botId = DEFAULT_BOT;
  pinned = false;
  /** Title set by the user; never replaced by the plan's title. */
  customTitle = '';
  private approvals = new Map<string, (ok: boolean) => void>();
  lastActive = Date.now();
  costUsd = 0;
  /** Last total_cost_usd seen; persisted, since whether a resumed query continues or restarts the counter is not documented. */
  private queryCostUsd = 0;

  get busy() {
    return this.pendingTurns > 0;
  }

  hasListeners() {
    return this.listeners.size > 0;
  }

  async setPinned(pinned: boolean) {
    this.pinned = pinned;
    await this.persist();
  }

  /** Renames the conversation; an empty title goes back to the automatic one. */
  async setTitle(title: string) {
    this.customTitle = title.trim().slice(0, 60);
    await this.persist();
  }

  /** 👍/👎 on a version, with an optional remark; feeds the preference memory. */
  feedback(version: number, rating: 'up' | 'down', comment: string) {
    if (!this.store.project.versions.some((v) => v.n === version)) return false;
    const f = { version, rating, comment: comment.trim().slice(0, 200), ts: new Date().toISOString() };
    this.trace('feedback', f);
    this.emit({ type: 'feedback', ...f });
    this.persistSoon();
    // A bare 👍/👎 is usually followed by a remark a few seconds later; learn once, from whichever comes last.
    clearTimeout(this.feedbackTimers.get(version));
    const learn = () => {
      this.feedbackTimers.delete(version);
      afterFeedback(this.target(), f);
    };
    // A remark settles it quickly; a bare rating waits for the remark that usually follows.
    this.feedbackTimers.set(version, setTimeout(learn, f.comment ? 3_000 : 30_000).unref());
    return true;
  }
  private feedbackTimers = new Map<number, NodeJS.Timeout>();
  /** The turn is being ended because the opener's question already answered it; no stop message. */
  private silentStop = false;
  /** The agent has started a tool call this turn; an opener line can no longer stand in for the turn. */
  private toolStarted = false;
  private turnStartedAt = 0;
  /** The opener's line for this turn when the agent spoke first; shown if the agent's line was junk. */
  private spareOpening: string | null = null;
  /** A reply in the wrong language was held back this turn; it is asked again once the turn ends. */
  private wrongLanguage: string | null = null;
  /** A wrong-language line of the language retry turn being translated (awaited before the turn ends). */
  private translating: Promise<void> | null = null;
  /** The running turn is itself such a retry (it is not retried again). */
  private languageRetry = false;
  private introRetry = false;
  private emptyRetry = false;
  /** Tool calls so far this turn (the agent's words before its first one repeat what the opener said). */
  private toolCalls = 0;
  /** Background results not yet told to the agent, and the debounce before it is woken for them. */
  private jobNews: Array<JobEvent & { brief: string; at: number }> = [];
  /** When the newest version was made: background news older than that was already used by it. */
  private lastVideoAt = 0;
  /** Background results that came in during the running turn, not yet told to the agent within it. */
  private inTurnNews: string[] = [];
  /** Ingest news waiting for the running turn's next tool result; a turn of its own if it never gets one. */
  private mediaNote: string | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Background news came in during a turn; reconsidered when that turn ends. */
  private wakeAfterTurn = false;
  /** After the user pressed stop, background results are shown but do not set the agent going again. */
  private quietJobs = false;
  /** While nobody has the conversation open: what happened, for a summary when they come back. */
  private away: { since: number; shots: number; failed: number; versions: number[]; latest: Record<string, unknown> | null } | null = null;
  private ctxCache: Parameters<typeof createStudio>[0] | null = null;
  /** The tools' view of this conversation; also used for background jobs that outlive a query or a restart. */
  private get studioCtx() {
    return (this.ctxCache ??= {
      store: this.store,
      sessionId: this.id,
      emit: (e: Record<string, unknown>) => this.emit(e),
      requestApproval: (title: string, detail: string) => this.requestApproval(title, detail),
      turnId: () => this.turnId,
      jobEvent: (e: JobEvent) => this.onJobEvent(e),
    });
  }

  /**
   * The user's last few messages, for the language checks: a request for English (or translated) content a
   * few messages back still holds when the agent quotes that content later.
   */
  private recentUserText() {
    return this.history.filter((e) => e.type === 'user').slice(-6).map((e) => String(e.text ?? '')).join('\n');
  }

  private lastUserText() {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i]!.type === 'user') return String(this.history[i]!.text ?? '');
    return '';
  }

  private lastBotText() {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i]!.type === 'bubble_end') return String(this.history[i]!.text ?? '');
    return '';
  }
  /** Prepended to the next message: what the opener said in a turn the agent did not finish. */
  private carryNote = '';
  /** The capability list this conversation has been told about; new conversations start with the current one. */
  private capsVersion = CAPABILITIES_VERSION;

  /** What background reviews need to know about this conversation. */
  private target() {
    return { dir: this.store.dir, session: this.id, title: this.summary().title, emit: this.emit };
  }

  /** Before deletion: drops queued messages, declines open approvals and stops the running turn. */
  shutdown() {
    this.pendingTurns -= this.waiting.length;
    this.waiting = [];
    for (const id of [...this.approvals.keys()]) this.decide(id, false);
    void this.interrupt();
  }

  /** Whether the title or any message text contains q (case-insensitive). */
  matches(q: string) {
    const needle = q.toLowerCase();
    if ([this.customTitle, this.store.project.title].some((t) => (t || '').toLowerCase().includes(needle))) return true;
    return this.history.some((e) => (e.type === 'user' || e.type === 'bubble_end') && String(e.text ?? '').toLowerCase().includes(needle));
  }

  /** One line for the conversation list: title, last visible message and when it happened. */
  summary() {
    const visible = this.history.filter((e) => ['user', 'bubble_end', 'video', 'approval'].includes(e.type));
    const last = visible.at(-1);
    const firstUser = this.history.find((e) => e.type === 'user')?.text as string | undefined;
    const preview = !last ? '' : last.type === 'video' ? `[视频] 第 ${last.version} 版` : last.type === 'approval' ? `[待确认] ${last.title}` : String(last.text ?? '');
    return {
      id: this.id,
      botId: this.botId,
      title: this.customTitle || this.store.project.title || firstUser?.slice(0, 24) || '新对话',
      preview: preview.slice(0, 60),
      updatedAt: Number(last?.ts ?? 0),
      pinned: this.pinned,
      busy: this.busy || this.hasBackgroundJobs(),
      versions: this.store.project.versions.length,
      thumb: (() => {
        const v = this.store.project.versions.at(-1);
        return v ? `/files/${this.id}/${v.file.replace(/\.mp4$/, '.jpg')}` : null;
      })(),
    };
  }

  pendingApprovalIds() {
    return [...this.approvals.keys()];
  }

  /** Shows an approval card and waits for the user's decision; no answer within the window counts as no. */
  requestApproval = (title: string, detail: string): Promise<boolean> => {
    const id = randomUUID();
    this.emit({ type: 'approval', id, title, detail, expiresAt: Date.now() + APPROVAL_MS });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.decide(id, false, 'expired'), APPROVAL_MS);
      timer.unref();
      this.approvals.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  };

  decide(id: string, ok: boolean, reason: 'user' | 'expired' = 'user') {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    this.emit({ type: 'approval_result', id, ok, reason });
    resolve(ok);
    return true;
  }

  hasBackgroundJobs() {
    return hasPendingSeedance(this.id) || this.approvals.size > 0 || this.wakeTimer !== null || this.ingesting > 0;
  }

  constructor(id: string, dir: string) {
    this.id = id;
    this.store = new ProjectStore(dir);
  }

  async init() {
    await this.store.init();
    const meta = this.store.path('meta.json');
    if (existsSync(meta)) {
      const m = JSON.parse(await readFile(meta, 'utf8'));
      this.sdkSessionId = m.sdkSessionId;
      this.costUsd = m.costUsd ?? 0;
      this.queryCostUsd = m.queryCostUsd ?? 0;
      this.history.push(...(m.history ?? []));
      this.botId = m.botId ?? DEFAULT_BOT;
      this.pinned = Boolean(m.pinned);
      this.customTitle = m.customTitle ?? '';
      this.modelOverride = m.model ?? '';
      this.capsVersion = m.capsVersion ?? 0;
      this.carryNote = m.carryNote ?? '';
    }
    // Nobody is watching a conversation that was just loaded: what happens from now on is summarized for them.
    this.away = { since: Date.now(), shots: 0, failed: 0, versions: [], latest: null };
    this.reconcile();
  }

  /**
   * After a restart: submitted realistic shots are polled again (never resubmitted); a shot that was still
   * being prepared but never reached the provider is marked failed, unbilled; a turn cut off by the restart
   * is closed and, if recent, picked up again.
   */
  private reconcile() {
    resumeSeedanceJobs(this.studioCtx);
    // Files whose ingest a restart cut off are processed again (each step skips work already done).
    // Files whose ingest a restart cut off are processed again (each step skips work already done), as one
    // batch, so the agent still hears when they are in.
    const unfinished = readIndex(this.store.dir).filter((m) => m.status === 'queued' || m.status === 'processing');
    if (unfinished.length) {
      const batch = `resume-${Date.now().toString(36)}`;
      this.batches.set(batch, unfinished.map((m) => ({ uploadId: `resume-${m.id}`, name: m.name, size: 0, status: 'processing', kind: m.kind, mediaId: m.id, stage: '排队中' })));
      for (const m of unfinished) void this.runIngest(m.id, batch);
    }
    const pending = new Set(pendingShotIds(this.id, this.store.project.shots));
    let orphans = 0;
    for (const s of this.store.project.shots) {
      if (s.status === 'working' && !pending.has(s.id)) {
        Object.assign(s, { status: 'failed', error: '服务重启时这个镜头还没提交', ...(s.kind === 'seedance' ? { generatedOnce: false } : {}) });
        orphans++;
      }
    }
    if (orphans) void this.store.save();
    const last = (type: string) => { for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i]!.type === type) return i; return -1; };
    const lastStart = last('turn_start');
    const lastEnd = last('turn_end');
    if (lastStart > lastEnd) {
      const at = Number(this.history[lastStart]!.ts ?? 0);
      this.emit({ type: 'turn_end', ok: false, costUsd: this.costUsd, errors: ['server restarted'] });
      if (Date.now() - at < 30 * 60_000) {
        this.queueSystem('（系统通知，不是用户发的：服务刚重启，上一轮做到一半被打断了。看一下计划和镜头现在的状态，把这一轮没做完的接着做完；先用一句自然的话告诉用户你接着在做，不要提"系统""重启"这些词。）');
      }
    }
  }

  /**
   * Files the user is uploading, grouped as they were picked (one progress card per group): upload bytes
   * are tracked by the browser; from completion on, the server reports validation and ingest stages.
   */
  /** Ingests running now; a deleted conversation is moved to the trash only after they end. */
  private ingesting = 0;
  /** Set once the conversation is closed (deleted): late background results are dropped. */
  private closed = false;
  private batches = new Map<string, Array<{ uploadId: string; name: string; size: number; status: string; kind?: string; mediaId?: string; stage?: string; error?: string }>>();
  private batchTimers = new Map<string, NodeJS.Timeout>();

  uploadBegan(u: UploadInfo, batch: string) {
    const items = this.batches.get(batch) ?? [];
    items.push({ uploadId: u.id, name: u.name, size: u.size, status: 'uploading' });
    this.batches.set(batch, items);
    this.emitBatch(batch, true);
  }

  uploadAborted(uploadId: string) {
    for (const [batch, items] of this.batches) {
      const it = items.find((x) => x.uploadId === uploadId && x.status === 'uploading');
      if (it) { it.status = 'cancelled'; this.emitBatch(batch, true); this.maybeMediaDone(batch); }
    }
  }

  /**
   * Uploads that stopped without being completed or cancelled (the page was closed, the network dropped)
   * expire after 30 min; their rows are settled then, so the rest of the batch still reaches the agent.
   */
  private settleLostUploads() {
    for (const [batch, items] of this.batches) {
      const lost = items.filter((x) => x.status === 'uploading' && !getUpload(this.id, x.uploadId));
      if (!lost.length) continue;
      for (const it of lost) { it.status = 'cancelled'; it.error = '上传中断'; }
      this.emitBatch(batch, true);
      this.maybeMediaDone(batch);
    }
  }

  /** A finished upload: rejected ones are shown as such; valid ones are registered and ingested in the background. */
  uploadCompleted(u: UploadInfo): MediaItem | undefined {
    const batch = [...this.batches].find(([, items]) => items.some((x) => x.uploadId === u.id))?.[0];
    const it = batch ? this.batches.get(batch)!.find((x) => x.uploadId === u.id)! : undefined;
    if (u.status !== 'complete' || !u.kind || !u.file) {
      if (it && batch) { it.status = 'rejected'; it.error = u.error; this.emitBatch(batch, true); this.maybeMediaDone(batch); }
      return undefined;
    }
    const media = registerMedia(this.store.dir, { name: u.name, kind: u.kind, file: u.file });
    if (it && batch) { it.status = 'processing'; it.kind = u.kind; it.mediaId = media.id; it.stage = '排队中'; this.emitBatch(batch, true); }
    void this.runIngest(media.id, batch);
    return media;
  }

  private async runIngest(id: string, batch?: string, retried = false): Promise<void> {
    if (this.closed) return;
    this.ingesting++;
    try {
      await this.ingestOnce(id, batch, retried);
    } finally {
      this.ingesting--;
    }
  }

  private async ingestOnce(id: string, batch?: string, retried = false): Promise<void> {
    const it = batch ? this.batches.get(batch)?.find((x) => x.mediaId === id) : undefined;
    const stage = (s: string) => { if (it && batch) { it.stage = s; this.emitBatch(batch); } };
    try {
      const item = await ingestMedia(this.store.dir, id, {
        transcribe: async (file, language) => {
          // Paid steps stop when the budget is used up; the file stays usable without a transcript or description.
          if (!ledger.canSpend(0.1)) throw new Error(BUDGET_EXHAUSTED);
          const r = await transcribe(file, language);
          if (r.fresh && relayReady()) ledger.record({ session: this.id, item: '听写素材', model: 'whisper-1', usage: `${Math.round(r.seconds)} s`, usd: (r.seconds / 60) * TRANSCRIBE_USD_PER_MIN, basis: 'estimate' });
          return r.lines;
        },
        onProgress: (s) => stage(STAGE_TEXT[s] ?? s),
      });
      const canDescribe = this.costUsd < config.maxBudgetUsdPerSession && (!pricing.claudeBilled || ledger.canSpend(pricing.claudeTurnReserveUsd));
      if (item.status === 'ready' && (item.kind === 'video' || item.kind === 'image') && canDescribe) {
        stage('看画面');
        const cost = await describeMedia(this.store.dir, id).catch((e) => { this.trace('describe_error', { id, error: String((e as Error).message) }); return 0; });
        if (pricing.claudeBilled && cost > 0) ledger.record({ session: this.id, item: '看素材', model: config.review.model, usage: id, usd: cost, basis: 'estimate' });
      }
      const done = readIndex(this.store.dir).find((m) => m.id === id);
      // A step that ran out of time (the machine was busy) gets one more try before the file counts as failed.
      if (done?.status === 'failed' && /超时|无法读取/.test(done.error ?? '') && !retried) {
        await new Promise((r) => setTimeout(r, 3000));
        updateMedia(this.store.dir, id, { status: 'queued', error: undefined });
        return this.ingestOnce(id, batch, true);
      }
      if (it) { it.status = done?.status === 'ready' ? 'ready' : 'failed'; it.error = done?.error; it.stage = undefined; }
    } catch (e) {
      this.trace('ingest_error', { id, error: String((e as Error).message) });
      if (it) { it.status = 'failed'; it.error = String((e as Error).message).slice(0, 200); }
    }
    if (batch && !this.closed) { this.emitBatch(batch, true); this.maybeMediaDone(batch); }
  }

  /** One progress card per batch, updated in place (at most every 2 s unless `now`). */
  private emitBatch(batch: string, now = false) {
    const send = () => {
      this.batchTimers.delete(batch);
      this.emit({ type: 'media_batch', batch, items: (this.batches.get(batch) ?? []).map(({ uploadId: _u, ...x }) => x) });
    };
    if (now) { clearTimeout(this.batchTimers.get(batch)); return send(); }
    if (!this.batchTimers.has(batch)) this.batchTimers.set(batch, setTimeout(send, 2000));
  }

  /** When every file of a batch is in (or failed), the agent is told what arrived, in a turn of its own. */
  private maybeMediaDone(batch: string) {
    const items = this.batches.get(batch) ?? [];
    if (!items.length || items.some((x) => x.status === 'uploading' || x.status === 'processing')) return;
    const index = readIndex(this.store.dir);
    const ready = items.map((x) => index.find((m) => m.id === x.mediaId)).filter((m): m is MediaItem => Boolean(m && m.status === 'ready'));
    // Files the user removed are left out; ones whose upload broke off (an error is set) are mentioned.
    const bad = items.filter((x) => x.status === 'rejected' || x.status === 'failed' || (x.status === 'cancelled' && x.error));
    if (!ready.length && !bad.length) return;
    this.batches.delete(batch);
    if (this.quietJobs) return;
    const describe = (m: MediaItem) => {
      if (m.kind === 'pdf' || m.kind === 'text') return `${m.id}「${m.name}」文档 ${m.text?.length ?? 0} 字`;
      if (m.kind === 'audio') return `${m.id}「${m.name}」音频 ${Math.round(m.duration ?? 0)} 秒${m.transcript?.length ? '，有人声' : ''}`;
      const flagged = m.segments.filter((s) => !s.usable);
      const flags = [...new Set(flagged.flatMap((s) => s.flags))];
      return `${m.id}「${m.name}」${m.kind === 'image' ? '图片' : `视频 ${Math.round(m.duration ?? 0)} 秒 ${m.segments.length} 段`}${flagged.length ? `，${flagged.length} 段有问题（${flags.join('、')}）` : ''}${m.summary ? `：${m.summary.slice(0, 80)}` : ''}`;
    };
    const summary = `用户上传的素材入库好了。${ready.map(describe).join('；')}${bad.length ? `。这些没能入库：${bad.map((x) => `「${x.name}」（${x.error ?? '原因不明'}）`).join('、')}` : ''}。用 list_media 看每段的描述、标签和问题，用 inspect_media 细看，文档用 read_document 读。先用一两句自然的话告诉用户你看到了什么（有多少可用的、哪些有问题先不用），用户已经说了要做什么就接着做，还没说就问一句想做成什么样。`;
    // A turn is running (the agent may be cutting already): it hears this with its next tool result, and only
    // if that turn ends without another tool call is a turn started for it.
    if (this.pendingTurns > 0) {
      this.inTurnNews.push(summary);
      this.mediaNote = summary;
      return;
    }
    this.queueSystem(`（系统通知，不是用户发的，不要原样转述：${summary}）`);
  }

  private lastBeat = '';

  /**
   * Every 10 s while anything runs in the background: a job whose poller was lost is picked up again, and
   * the trajectory notes when the set of pending shots changes (not every tick).
   */
  heartbeat() {
    if (this.batches.size) this.settleLostUploads();
    if (!hasPendingSeedance(this.id) && !jobStoreHasOpen(this.id)) return;
    resumeSeedanceJobs(this.studioCtx);
    const sig = pendingShotIds(this.id, this.store.project.shots).join(',');
    if (sig !== this.lastBeat) {
      this.lastBeat = sig;
      this.trace('heartbeat', { pending: sig ? sig.split(',') : [] });
    }
  }

  /** A background job finished: show it right away (by what the shot shows, not its id), then maybe wake the agent. */
  private onJobEvent(e: JobEvent) {
    const shot = this.store.project.shots.find((s) => s.id === e.shotId);
    const brief = shot?.brief ?? e.shotId;
    const file = (rel?: string) => (rel ? `/files/${this.id}/${rel}` : undefined);
    this.emit({
      type: 'shot_ready', id: e.shotId, brief, ok: e.ok, seconds: shot?.seconds,
      ...(e.ok ? { thumb: file(shot?.thumbFile), clip: file(shot?.clipFile) } : { error: friendlyError(e.error) }),
      ...(e.note ? { note: e.note } : {}),
    });
    this.jobNews.push({ ...e, brief, at: Date.now() });
    // During a long turn the agent hears of it with its next tool result, so it neither waits for a clip that
    // is already there nor says it is still being made.
    if (this.pendingTurns > 0) this.inTurnNews.push(e.ok ? `「${brief}」已经拍好` : `「${brief}」没拍成（${friendlyError(e.error)}）`);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    // Several clips often land within seconds of each other: one wake for all of them.
    this.wakeTimer = setTimeout(() => this.wakeForJobs(), 5000);
  }

  private wakeForJobs() {
    this.wakeTimer = null;
    // A turn is running: look again when it ends (it may well use the clips itself, or assemble already).
    if (this.pendingTurns > 0) {
      this.wakeAfterTurn = true;
      return;
    }
    const news = this.jobNews;
    const pending = pendingShotIds(this.id, this.store.project.shots);
    const failed = news.filter((n) => !n.ok);
    // Clips that keep arriving one by one are already on screen; the agent is woken when the batch is
    // complete or something needs its decision.
    if (!news.length || (pending.length && !failed.length)) return;
    this.jobNews = [];
    if (this.quietJobs) return;
    const done = news.filter((n) => n.ok).map((n) => `「${n.brief}」${n.note ? `（${n.note}）` : ''}`);
    const parts = [
      done.length ? `写实镜头 ${done.join('、')} 已经生成好，预览已经自动发给用户看了` : '',
      failed.length ? `这些没生成成功：${failed.map((n) => `「${n.brief}」（${n.error ?? '原因不明'}）`).join('、')}` : '',
      pending.length ? `还在生成的：${pending.join('、')}` : '所有写实镜头都结束了',
    ].filter(Boolean);
    this.queueSystem(`（系统通知，不是用户发的，不要原样转述，也不要提"系统""通知"：${parts.join('；')}。${pending.length ? '' : failed.length ? '先用一句话告诉用户哪个没成功、你打算怎么办（重试、改成动画或者换个拍法），需要用户拿主意就问；其他都齐了就接着做。' : '镜头都齐了：先用一句自然的话说一声在合成，然后调用 assemble_video 出片，出片后照常介绍并给建议。'}）`);
  }

  /** Starts (or queues behind the running one) a turn that the system, not the user, asked for. */
  private queueSystem(text: string) {
    if (this.closed) return;
    if (this.costUsd >= config.maxBudgetUsdPerSession || (pricing.claudeBilled && !ledger.canSpend(pricing.claudeTurnReserveUsd))) {
      this.emit({ type: 'bubble_end', id: randomUUID(), text: BUDGET_EXHAUSTED });
      return;
    }
    const id = randomUUID();
    const msg: SDKUserMessage = { type: 'user', parent_tool_use_id: null, uuid: randomUUID(), origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] } };
    this.trace('system_turn', { text });
    if (!this.q) this.start();
    const queued = this.pendingTurns > 0;
    this.pendingTurns++;
    if (queued) this.waiting.push({ id, msg, opening: null });
    else this.beginTurn(id, msg, null);
  }

  /** Writes meta.json through a temp file, so overlapping saves never leave it half-written. */
  private async persist() {
    if (this.closed) return;
    const tmp = this.store.path(`meta.json.${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, JSON.stringify({ botId: this.botId, pinned: this.pinned, customTitle: this.customTitle, model: this.modelOverride, capsVersion: this.capsVersion, carryNote: this.carryNote, sdkSessionId: this.sdkSessionId, costUsd: this.costUsd, queryCostUsd: this.queryCostUsd, history: this.history }));
    await rename(tmp, this.store.path('meta.json'));
  }

  private persistSoon() {
    this.persist().catch((e) => console.error('persist', this.id, (e as Error).message));
  }

  subscribe(fn: (e: UiEvent) => void) {
    const returning = this.listeners.size === 0 ? this.away : null;
    this.listeners.add(fn);
    if (returning) {
      this.away = null;
      // Only a status line and the newest result: the individual clips are in the history already.
      if (returning.shots || returning.failed || returning.versions.length) this.emit({ type: 'away', ...returning, pending: pendingShotIds(this.id, this.store.project.shots).length });
    }
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.away = { since: Date.now(), shots: 0, failed: 0, versions: [], latest: null };
    };
  }

  private trace(kind: string, data: unknown) {
    // Synchronous so concurrent large entries (tool inputs carrying whole HTML scenes) never interleave.
    // A conversation moved to the trash has no folder any more: its late entries are dropped, never thrown.
    try {
      appendFileSync(this.store.path('trajectory.jsonl'), JSON.stringify({ ts: new Date().toISOString(), kind, data }) + '\n');
    } catch { /* folder gone */ }
  }

  emit = (e: Record<string, unknown>) => {
    const ev = { ...e, ts: Date.now() } as unknown as UiEvent;
    if (ev.type === 'video') { this.turnVideo = true; this.lastVideoAt = Date.now(); }
    const a = this.away;
    if (a && ev.type === 'shot_ready') {
      if (ev.ok) a.shots++; else a.failed++;
      if (ev.ok) a.latest = { kind: 'shot', brief: ev.brief, thumb: ev.thumb, clip: ev.clip };
    } else if (a && ev.type === 'video') {
      a.versions.push(Number(ev.version));
      a.latest = { kind: 'video', version: ev.version, url: ev.url, poster: ev.poster, seconds: ev.seconds };
    }
    if (ev.type !== 'delta') {
      this.history.push(ev);
      this.trace('ui', ev);
      if (['bubble_end', 'user', 'video', 'plan', 'turn_end', 'turn_start', 'shot_ready', 'away'].includes(ev.type)) this.persistSoon();
    }
    for (const fn of this.listeners) fn(ev);
  };

  /** This conversation's model when it overrides the default; persisted in meta.json. */
  modelOverride = '';
  /** Model and effort the running CLI uses, so a change can be applied at the next turn. */
  private liveModel = '';
  private liveEffort = '';
  wantModel() { return this.modelOverride || settings.get().chatModel; }

  /** Switches this conversation's model (empty = the global default); takes effect at the next turn. */
  async setModel(model: string) {
    this.modelOverride = model;
    await this.persist();
    const label = CHAT_MODELS.find((m) => m.id === this.wantModel())?.label ?? this.wantModel();
    this.emit({ type: 'system', text: `已切换到 ${label}，下一轮生效` });
  }

  /** Skills the current query() was started with; a change takes effect at the next message. */
  private skillsKey = '';

  /** Sends a user message. `skill` (an enabled skill's name) invokes that skill explicitly. */
  /** `answer` marks the message as the user's pick on a question card. */
  async send(text: string, uploads: Upload[], skill?: string, answer?: { id: string; index: number; picks?: number[] }, media: string[] = []) {
    // A brief card shown since the user last wrote: whatever comes next answers it, tapped or typed.
    const lastUser = this.history.map((e) => e.type).lastIndexOf('user');
    const cardOpen = this.history.slice(lastUser + 1).some((e) => e.type === 'ask' && Array.isArray((e as { questions?: unknown }).questions));
    this.lastActive = Date.now();
    // Enforced here rather than with the SDK's maxBudgetUsd, which injects a "USD budget" reminder
    // into every request that the model then talks about in its replies.
    if (this.costUsd >= config.maxBudgetUsdPerSession || (pricing.claudeBilled && !ledger.canSpend(pricing.claudeTurnReserveUsd))) {
      this.emit({ type: 'user', id: randomUUID(), text, images: [], rejected: true });
      this.emit({ type: 'bubble_end', id: randomUUID(), text: BUDGET_EXHAUSTED });
      return;
    }
    const names: string[] = [];
    for (const [i, u] of uploads.entries()) {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[u.mime] ?? '.bin';
      const stem = u.name.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40) || 'image';
      // Two images in one message (two pasted screenshots are both "image.png") must not share a name.
      const name = `${Date.now().toString(36)}-${i}${randomUUID().slice(0, 4)}-${stem}${ext}`;
      await writeFile(this.store.path('assets', name), u.data);
      names.push(name);
    }
    this.quietJobs = false;
    const chosen = skill && enabledSkills().some((x) => x.name === skill) ? skill : undefined;
    const id = randomUUID();
    const queued = this.pendingTurns > 0;
    // Files uploaded with this message: what they are and whether they are ready yet.
    const index = media.length ? readIndex(this.store.dir) : [];
    const attached = media.map((id) => index.find((m) => m.id === id)).filter((m): m is MediaItem => Boolean(m));
    this.emit({ type: 'user', id, text, images: names.map((n) => `/files/${this.id}/assets/${n}`), ...(attached.length ? { files: attached.map((m) => ({ name: m.name, kind: m.kind })) } : {}), ...(chosen ? { skill: chosen } : {}), ...(queued ? { queued: true } : {}), ...(answer ? { answer } : {}) });
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }> = [];
    for (const [i, u] of uploads.entries()) {
      content.push({ type: 'image', source: { type: 'base64', media_type: u.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: u.data.toString('base64') } });
      content.push({ type: 'text', text: `（上面这张图已保存为 assets/${names[i]}）` });
    }
    // A leading "/" would be run by the CLI as a slash command (e.g. /clear); only an explicitly chosen
    // skill is sent as one. A zero-width space keeps anything else an ordinary message.
    const enabled = enabledSkills().map((x) => x.name);
    const body = text || (attached.length ? '（用户只发了素材）' : '（用户只发了图片）');
    const prompt = skill && enabled.includes(skill) ? `/${skill} ${body}` : body.startsWith('/') ? `\u200b${body}` : body;
    content.push({ type: 'text', text: prompt });
    // The files as a plain list after the words: an instruction here ("reply first, don't wait") was answered
    // as if the user had said it, sometimes word for word, at the start of the reply.
    if (attached.length) {
      content.push({ type: 'text', text: `[附件] ${attached.map((m) => `${m.id}「${m.name}」${{ video: '视频', audio: '音频', image: '图片', pdf: '文档', text: '文档' }[m.kind]}（${m.status === 'ready' ? '已入库' : '入库中，完成后有系统通知'}）`).join('；')}` });
    }
    const msg: SDKUserMessage = { type: 'user', parent_tool_use_id: null, uuid: randomUUID(), origin: { kind: 'human' }, message: { role: 'user', content } };
    this.trace('user', { text, uploads: names, skill });
    if (this.q && !this.pendingTurns && this.skillsKey !== enabled.join(',')) {
      // Enabled skills changed since this session's CLI started: restart it (resuming the conversation).
      this.inbox?.close();
      this.q = null;
      this.inbox = null;
    }
    if (!this.q) this.start();
    this.pendingTurns++;
    // Held here rather than pushed to the CLI, which may fold a message into the running turn.
    const opening: Opening = { text, images: uploads.length, media: attached.map((m) => m.id), ...(answer?.picks || cardOpen ? { answeredCard: true } : {}) };
    if (queued) this.waiting.push({ id, msg, opening });
    else this.beginTurn(id, msg, opening);
  }

  /**
   * The user's message as the opener reads it, built when the turn starts (a queued message's documents may
   * have been read meanwhile). Attached material is named, so the opener does not ask for files that are
   * already there, and it learns their content will be visible, so it does not ask what the footage shows.
   * A document's text goes along once it is read (the store name, the products, the prices are in it), so the
   * opener does not ask for what the user just sent.
   */
  private openingText(o: Opening) {
    if (!o.media.length) return o.text;
    const index = readIndex(this.store.dir);
    const attached = o.media.map((id) => index.find((m) => m.id === id)).filter((m): m is MediaItem => Boolean(m));
    if (!attached.length) return o.text;
    const docs = attached.filter((m) => m.kind === 'pdf' || m.kind === 'text');
    const docText = docs.filter((m) => m.text?.trim()).slice(0, 2).map((m) => `\n「${m.name.split('/').pop()}」的内容（开头）：${m.text!.trim().slice(0, 1200)}`).join('');
    const docHint = docs.length ? '。用户发的文档、logo 就是这次的资料，店名、产品、卖点、价格、地址这类信息以里面写的为准，不要再问用户' : '';
    return `${o.text}（随消息附了 ${attached.length} 个素材文件：${attached.slice(0, 6).map((m) => m.name.split('/').pop()).join('、')}${attached.length > 6 ? ' 等' : ''}。入库后你能看到每段画面、照片和文档的内容${docHint}）${docText}`;
  }

  /** `opening` is the user's message, for the opener; null for a turn the system started. */
  private beginTurn(id: string, msg: SDKUserMessage, opening: Opening | null) {
    // Notes go on the message when its turn starts, not when it was sent: a message queued behind a turn
    // must carry what the opener said in that turn.
    const notes: string[] = [];
    if (this.carryNote) notes.push(this.carryNote);
    // A conversation from before an upgrade still believes what it said back then ("I can't take a frame
    // from the video"); it is told once, with its next message, what it can do now.
    if (this.capsVersion < CAPABILITIES_VERSION) {
      const news = CAPABILITY_UPDATES.filter((u) => u.v > this.capsVersion).map((u) => u.text);
      if (this.sdkSessionId && news.length) notes.push(`（系统备注：从这一轮起你多了这些能力，以前在对话里说过做不到的，现在照新的做：${news.join('；')}）`);
      this.capsVersion = CAPABILITIES_VERSION;
    }
    if (notes.length) {
      (msg.message.content as Array<{ type: string; text?: string }>).unshift(...notes.map((t) => ({ type: 'text', text: t })));
      this.carryNote = '';
      this.persistSoon();
    }
    this.toolStarted = false;
    // News for the previous turn that it never heard is kept for this one.
    this.inTurnNews = this.mediaNote ? [this.mediaNote] : [];
    this.toolCalls = 0;
    this.turnStartedAt = Date.now();
    this.spareOpening = null;
    this.emptyRetry = Boolean(msg.message.content && JSON.stringify(msg.message.content).includes(EMPTY_RETRY_MARK));
    this.wrongLanguage = null;
    this.languageRetry = Boolean(msg.message.content && JSON.stringify(msg.message.content).includes(LANGUAGE_RETRY_MARK));
    this.introRetry = Boolean(msg.message.content && JSON.stringify(msg.message.content).includes(INTRO_RETRY_MARK));
    this.silentStop = false;
    this.turnId = id;
    this.openingShown = false;
    this.openerSpoke = false;
    this.awaitingAnswer = false;
    this.heldText = null;
    this.stage = '';
    this.stageText = '';
    this.turnVideo = false;
    this.emit({ type: 'turn_start', id, ...(opening ? {} : { system: true }) });
    this.emit({ type: 'typing', on: true });
    // A model or effort chosen since the last turn is sent before the message, in order.
    const model = this.wantModel(), effort = settings.get().effort;
    const changes: Promise<unknown>[] = [];
    if (this.q && model !== this.liveModel) changes.push(this.q.setModel(model));
    if (this.q && effort !== this.liveEffort) changes.push(this.q.applyFlagSettings({ effortLevel: effort }));
    this.liveModel = model;
    this.liveEffort = effort;
    this.trace('model', { model, effort });
    const inbox = this.inbox!;
    if (changes.length) void Promise.race([Promise.allSettled(changes), new Promise((r) => setTimeout(r, 3000))]).then(() => inbox.push(msg));
    else inbox.push(msg);
    if (!config.fastFirstReply || !opening) return;
    // Medium-effort thinking before the first words can take 20 s and more, and neither effort nor thinking
    // can be lowered for just the first request (both apply per turn). So a short separate call writes an
    // opening line in the same voice, in parallel: whichever opening is ready first is shown. If the opener
    // wins, the agent's own opening (always followed by a tool call) is held back as narration; if the agent
    // speaks first, the opener's line is dropped. It returns nothing for questions and chat.
    const t0 = Date.now();
    const recent = this.history
      .filter((e) => (e.type === 'user' && !e.rejected && e.id !== id) || e.type === 'bubble_end')
      .slice(-8)
      .map((e) => ({ role: e.type === 'user' ? ('user' as const) : ('bot' as const), text: String(e.text ?? '') }));
    const p = this.store.project;
    const state = p.versions.length ? `当前对话里已经做出了成片《${p.title}》第 ${p.versions.length} 版（${p.versions.at(-1)!.seconds} 秒），用户说"这个片子""这条"指的就是它。`
      : p.script ? `当前对话里已经有剧本《${p.script.title}》第 ${p.script.version} 版，还没出片。` : '';
    // Mid-project the agent knows what is possible better than the opener: a question or a "can't" from the
    // opener is not shown there, so it is steered to a plain "on it" line instead.
    const steer = opening.answeredCard
      ? `${state}用户刚回答了需求卡（点选或者直接打字，这一条消息就是回答）。这时不要再提任何问题，也不要说出卡里没给的店名、产品这类事实；用 SCRIPT，用半句话复述选的结果，说马上写剧本给他看。`
      : state ? `${state}这时用户的话一般是要改片或者追加东西（出图、加效果、换说法），用 WORK 或 SCRIPT 回一句"好，我……"（只是在问能做什么、和别人比怎么样，就用 REPLY 直接答），不要用 ASK 提问，也不要说做不到；以前对话里说过做不到的事，以能力清单为准。` : '';
    void writeOpener(recent, this.openingText(opening), opening.images, this.remembered, steer)
      .then((r) => {
        const used = Boolean(r.say) && this.turnId === id && !this.openingShown && !this.interrupted && this.pendingTurns > 0;
        // A restating line before the brief card is shown only at the start of a new video (nothing scripted or
        // made yet) and while the agent has not started on anything else; mid-project, the agent knows better.
        // It does not end the turn: the agent goes on to show the brief card.
        const fresh = !this.store.project.script && !this.store.project.versions.length && !this.store.project.shots.length;
        const asks = used && r.kind === 'ASK' && !this.stage && !this.toolStarted && fresh;
        // A capability or comparison question answered in full: that answer is the whole turn.
        const answers = used && r.kind === 'REPLY' && !this.stage && !this.toolStarted;
        this.trace('opener', { say: r.say, kind: r.kind, ms: Date.now() - t0, costUsd: r.costUsd, used, asks, answers });
        if (pricing.claudeBilled && r.costUsd > 0) ledger.record({ session: this.id, item: '开场回复', model: config.openerModel, usage: 'opener', usd: r.costUsd, basis: 'estimate' });
        // The agent started talking first; its line may still turn out to be junk (a lone "l"), and then this
        // one is shown instead.
        if (!used && r.say && this.turnId === id && !this.interrupted && (r.kind === 'WORK' || r.kind === 'SCRIPT')) this.spareOpening = r.say;
        if (!used || (r.kind === 'ASK' && !asks) || (r.kind === 'REPLY' && !answers)) return;
        this.emit({ type: 'bubble_end', id: randomUUID(), text: r.say });
        this.openingShown = true;
        this.openerSpoke = true;
        // The agent never saw this line; what it promised (a length, a shape, an approach) must be kept.
        if (!answers) this.inTurnNews.push(`${SAID_MARK}"${r.say}"`);
        if (answers) {
          // The line is this turn's whole answer: end the agent's turn quietly and tell it next time what
          // was said, so the user's next message makes sense to it.
          this.silentStop = true;
          this.carryNote = `（系统备注：上一轮用户的问题你已经回答了："${r.say}"。下面是用户的新消息。）`;
          this.persistSoon();
          void this.q?.interrupt().catch(() => {});
        }
      })
      .catch((e) => this.trace('opener_error', String((e as Error)?.message ?? e)));
  }

  private setStage(s: { stage: Stage; text: string } | null) {
    if (!s || (s.stage === this.stage && s.text === this.stageText)) return;
    // A question card only means "script awaiting confirmation" right after a script; otherwise no stage.
    if (s.stage === 'confirm' && this.stage !== 'script') return;
    this.stage = s.stage;
    this.stageText = s.text;
    this.emit({ type: 'stage', stage: s.stage, text: s.text });
  }

  /** What the bot says after the user presses stop: where it stopped and what is kept. */
  private stopSummary() {
    const ready = this.store.project.shots.filter((s) => s.status === 'ready').length;
    const where = this.stage ? `，刚才在${STAGE_NAME[this.stage]}这一步` : '';
    const kept = [ready ? `已经做好的 ${ready} 个镜头都留着` : '', hasPendingSeedance(this.id) ? '已经提交的写实镜头会在后台生成完' : ''].filter(Boolean).join('，');
    return `好，停下了${where}。${kept ? kept + '，' : ''}想怎么改直接说。`;
  }

  async interrupt() {
    // Stopping also means: clips still coming in are shown, but do not set the agent going again.
    this.quietJobs = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.jobNews = [];
    this.wakeAfterTurn = false;
    const system = this.waiting.filter((w) => !w.opening).length;
    if (system) {
      this.waiting = this.waiting.filter((w) => w.opening);
      this.pendingTurns -= system;
    }
    if (!this.q || !this.pendingTurns) return;
    this.interrupted = true;
    await this.q.interrupt().catch(() => {});
  }

  close() {
    this.closed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const t of this.batchTimers.values()) clearTimeout(t);
    this.inbox?.close();
  }

  private start() {
    this.inbox = makeInbox();
    this.started = false;
    this.liveModel = this.wantModel();
    this.liveEffort = settings.get().effort;
    const skills = enabledSkills().map((x) => x.name);
    this.skillsKey = skills.join(',');
    linkSkillsInto(this.store.dir, skills);
    const skillsRoot = skillsRealRoot();
    const remembered = memory.promptSection();
    this.remembered = remembered;
    if (remembered) this.trace('prompt_memory', remembered);
    const cwd = this.store.dir;
    const insideSkills = (p: string) => {
      const abs = isAbsolute(p) ? p : resolve(cwd, p);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        try {
          real = join(realpathSync(dirname(abs)), basename(abs));
        } catch {
          return false;
        }
      }
      return real === skillsRoot || real.startsWith(skillsRoot + sep);
    };
    const onPre: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const args = (input.tool_input ?? {}) as Record<string, unknown>;
      this.trace('tool_call', { tool: input.tool_name, input: args, id: input.tool_use_id, effort: (input as { effort?: { level: string } }).effort?.level });
      const deny = (reason: string) => {
        this.trace('tool_denied', { tool: input.tool_name, input: args, id: input.tool_use_id, reason });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } };
      };
      // Allow rules (including a skill's allowed-tools) skip canUseTool, but hooks always run first:
      // this is where file access is confined to the installed skills.
      if (input.tool_name === 'Skill') {
        const name = String(args.skill ?? args.name ?? args.command ?? '').replace(/^\//, '').split(/\s/)[0]!;
        if (!skills.includes(name)) return deny(`技能 ${name || '(空)'} 没有启用。可用的技能：${skills.join(', ') || '无'}`);
        this.emit({ type: 'skill_ref', skill: name });
        this.setStage(stageOf('Skill', args, false));
        return {};
      }
      if (['Read', 'Glob', 'Grep'].includes(input.tool_name)) {
        const raw = String(args.file_path ?? args.path ?? '');
        const pattern = String(args.pattern ?? '');
        const target = raw || (input.tool_name === 'Glob' && isAbsolute(pattern) ? pattern.replace(/[*?{[].*$/, '') : '');
        if ([pattern, String(args.glob ?? '')].some((x) => x.split(/[\\/]/).includes('..'))) return deny('匹配模式里不能有 ".."。');
        if (!target || !insideSkills(target)) return deny('Read/Glob/Grep 只能读技能目录（.claude/skills/<技能名>/...）。这个对话的素材不用自己找：上传的图和 generate_image 出的图在工具结果里都有文件名，直接把文件名传给工具（first_frame、reference_images、render_image_shot）；要用某个已做好镜头的画面当参考图，给 reference_images 传 "shot:镜头id"。');
        const real = (() => { try { return realpathSync(isAbsolute(target) ? target : resolve(cwd, target)); } catch { return target; } })();
        const rel = real.slice(skillsRoot.length + 1).split(sep);
        const card = rel[1] === 'references' && rel[2] === 'shots' && rel[4] ? rel[4].replace(/\.md$/, '') : rel[1] === 'demos' && rel[2] ? rel[2].replace(/\.[jt]sx?$/, '') : '';
        if (input.tool_name === 'Read' && card) this.emit({ type: 'skill_ref', skill: rel[0], item: card });
        this.setStage(stageOf(input.tool_name, args, false));
        return {};
      }
      // After a confirmation card the turn is the user's: anything the model still writes is not shown.
      // Suggestion cards after a video are different: the wrap-up may follow them.
      if (input.tool_name === `mcp__${STUDIO}__ask_user` && args.mode !== 'suggest') this.awaitingAnswer = true;
      this.setStage(stageOf(input.tool_name, args, false));
      return {};
    };
    const onPost: HookCallback = async (input) => {
      if (input.hook_event_name === 'PostToolUseFailure') {
        this.trace('tool_result', { tool: input.tool_name, id: input.tool_use_id, output: input.error, error: true, duration_ms: input.duration_ms });
      }
      if (input.hook_event_name === 'PostToolUse') {
        const out = Array.isArray(input.tool_response)
          ? (input.tool_response as Array<{ type: string; text?: string }>).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
          : input.tool_response;
        this.trace('tool_result', { tool: input.tool_name, id: input.tool_use_id, output: out, duration_ms: input.duration_ms });
        const name = input.tool_name.replace(`mcp__${STUDIO}__`, '');
        const shot = String((input.tool_input as Record<string, unknown>)?.shot_id ?? '');
        // Reading a skill file takes a moment; the long part is what comes after, so say that instead.
        if (['Skill', 'Read', 'Glob', 'Grep'].includes(name) && this.stage === 'skill') {
          this.setStage(this.store.project.shots.length ? { stage: 'shots', text: '正在构思镜头' } : { stage: 'plan', text: '正在规划分镜' });
        }
        // Both tools hand the model frames to look over before it moves on.
        if (name === 'assemble_video' && this.turnVideo) this.setStage({ stage: 'check', text: '正在检查成片' });
        else if (name === 'render_code_shot' && shot) this.setStage({ stage: 'shots', text: `正在检查镜头 ${shot}` });
        if (this.inTurnNews.length) {
          const news = this.inTurnNews.splice(0);
          this.mediaNote = null;
          const said = news.filter((x) => x.startsWith(SAID_MARK));
          const media = news.filter((x) => x.startsWith('用户上传的素材'));
          const shots = news.filter((x) => !said.includes(x) && !media.includes(x));
          return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: [
            ...said.map((x) => `（系统备注：这一轮开头已经替你对用户说了${x.slice(SAID_MARK.length)}。里面说到的时长、画幅和做法要兑现；做不到的，介绍成片时说明改了什么。）`),
            shots.length ? `（后台消息：写实镜头${shots.join('；')}。用得上就直接用，不用再等。）` : '',
            ...media.map((x) => `（后台消息：${x}）`),
          ].filter(Boolean).join('\n') } };
        }
      }
      return {};
    };
    this.q = query({
      prompt: this.inbox,
      options: {
        pathToClaudeCodeExecutable: claudeExecutable,
        model: this.wantModel(),
        effort: settings.get().effort,
        // Preferences are read when the CLI starts, so changes reach new conversations (and this one after a restart).
        systemPrompt: systemPrompt() + remembered,
        includePartialMessages: true,
        mcpServers: { [STUDIO]: createStudio(this.studioCtx) },
        tools: skills.length ? ['Skill', 'Read', 'Glob', 'Grep'] : [],
        allowedTools: skills.length ? [...STUDIO_TOOLS, 'Skill', 'Read', 'Glob', 'Grep'] : STUDIO_TOOLS,
        permissionMode: 'dontAsk',
        strictMcpConfig: true,
        // 'project' loads <cwd>/.claude/skills (linked above); 'user' is left out so a developer's personal
        // ~/.claude skills never reach this agent.
        settingSources: skills.length ? ['project'] : [],
        skills,
        // Skills are third-party content: their frontmatter hooks and inline shell commands never run.
        // Our own hooks above are SDK callbacks and keep working under this (checked with a hostile skill).
        settings: { disableSkillShellExecution: true },
        managedSettings: { disableAllHooks: true, disableSkillShellExecution: true, strictPluginOnlyCustomization: ['hooks'] },
        hooks: { PreToolUse: [{ hooks: [onPre] }], PostToolUse: [{ hooks: [onPost] }], PostToolUseFailure: [{ hooks: [onPost] }] },
        cwd: this.store.dir,
        env: childEnv,
        ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
        stderr: (d) => this.trace('cli_stderr', d),
      },
    });
    void this.consume(this.q);
  }

  /**
   * Once the opening line is out, the model tends to narrate between tool calls ("前三个镜头做好了…") although
   * the progress card already shows that. Text written after the opening is therefore held until the rest of
   * its model message is known: followed by another tool call it was narration and only goes to the
   * trajectory; at the end of the message it is a real reply (the wrap-up, a question) and is shown.
   */
  private endBubble() {
    const b = this.bubble;
    if (!b) return;
    this.bubble = null;
    // Broken characters (U+FFFD) are dropped first: the endpoint once sent a lone "ẹ\uFFFD" block before the reply.
    const text = cleanBubble(b.text.replace(/\uFFFD/g, ''), this.lastUserText());
    // Stray fragments such as ":" are not messages.
    const meaningful = text.length >= 2 && /[\p{L}\p{N}]/u.test(text);
    if (b.held) {
      if (meaningful) this.heldText = { id: b.id, text };
      return;
    }
    if (meaningful && this.holdWrongLanguage(text)) {
      this.emit({ type: 'bubble_drop', id: b.id });
      return;
    }
    if (!meaningful && this.spareOpening && !this.shownThisTurn()) {
      this.emit({ type: 'bubble_drop', id: b.id });
      this.emit({ type: 'bubble_end', id: randomUUID(), text: this.spareOpening });
      this.spareOpening = null;
      this.openerSpoke = true;
      return;
    }
    if (meaningful) {
      // Something in the user's language came after a held one: the held line is no longer worth repeating.
      if (this.wrongLanguage !== null && !languageMismatch(text, this.recentUserText())) this.wrongLanguage = '';
      this.emit({ type: 'bubble_end', id: b.id, text });
      this.openingShown = true;
    } else {
      this.emit({ type: 'bubble_drop', id: b.id });
      // A junk first line does not count as the opening: the opener's line may still take its place.
      if (!this.shownThisTurn()) this.openingShown = false;
    }
  }

  private flushHeld() {
    const h = this.heldText;
    if (!h) return;
    if (this.awaitingAnswer) return this.dropHeld();
    this.heldText = null;
    h.text = cleanBubble(h.text, this.lastUserText());
    if (!h.text) return;
    if (this.holdWrongLanguage(h.text)) return;
    if (this.wrongLanguage !== null && !languageMismatch(h.text, this.recentUserText())) this.wrongLanguage = '';
    this.emit({ type: 'bubble_end', id: h.id, text: h.text });
  }

  /**
   * A message in another language than the user's is not shown. Every such line in a turn is held, and at
   * the end of the turn the agent is asked once to say them again in the user's language. In that retry turn
   * a line still in the wrong language is translated here instead, so the agent is never asked twice and
   * nothing in the wrong language reaches the user.
   */
  private holdWrongLanguage(text: string) {
    if (!languageMismatch(text, this.recentUserText())) return false;
    if (this.languageRetry) {
      this.trace('language_translated', { text });
      const before = this.translating;
      this.translating = (before ?? Promise.resolve()).then(() => this.sayTranslated(text, this.turnId));
      return true;
    }
    this.wrongLanguage = this.wrongLanguage ? `${this.wrongLanguage}\n${text}` : text;
    this.trace('language_held', { text });
    return true;
  }

  /**
   * Shows `text` in the user's language, translated by a short call; dropped when that fails, or when the
   * conversation has moved on (another turn started) by the time it is ready.
   */
  private async sayTranslated(text: string, turnId: string | null) {
    const user = this.lastUserText();
    try {
      const { data, costUsd } = await askStructured<{ message_in_user_language: string }>({
        model: config.openerModel,
        system: '把要翻译的话翻成用户用的语言，意思和语气不变，口语自然，不加解释。引号里的原文（口播、台词、标题）照原样保留，不翻译。message_in_user_language 里只放翻好的这段话本身，纯文本，不要再套 JSON。',
        text: `要翻译的话：${text.slice(0, 1500)}\n\n用户说过的话（只用来判断语言）：${user.slice(0, 200)}`,
        schema: { type: 'object', properties: { message_in_user_language: { type: 'string', description: '翻译后的话，纯文本' } }, required: ['message_in_user_language'] },
      });
      if (pricing.claudeBilled && costUsd > 0) ledger.record({ session: this.id, item: '翻译回复', model: config.openerModel, usage: 'translate', usd: costUsd, basis: 'estimate' });
      // The model sometimes nests a JSON object inside the field ('{"translation": "…"}'): unwrapped.
      let raw = data.message_in_user_language.trim();
      if (raw.startsWith('{')) {
        try { raw = String(Object.values(JSON.parse(raw) as Record<string, unknown>).find((v) => typeof v === 'string') ?? ''); } catch { raw = ''; }
      }
      const said = cleanBubble(raw.trim(), user);
      if (this.turnId !== turnId) this.trace('translate_dropped', { text: said, reason: 'turn moved on' });
      else if (said && !said.includes('{"') && !languageMismatch(said, user)) this.emit({ type: 'bubble_end', id: randomUUID(), text: said });
      else this.trace('translate_dropped', { text: said });
    } catch (e) {
      this.trace('translate_error', String((e as Error)?.message ?? e));
    }
  }

  /** Whether anything reached the user in this turn: a message, a card, pictures or a video. */
  private shownThisTurn() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i]!;
      if (Number(e.ts) < this.turnStartedAt) break;
      if (['bubble_end', 'ask', 'script', 'images', 'video', 'file'].includes(e.type)) return true;
    }
    return false;
  }

  /** Ids of the messages shown after this turn's newest video. */
  private bubblesSinceVideo() {
    const ids: string[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i]!;
      if (Number(e.ts) < this.turnStartedAt || e.type === 'video') break;
      if (e.type === 'bubble_end') ids.push(String(e.id));
    }
    return ids;
  }

  /** Whether, after this turn's newest video, the user got at least 30 characters about it in their language. */
  private introducedVideo() {
    let at = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i]!;
      if (Number(e.ts) < this.turnStartedAt) break;
      if (e.type === 'video') { at = i; break; }
    }
    if (at < 0) return true;
    return this.history.slice(at).some((e) => e.type === 'bubble_end' && String(e.text ?? '').replace(/\s/g, '').length >= 30 && !languageMismatch(String(e.text), this.recentUserText()));
  }

  private dropHeld() {
    if (!this.heldText) return;
    this.trace('narration', { text: this.heldText.text });
    this.heldText = null;
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) {
        this.lastActive = Date.now();
        if (m.type === 'stream_event') {
          if (m.parent_tool_use_id) continue;
          const ev = m.event;
          // The first request is answering; the next one (and the rest of the turn) thinks again.
          if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
            this.endBubble();
            this.flushHeld(); // two text blocks in a row: the first was meant for the user
            this.bubble = { id: randomUUID(), text: '', held: this.openingShown };
            if (!this.bubble.held) {
              this.emit({ type: 'bubble_start', id: this.bubble.id });
              // The agent is already talking; an opener line arriving now would be a second opening.
              this.openingShown = true;
            }
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.bubble) {
            this.bubble.text += ev.delta.text;
            if (!this.bubble.held) this.emit({ type: 'delta', id: this.bubble.id, text: ev.delta.text });
          } else if (ev.type === 'message_stop') {
            this.endBubble();
            this.flushHeld();
          } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            this.toolStarted = true;
            // Text right before a script or question card introduces it (unless the opener already spoke);
            // other text before a tool is narration.
            // (After the opening, e.g. the introduction of a new version before the next-step card, it always is.)
            if (CARD_TOOLS.has(ev.content_block.name) && (!this.openerSpoke || this.toolCalls > 0 || this.turnVideo)) this.flushHeld();
            // A short line to the user between steps ("主角定好了，开始拍") is shown; talking to itself, a
            // line in another language than the user's, or a repeat of the opener's plan is not.
            else if (this.heldText && !(this.openerSpoke && this.toolCalls === 0) && isUpdateForUser(this.heldText.text, this.lastUserText(), this.lastBotText())) this.flushHeld();
            else this.dropHeld();
            this.toolCalls++;
            // Show the stage while the model is still writing the call (a scene's HTML can take a minute).
            this.drafting = { name: ev.content_block.name, json: '', shot: '' };
            this.setStage(stageOf(this.drafting.name, {}, true));
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta' && this.drafting && !this.drafting.shot && this.drafting.json.length < 4000) {
            this.drafting.json += ev.delta.partial_json;
            const shot = /"shot_id"\s*:\s*"([^"]+)"/.exec(this.drafting.json)?.[1];
            if (shot) {
              this.drafting.shot = shot;
              this.setStage(stageOf(this.drafting.name, { shot_id: shot }, true));
            }
          } else if (ev.type === 'content_block_stop') {
            this.drafting = null;
            this.endBubble();
          }
          continue;
        }
        // The init message lists local paths (cwd, memory and socket paths); the trajectory is exported, so keep only what matters.
        this.trace('sdk', m.type === 'system' && m.subtype === 'init' ? { type: 'system', subtype: 'init', model: m.model, tools: m.tools, skills: m.skills, session_id: m.session_id } : m);
        if (m.type === 'system' && m.subtype === 'init') {
          if (!this.started) this.trace('init', { skills: m.skills, tools: m.tools });
          this.started = true;
          if (!this.sdkSessionId) {
            this.sdkSessionId = m.session_id;
            this.persistSoon();
          }
        } else if (m.type === 'result') {
          const quiet = this.silentStop;
          this.silentStop = false;
          if (m.subtype === 'success') serviceHealth.claudeOkAt = Date.now();
          else if (!quiet) serviceHealth.claudeErrorAt = Date.now();
          // Ended because the opener's question answered the turn: whatever the agent had begun stays unseen.
          if (quiet) { this.heldText = null; if (this.bubble?.held) this.bubble = null; }
          this.endBubble();
          this.flushHeld();
          // A line being translated (the retry turn's line still came in the wrong language) is part of this
          // turn: it lands before turn_end, and the follow-ups below see it as shown.
          if (this.translating) {
            await Promise.race([this.translating, new Promise<void>((r) => setTimeout(r, TRANSLATE_WAIT_MS).unref())]);
            this.translating = null;
          }
          // total_cost_usd is a running total for this query; book only the increase, and only when
          // Claude is billed through a configured endpoint (the SDK's figure is an estimate).
          const turnUsd = m.total_cost_usd >= this.queryCostUsd ? m.total_cost_usd - this.queryCostUsd : m.total_cost_usd;
          this.queryCostUsd = m.total_cost_usd;
          this.costUsd += turnUsd;
          if (pricing.claudeBilled) {
            const warning = ledger.record({ session: this.id, item: this.store.project.title || '对话', model: this.liveModel || config.model, usage: `${m.num_turns} turns`, usd: turnUsd, basis: 'estimate' });
            if (warning) this.emit({ type: 'toast', level: 'warn', text: warning });
            this.emit({ type: 'budget' });
          }
          this.pendingTurns = Math.max(0, this.pendingTurns - 1);
          if (!this.pendingTurns) this.emit({ type: 'typing', on: false });
          const stopped = this.interrupted && !quiet;
          this.interrupted = false;
          this.drafting = null;
          if (stopped) this.emit({ type: 'bubble_end', id: randomUUID(), text: this.stopSummary() });
          else if (m.subtype !== 'success' && !quiet) this.emit({ type: 'system', text: '本轮处理出错，未能完成，请重新发送。' });
          const background = pendingShotIds(this.id, this.store.project.shots).length;
          this.emit({ type: 'turn_end', ok: quiet || m.subtype === 'success', costUsd: this.costUsd, ...(background ? { background } : {}), ...(stopped ? { stopped: true } : {}), ...(quiet ? { asked: true } : {}), ...(m.subtype === 'success' || quiet ? {} : { errors: m.errors }) });
          if (this.turnId) afterTurn(this.target(), this.turnId);
          const madeVideo = this.turnVideo;
          if (this.mediaNote) {
            const note = this.mediaNote;
            this.mediaNote = null;
            this.inTurnNews = this.inTurnNews.filter((x) => x !== note);
            this.queueSystem(`（系统通知，不是用户发的，不要原样转述：${note}）`);
          }
          // Follow-ups for this turn (introduce the new version, or say it again in the user's language) are
          // pointless once the user has written again: their message comes first and may change everything.
          const userWaiting = this.waiting.some((w) => w.opening);
          // Read before anything is queued: starting the next turn resets it.
          const heldLine = this.wrongLanguage;
          // A turn that ended having shown nothing and done nothing (the model returned a stray character and
          // stopped): it is continued once. Not a turn whose line was only held for its language (the language
          // retry follows) and not the language retry itself (its line was translated), or the two retries
          // could take turns without end.
          if (!stopped && !quiet && !userWaiting && !this.emptyRetry && !this.languageRetry && !heldLine && this.toolCalls === 0 && !this.shownThisTurn() && m.subtype === 'success') {
            this.trace('empty_turn', { turnId: this.turnId });
            this.queueSystem(`（系统提示，不是用户发的${EMPTY_RETRY_MARK}：你上一轮没有回复用户，也没有做任何事。接着处理用户刚才的消息，先用一句话回应，再开始做；不要提这条提示。）`);
          }
          // A new version the user was never told about in words: asked for once, in a turn of its own.
          if (madeVideo && !stopped && !userWaiting && !this.introRetry && !this.introducedVideo()) {
            this.trace('intro_missing', { turnId: this.turnId });
            // What was said after the video (a contentless "pick something below") is taken back: the
            // introduction that follows says it properly.
            const after = this.bubblesSinceVideo();
            if (after.length) this.emit({ type: 'retract', ids: after });
            // The introduction re-says the version in the user's language anyway: no separate language retry.
            this.wrongLanguage = null;
            this.queueSystem(`（系统提示，不是用户发的${INTRO_RETRY_MARK}：你刚出了新的一版，可是还没跟用户介绍。用两三句话、用用户的语言具体说说这一版：开头、中段、结尾各是什么画面，口播和字幕，画面上的关键文字，只说抽帧里看得到的。建议卡已经给过了，这次不要再调用 ask_user，也不要提这条提示。）`);
          }
          // '' = a wrong-language line was held but later superseded by one in the user's language.
          if (heldLine && this.wrongLanguage !== null && !stopped && !userWaiting) {
            const said = heldLine;
            this.wrongLanguage = null;
            this.queueSystem(`（系统提示，不是用户发的${LANGUAGE_RETRY_MARK}：你刚才这段话没有用用户的语言，用户看不到。用和用户一样的语言把它重新说一遍，意思不变，不要提这条提示：${said}）`);
          }
          // News from the background that arrived during this turn: dropped if the turn already made a new
          // version (it used the clips), otherwise the agent is told now.
          if (this.wakeAfterTurn) {
            this.wakeAfterTurn = false;
            // Only what the newest version already used is dropped; clips that landed after it still need it.
            if (madeVideo) this.jobNews = this.jobNews.filter((n) => n.at > this.lastVideoAt);
            if (!this.jobNews.length) { /* nothing left to tell */ }
            else if (this.waiting.length) this.wakeAfterTurn = true; // after the user's queued message instead
            else this.wakeForJobs();
          }
          const next = this.waiting.shift();
          if (next) this.beginTurn(next.id, next.msg, next.opening);
        }
      }
    } catch (e) {
      this.trace('error', String(e));
      serviceHealth.claudeErrorAt = Date.now();
      serviceHealth.claudeError = String((e as Error).message ?? e).slice(0, 200);
      if (!this.started && this.sdkSessionId) {
        // The saved conversation could not be resumed (e.g. its transcript was removed); start fresh next time.
        this.sdkSessionId = undefined;
        this.persistSoon();
        this.emit({ type: 'system', text: '无法恢复之前的对话上下文，重新发送消息将开始新的上下文；已生成的镜头和视频均已保留。' });
      } else {
        this.emit({ type: 'system', text: '连接模型出错，重新发送消息将自动重连。' });
      }
    } finally {
      // A query replaced on purpose (enabled skills changed) ends after its successor has started a turn:
      // that turn's state belongs to the new query, so only the current one cleans up.
      const current = this.q === q || this.q === null;
      if (this.q === q) {
        this.q = null;
        this.inbox = null;
      }
      if (current) this.cleanupAfterQuery();
    }
  }

  private cleanupAfterQuery() {
    this.silentStop = false;
    this.endBubble();
    this.flushHeld();
    if (this.pendingTurns > this.waiting.length) {
      // The running turn never got its result: close it so the trajectory and the progress card end too.
      this.emit({ type: 'turn_end', ok: false, costUsd: this.costUsd, errors: ['connection lost'] });
      if (this.turnId) afterTurn(this.target(), this.turnId);
    }
    if (this.waiting.length) {
      this.waiting = [];
      this.emit({ type: 'system', text: '排队中的消息未能处理，请重新发送。' });
    }
    if (this.pendingTurns) {
      this.pendingTurns = 0;
      this.emit({ type: 'typing', on: false });
    }
  }
}
