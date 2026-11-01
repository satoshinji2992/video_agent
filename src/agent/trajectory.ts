// Turns a session's trajectory.jsonl into per-turn timelines for the trajectory panel and the reviewer.
import { existsSync, readFileSync } from 'node:fs';
import { isClaudeModel, readEntries } from '../core/ledger.ts';

interface Line { ts: string; kind: string; data: Record<string, unknown> }

export interface Arg { key: string; value: string; long: boolean }
export interface TurnEvent {
  /** ms since the turn started */
  t: number;
  kind: 'stage' | 'bot' | 'tool' | 'video' | 'approval' | 'system' | 'note' | 'narration' | 'script' | 'ask';
  text?: string;
  stage?: string;
  tool?: string;
  id?: string;
  args?: Arg[];
  output?: string;
  ms?: number;
  denied?: string;
  /** the tool ran but failed; `output` holds the error */
  failed?: boolean;
  version?: number;
}
export interface Review {
  turnId: string;
  scores: { speed: number; naturalness: number; adherence: number; quality: number | null; judgment?: number | null };
  comments: string;
  model: string;
  costUsd: number;
  ts: string;
}
export interface Feedback { version: number; rating: 'up' | 'down'; comment: string; ts: string }
export interface Turn {
  id: string;
  index: number;
  start: number;
  end: number | null;
  user: { text: string; images: number; skill?: string };
  ok: boolean | null;
  stopped: boolean;
  events: TurnEvent[];
  stages: Array<{ stage: string; ms: number }>;
  versions: Array<{ n: number; seconds: number; url: string; poster: string }>;
  claudeUsd: number;
  seedanceUsd: number;
  tokens: { input: number; output: number; cacheRead: number } | null;
  firstReplyMs: number | null;
  longestGap: { ms: number; after: string } | null;
  review: Review | null;
  /** why the background review of this turn failed, if it did */
  reviewError: string | null;
  feedback: Feedback[];
}

export const STAGE_NAMES: Record<string, string> = { skill: '查阅技能', plan: '分镜规划', shots: '镜头制作', assemble: '合成', check: '质检' };

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function args(input: unknown): Arg[] {
  if (!input || typeof input !== 'object') return [];
  return Object.entries(input as Record<string, unknown>).map(([key, v]) => {
    const value = typeof v === 'string' ? v : JSON.stringify(v);
    return { key, value: value.slice(0, 60_000), long: value.length > 160 };
  });
}

function outputText(out: unknown): string {
  const text = Array.isArray(out) ? out.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : typeof out === 'string' ? out : JSON.stringify(out ?? '');
  // The CLI notes where it cached each image on this machine; that path means nothing to a reader.
  return short(text.replace(/^\[Image: source: [^\]]*\]$/gm, '').trim(), 1200);
}

function describe(l: Line): string {
  if (l.kind === 'ui') {
    const e = l.data;
    if (e.type === 'stage') return `阶段「${e.text}」`;
    if (e.type === 'bubble_end') return `回复「${short(String(e.text), 30)}」`;
    return String(e.type);
  }
  if (l.kind === 'tool_call' || l.kind === 'tool_result') return `${l.kind === 'tool_call' ? '调用' : '工具返回'} ${String(l.data.tool).replace(/^mcp__studio__/, '')}`;
  return l.kind;
}

export function readLines(file: string): Line[] {
  if (!existsSync(file)) return [];
  const out: Line[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch {}
  }
  return out;
}

/** Every turn of a session, oldest first. */
export function buildTurns(file: string, session: string): Turn[] {
  const lines = readLines(file);
  const turns: Turn[] = [];
  const users = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, TurnEvent & { at: number }>();
  const reviews = new Map<string, Review>();
  const reviewErrors = new Map<string, string>();
  // Lines from background jobs and bookkeeping; they say nothing about how long the agent kept the user waiting.
  // Narration was held back from the chat, so it does not end a silence the user sat through either.
  const QUIET = new Set(['heartbeat', 'system_turn', 'cli_stderr', 'sdk', 'init', 'user', 'memory', 'review_error', 'memory_error', 'prompt_memory', 'error', 'feedback', 'review', 'narration', 'opener', 'opener_error']);
  const feedback: Feedback[] = [];
  let cur: Turn | null = null;
  let lastCost = 0;
  let stage = null as { stage: string; at: number } | null;
  let prevAt = 0, prevDesc = '';

  const open = (id: string, at: number, u: Record<string, unknown> | undefined) => {
    const prev = cur as Turn | null;
    if (prev && prev.end === null) {
      // The previous turn never got a turn_end (crash or restart): close it where its last line was.
      closeStage(prevAt);
      prev.end = prevAt;
      prev.ok = false;
    }
    closeStage(at);
    cur = {
      id, index: turns.length + 1, start: at, end: null,
      user: { text: String(u?.text ?? ''), images: Array.isArray(u?.images) ? u!.images.length : 0, ...(u?.skill ? { skill: String(u.skill) } : {}) },
      ok: null, stopped: false, events: [], stages: [], versions: [], claudeUsd: 0, seedanceUsd: 0, tokens: null,
      firstReplyMs: null, longestGap: null, review: null, reviewError: null, feedback: [],
    };
    turns.push(cur);
    prevAt = at; prevDesc = '用户发消息';
  };
  const closeStage = (at: number) => {
    if (cur && stage) {
      const s = cur.stages.find((x) => x.stage === stage!.stage);
      if (s) s.ms += at - stage.at; else cur.stages.push({ stage: stage.stage, ms: at - stage.at });
    }
    stage = null;
  };

  for (const l of lines) {
    const at = Date.parse(l.ts);
    const d = l.data ?? {};
    if (l.kind === 'review') { reviews.set(String(d.turnId), d as unknown as Review); continue; }
    if (l.kind === 'review_error' && d && typeof d === 'object' && d.turnId) { reviewErrors.set(String(d.turnId), String(d.error ?? '')); continue; }
    if (l.kind === 'feedback') { feedback.push(d as unknown as Feedback); continue; }
    if (l.kind === 'ui' && d.type === 'user') {
      if (d.rejected) {
        // Refused before reaching the model (budget used up); not a turn of its own.
        const t = cur as Turn | null;
        if (t && t.end === null) t.events.push({ t: at - t.start, kind: 'system', text: `用户消息未处理（生成额度已用完）：${short(String(d.text ?? ''), 40)}` });
      } else if (d.id) users.set(String(d.id), d);
      else open(`legacy-${at}`, at, d); // written before messages had ids and turn_start existed
      continue;
    }
    // A turn the system started (background results arrived, or a restart cut the last one off) has no user message.
    if (l.kind === 'ui' && d.type === 'turn_start') { open(String(d.id), at, users.get(String(d.id)) ?? (d.system ? { text: '（后台结果到达，自动继续）' } : undefined)); continue; }
    const t = cur as Turn | null;
    if (!t || t.end !== null) continue;
    const quiet = QUIET.has(l.kind) || (l.kind === 'ui' && ['typing', 'feedback', 'budget', 'toast', 'retract'].includes(String(d.type)));
    if (!quiet) {
      if (at - prevAt > (t.longestGap?.ms ?? 0)) t.longestGap = { ms: at - prevAt, after: prevDesc };
      prevAt = at;
      prevDesc = describe(l);
    }
    const rel = at - t.start;
    if (l.kind === 'tool_call') {
      const ev = { t: rel, at, kind: 'tool' as const, tool: String(d.tool).replace(/^mcp__studio__/, ''), id: String(d.id), args: args(d.input) };
      tools.set(String(d.id), ev);
      t.events.push(ev);
    } else if (l.kind === 'tool_result') {
      const ev = tools.get(String(d.id));
      if (ev) {
        ev.output = outputText(d.output);
        ev.ms = typeof d.duration_ms === 'number' ? d.duration_ms : at - ev.at;
        if (d.error) ev.failed = true;
      }
    } else if (l.kind === 'tool_denied') {
      const ev = tools.get(String(d.id));
      if (ev) ev.denied = String(d.reason ?? '');
    } else if (l.kind === 'narration') {
      t.events.push({ t: rel, kind: 'narration', text: String(d.text ?? '') });
    } else if (l.kind === 'sdk' && d.type === 'result') {
      const u = d.usage as Record<string, number> | undefined;
      if (u) t.tokens = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
    } else if (l.kind === 'ui') {
      switch (d.type) {
        case 'stage':
          if (stage?.stage !== d.stage) {
            closeStage(at);
            stage = { stage: String(d.stage), at };
            t.events.push({ t: rel, kind: 'stage', stage: String(d.stage), text: STAGE_NAMES[String(d.stage)] ?? String(d.stage) });
          }
          break;
        case 'bubble_end':
          if (t.firstReplyMs === null) t.firstReplyMs = rel;
          t.events.push({ t: rel, kind: 'bot', text: String(d.text) });
          break;
        case 'video':
          t.versions.push({ n: Number(d.version), seconds: Number(d.seconds), url: String(d.url), poster: String(d.poster) });
          t.events.push({ t: rel, kind: 'video', version: Number(d.version), text: `第 ${d.version} 版 · ${d.seconds} 秒` });
          break;
        case 'approval': t.events.push({ t: rel, kind: 'approval', text: `确认卡片：${d.title}` }); break;
        case 'approval_result': t.events.push({ t: rel, kind: 'approval', text: d.ok ? '用户已允许' : d.reason === 'expired' ? '确认超时' : '用户已拒绝' }); break;
        case 'system': t.events.push({ t: rel, kind: 'system', text: String(d.text) }); break;
        case 'note': t.events.push({ t: rel, kind: 'note', text: String(d.text) }); break;
        case 'script': {
          const segs = (d.segments as Array<{ role: string; start: number; end: number; vo?: string }>) ?? [];
          const changed = (d.changed as string[]) ?? [];
          t.events.push({ t: rel, kind: 'script', text: `剧本卡第 ${d.version} 版：${d.title}，${d.total_seconds} 秒 ${d.aspect}，口播 ${d.vo_language}，${segs.length} 段（${segs.map((g) => `${g.start}-${g.end}s ${g.role}`).join(' / ')}）${changed.length ? `，改动：${changed.join('、')}` : ''}；判断：${d.insight}；来源 ${(d.sources as unknown[])?.length ?? 0} 个` });
          break;
        }
        case 'ask': t.events.push({ t: rel, kind: 'ask', text: `问题卡：${d.question}（${(d.options as string[]).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}${d.recommended === i ? '（推荐）' : ''}`).join(' ')}）` }); break;
        case 'turn_end': {
          closeStage(at);
          t.end = at;
          t.ok = d.ok !== false;
          t.stopped = Boolean(d.stopped);
          const cost = Number(d.costUsd ?? lastCost);
          t.claudeUsd = Math.max(0, cost - lastCost);
          lastCost = cost;
          break;
        }
      }
    }
  }

  // Seedance charges are booked when a clip finishes; give each turn those that landed before the next turn began.
  const entries = readEntries().filter((e) => e.session === session && !isClaudeModel(e.model));
  turns.forEach((t, i) => {
    const until = turns[i + 1]?.start ?? Infinity;
    t.seedanceUsd = entries.filter((e) => { const at = Date.parse(e.ts); return at >= t.start && at < until; }).reduce((a, e) => a + e.usd, 0);
    t.review = reviews.get(t.id) ?? null;
    t.reviewError = t.review ? null : reviewErrors.get(t.id) ?? null;
    // A rating followed by a remark is two lines; only the latest per version counts.
    const latest = new Map(feedback.filter((f) => t.versions.some((v) => v.n === f.version)).map((f) => [f.version, f]));
    t.feedback = [...latest.values()];
  });
  return turns;
}
