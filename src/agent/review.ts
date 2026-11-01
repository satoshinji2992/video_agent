// Background work after each turn: score the turn (speed, naturalness, adherence, video quality) and keep the
// shared preference memory up to date. One job at a time, so memory.json is never written concurrently.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/config.ts';
import { createLimiter } from '../core/limiter.ts';
import { ledger, pricing } from '../core/ledger.ts';
import { AskError, askStructured, type Img } from '../providers/llm.ts';
import { CATEGORIES, memory, type MemoryOp } from './memory.ts';
import { settings } from '../core/settings.ts';
import { buildTurns, STAGE_NAMES, type Feedback, type Turn } from './trajectory.ts';

export const REVIEWS_FILE = join(config.dataDir, 'reviews.jsonl');
const jobs = createLimiter(1);
/** Held back before a review call when Claude is billed, since the cost is only known afterwards. */
const RESERVE_USD = 0.3;

interface Target { dir: string; session: string; title: string; emit?: (e: Record<string, unknown>) => void }
/** Turns whose review is queued or running, for the panel's "点评生成中" state. */
const pending = new Set<string>();
/** Feedback-triggered calls beyond this many queued jobs are dropped, so a script cannot run up the bill. */
const MAX_QUEUED = 20;

const sec = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} 秒`);

function describeTurn(t: Turn) {
  const lines = [`用户：${t.user.text || '（只发了图片）'}${t.user.images ? `（附 ${t.user.images} 张图）` : ''}${t.user.skill ? `（指定技能 ${t.user.skill}）` : ''}`];
  for (const e of t.events) {
    const at = `[+${(e.t / 1000).toFixed(0)}s]`;
    if (e.kind === 'bot') lines.push(`${at} 助手：${e.text}`);
    else if (e.kind === 'narration') lines.push(`${at} （助手写了一句工作旁白，系统没有显示给用户：${e.text}）`);
    else if (e.kind === 'stage') lines.push(`${at} 进入阶段：${e.text}`);
    else if (e.kind === 'tool') {
      const a = (e.args ?? []).map((x) => `${x.key}=${x.long ? `<${x.value.length} 字>` : x.value}`).join(', ');
      lines.push(`${at} 工具 ${e.tool}(${a}) 用时 ${sec(e.ms)}${e.denied ? ` 被拒绝：${e.denied}` : ''}${e.output ? ` → ${e.output.slice(0, 300).replace(/\n/g, ' ')}` : ''}`);
    } else lines.push(`${at} ${e.text}`);
  }
  return lines.join('\n');
}

function metrics(t: Turn) {
  const total = t.end ? t.end - t.start : null;
  return [
    `首次回复：${sec(t.firstReplyMs)}`,
    `本轮总用时：${sec(total)}`,
    `最长空档：${t.longestGap ? `${sec(t.longestGap.ms)}（在「${t.longestGap.after}」之后）` : '—'}`,
    `各阶段用时：${t.stages.map((s) => `${STAGE_NAMES[s.stage] ?? s.stage} ${sec(s.ms)}`).join('，') || '—'}`,
    `产出版本：${t.versions.map((v) => `第 ${v.n} 版 ${v.seconds} 秒`).join('，') || '无'}`,
    `结束方式：${t.stopped ? '用户中途停止' : t.ok === false ? '出错' : '正常'}`,
  ].join('\n');
}

const REVIEW_RUBRIC = `你在给一个"聊天做视频"的助手打分（什么视频都做：广告、讲解、祝福、故事、MV 等），对象是它和用户的一个回合。四项各 1–5 分，5 最好，要有区分度，不要都给 4：
- speed 响应速度：按片长折算。首次回复 10 秒内、每 10 秒成片 1.5 分钟以内出完（30 秒的片子 4.5 分钟、2 分钟的片子 18 分钟以内都算正常）、中间没有超过 60 秒的空档算好；空档长、拖沓扣分。
- naturalness 对话自然度：像真人导演那样说话。出现表格、列选项让用户挑、提到金额/价格/预算/费用、一次问超过一个问题、提到工具名或技术词（HTML、Remotion、渲染参数等）都扣分。
- adherence 需求遵循：这一轮用户要的有没有做到，之前定下的要求有没有被改丢；没改动的镜头被重做也扣分。
- quality 成片质量：只看附图（成片抽帧）——字是否清楚、有没有出框或遮挡、画面是否统一好看、想表达的内容有没有表达清楚。本轮没有成片时填 null。
- judgment 剧本与判断：提的问题是否必要（能推断的不该问，缺关键信息才问，每次最多一两点）、剧本是否清楚可执行、对受众和渠道的判断（insight、口播语言、画幅）是否到位、数字有没有出处。本轮既没有提问也没有剧本时填 null。
comments 写 2–3 句中文，点出最具体的问题和改进建议，尽量带数字。用书面、简洁的陈述句，不用口语词和感叹，例如"分镜规划前等待 100 秒，无任何反馈。""修改结尾时重新制作了未改动的开场镜头。"。`;

const MEMORY_RULES = `同时维护一份"用户偏好记忆"（所有对话共用）。只记有证据的偏好：用户亲口说的要求、对成片的 👍/👎 和附言、改需求前后的对比（比如"字再大一点""别用这么花的配色"）最能说明审美。不要猜。只记风格和习惯：喜欢的节奏、配色、字体、文案语气、常用平台、不要的东西。不要记任何具体项目的事实：店名、品牌名、产品、价格、地址、日期、人名都属于某一条片子，记下来会被套到别的片子上，变成编造的事实。用户为这一条片子提的平台、时长、画幅是这条片子的需求，不是长期偏好；只有在多个对话里反复出现，或者用户说了"以后都…""我们一般…"，才记成偏好。
类别只能是：${CATEGORIES.join('、')}。
用 memory_ops 输出改动：
- add：新偏好，必须带 quote（用户原话，尽量短）。
- update：已有条目被再次印证或需要修正（和新信息冲突时改成新的说法，不要留下互相矛盾的两条），带 id 和 quote，可给新的 confidence。
- delete：已有条目被用户明确推翻、又不值得改写时删除。
confidence 取 0–1：说过一次 0.5 左右，多次印证或明确强调 0.8 以上。没有值得记的就输出空数组。
content 用书面、简洁的陈述，例如"偏好简洁、低饱和的配色，避免繁杂装饰。"，不要照抄口语。`;

function schema(withReview: boolean, withMemory: boolean) {
  const score = { type: 'integer', minimum: 1, maximum: 5 };
  const props: Record<string, unknown> = {};
  if (withReview) {
    props.review = {
      type: 'object',
      properties: { speed: score, naturalness: score, adherence: score, quality: { anyOf: [score, { type: 'null' }] }, judgment: { anyOf: [score, { type: 'null' }] }, comments: { type: 'string' } },
      required: ['speed', 'naturalness', 'adherence', 'quality', 'judgment', 'comments'],
    };
  }
  if (withMemory) {
    props.memory_ops = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'delete'] }, id: { type: 'string' }, category: { type: 'string', enum: [...CATEGORIES] },
          content: { type: 'string' }, quote: { type: 'string' }, confidence: { type: 'number' },
        },
        required: ['op'],
      },
    };
  }
  return { type: 'object', properties: props, required: Object.keys(props) };
}

function memoryList() {
  const items = memory.list().sort((a, b) => b.confidence - a.confidence).slice(0, 40);
  return items.length ? items.map((m) => `- id=${m.id} [${m.category}] ${m.content}（置信度 ${m.confidence.toFixed(2)}，${m.source === 'manual' ? '手动' : '自动'}）`).join('\n') : '（还没有）';
}

function canAfford() {
  return !pricing.claudeBilled || ledger.canSpend(RESERVE_USD);
}

function book(target: Target, item: string, usd: number) {
  if (!pricing.claudeBilled || usd <= 0) return;
  const warning = ledger.record({ session: target.session, item, model: config.review.model, usage: 'background', usd, basis: 'estimate' });
  if (warning) target.emit?.({ type: 'toast', level: 'warn', text: warning });
  target.emit?.({ type: 'budget' });
}

const score = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : null);

function trace(target: Target, kind: string, data: unknown) {
  const file = join(target.dir, 'trajectory.jsonl');
  // The conversation may have been deleted in the meantime.
  if (existsSync(file)) appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + '\n');
}

async function reviewTurn(target: Target, turnId: string) {
  const s = settings.get();
  if (!s.reviewEnabled && !s.memoryAutoUpdate) return;
  if (!canAfford()) return;
  const turns = buildTurns(join(target.dir, 'trajectory.jsonl'), target.session);
  const turn = turns.find((t) => t.id === turnId);
  if (!turn || turn.end === null) return;
  const earlier = turns.slice(Math.max(0, turn.index - 4), turn.index - 1)
    .map((t) => `第 ${t.index} 轮 用户：${t.user.text}\n${t.events.filter((e) => e.kind === 'bot').map((e) => `助手：${e.text}`).join('\n')}`).join('\n\n');
  const images: Img[] = [];
  const v = turn.versions.at(-1);
  const sheet = v ? join(target.dir, `versions/v${v.n}.sheet.png`) : '';
  if (sheet && existsSync(sheet)) images.push({ mime: 'image/png', data: readFileSync(sheet) });
  const text = [
    `对话：「${target.title}」，这是第 ${turn.index} 轮。`,
    earlier ? `## 之前几轮\n${earlier}` : '',
    `## 这一轮的客观数据\n${metrics(turn)}`,
    `## 这一轮的经过\n${describeTurn(turn)}`,
    images.length ? '附图是这一轮最后一版成片的抽帧。' : '这一轮没有出成片。',
    s.memoryAutoUpdate ? `## 现有的偏好记忆\n${memoryList()}` : '',
  ].filter(Boolean).join('\n\n');
  const system = [s.reviewEnabled ? REVIEW_RUBRIC : '', s.memoryAutoUpdate ? MEMORY_RULES : ''].filter(Boolean).join('\n\n') + '\n\n只输出要求的 JSON。';
  const { data, costUsd } = await askStructured<{ review?: { speed: number; naturalness: number; adherence: number; quality: number | null; judgment?: number | null; comments: string }; memory_ops?: MemoryOp[] }>({
    model: config.review.model, system, text, images, schema: schema(s.reviewEnabled, s.memoryAutoUpdate),
  });
  book(target, s.reviewEnabled ? '点评' : '记忆整理', costUsd);
  if (s.reviewEnabled && data.review) {
    const r = data.review;
    const review = {
      turnId, model: config.review.model, costUsd, ts: new Date().toISOString(),
      scores: { speed: score(r.speed) ?? 3, naturalness: score(r.naturalness) ?? 3, adherence: score(r.adherence) ?? 3, quality: images.length ? score(r.quality) : null, judgment: score(r.judgment) },
      comments: String(r.comments ?? '').slice(0, 600),
    };
    trace(target, 'review', review);
    appendFileSync(REVIEWS_FILE, JSON.stringify({ session: target.session, title: target.title, index: turn.index, turnStart: new Date(turn.start).toISOString(), ...review }) + '\n');
  }
  if (s.memoryAutoUpdate && data.memory_ops?.length) {
    const changed = memory.apply(data.memory_ops, target.session);
    if (changed.length) trace(target, 'memory', { turnId, changed });
  }
}

async function learnFromFeedback(target: Target, f: Feedback) {
  if (!settings.get().memoryAutoUpdate || !canAfford()) return;
  const turns = buildTurns(join(target.dir, 'trajectory.jsonl'), target.session);
  const turn = turns.find((t) => t.versions.some((v) => v.n === f.version));
  const history = turns.filter((t) => !turn || t.index <= turn.index).slice(-4).map((t) => `第 ${t.index} 轮 用户：${t.user.text}`).join('\n');
  const images: Img[] = [];
  const sheet = join(target.dir, `versions/v${f.version}.sheet.png`);
  if (existsSync(sheet)) images.push({ mime: 'image/png', data: readFileSync(sheet) });
  const text = [
    `对话：「${target.title}」。用户刚给第 ${f.version} 版成片点了 ${f.rating === 'up' ? '👍（喜欢）' : '👎（不喜欢）'}${f.comment ? `，附言："${f.comment}"` : '，没有附言'}。`,
    images.length ? '附图是这一版成片的抽帧，结合画面理解用户喜欢或不喜欢的是什么。' : '',
    `## 这个对话里用户说过的话\n${history || '（无）'}`,
    `## 现有的偏好记忆\n${memoryList()}`,
    '附言就是 quote 的来源；没有附言时，只有画面特征非常明显才记，quote 写"👍 第 N 版"或"👎 第 N 版"。',
  ].filter(Boolean).join('\n\n');
  const { data, costUsd } = await askStructured<{ memory_ops?: MemoryOp[] }>({
    model: config.review.model, system: MEMORY_RULES + '\n\n只输出要求的 JSON。', text, images, schema: schema(false, true),
  });
  book(target, '记忆整理', costUsd);
  const changed = memory.apply(data.memory_ops ?? [], target.session);
  if (changed.length) trace(target, 'memory', { feedback: f.version, changed });
}

function failed(target: Target, kind: string, item: string, e: unknown, extra: Record<string, unknown> = {}) {
  // A call that produced nothing usable still cost money.
  if (e instanceof AskError) book(target, item, e.costUsd);
  try { trace(target, kind, { ...extra, error: String((e as Error)?.message ?? e).slice(0, 300) }); } catch {}
}

export function afterTurn(target: Target, turnId: string) {
  const s = settings.get();
  if (!s.reviewEnabled && !s.memoryAutoUpdate) return;
  if (s.reviewEnabled) pending.add(turnId);
  void jobs(() => reviewTurn(target, turnId))
    .catch((e) => failed(target, 'review_error', s.reviewEnabled ? '点评' : '记忆整理', e, { turnId }))
    .finally(() => pending.delete(turnId));
}

export function afterFeedback(target: Target, f: Feedback) {
  if (jobs.queued() >= MAX_QUEUED) return;
  void jobs(() => learnFromFeedback(target, f)).catch((e) => failed(target, 'memory_error', '记忆整理', e, { feedback: f.version }));
}

/** Pending background jobs in total, and the turns whose review has not landed yet. */
export const reviewQueue = () => jobs.active() + jobs.queued();
export const reviewPending = () => [...pending];
