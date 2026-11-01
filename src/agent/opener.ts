// The opening line of a turn ("我先按……做一版，几分钟就好"), written by a short separate call so it reaches the
// user within seconds while the agent thinks as long as the work needs. Same model, same system prompt and
// preferences, so it sounds like the agent; it returns nothing when the message does not start work.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../core/config.ts';
import { childEnv, claudeExecutable } from '../providers/llm.ts';
import { ASK_RULE, systemPrompt } from './prompt.ts';

// Runs in parallel with the agent, so a slow call costs nothing; this only bounds the extra process.
const TIMEOUT_MS = 20_000;
const PASS = 'PASS';

const TASK = `

# 这一次的任务

这一次你只负责本轮开口的第一句话，别的都不做，也不调用任何工具。先按上面的规则判断这一轮要做什么，再写这句话，输出一行，格式是"类型|这句话"：
问还是做，按这条判断：${ASK_RULE}
- ASK|……：新片子的关键需求（用途和平台、时长、风格调性、要不要口播、主推什么）有没定的，而且用户没说"直接做"：接下来会出一张需求卡让用户点选。这句话说你接下来想先确认几件事、让用户在下面的卡片里选一选，可以顺带提一下你已经明白的部分，但不要把时长、平台、风格串成一串复述（语气参考："开业视频没问题。有几个地方我想先跟你确认一下，下面点一点就行。"或者"这个可以做，不过有几件事会影响整体效果，我先问问你的想法。"）；不要在这句话里问具体问题，也不要列选项，更不要说出用户没给的店名、产品名（以往对话里的名字也不行）。
- SCRIPT|……：几秒钟的单个小动画和对已有成片的小改以外，新片子需求清楚时先出剧本卡；用户说了"直接做""你看着办"也出剧本卡，只是不停下来等确认。语气参考："我大概明白你要的感觉了，先把剧本写出来给你看看，没问题再开始做。"，或者"那开头我改得更紧张一些，后面的部分先不动。"
- WORK|……：几秒钟的单个小动画（一个镜头、没有叙事，比如 logo 动效、十秒内的产品转圈）、对已有成片的小改，或者剧本已经确认过、直接出片。说清打算怎么做、先做哪一步（语气参考："这个不难，我先把 logo 的动画做出来，做好了给你看效果。"或者"剧本定下来了，那我就开始做，先把主角的样子定下来。"）；不要报具体的秒数或时长，用户自己说了时长的除外。
- REPLY|……：用户只是在泛泛地问你能做什么、和别的工具或 bot 比怎么样、怎么用你。"能不能给这条加个音乐""可以把字幕调大吗""能做个生日视频吗"这类是用问句提的要求，用户要的是你去做，按 WORK 或 SCRIPT 或 ASK 处理，不是 REPLY。照上面的能力清单直接把问题答完，这一条就是整轮的回答：口语，三到六句，可以分两段，不列表、不加粗；长处和短板都照能力清单说，不推荐别的工具。问题要看当前这条片子的具体内容（用了什么音乐、第几秒是什么）才能答的，用 ${PASS}。
- ${PASS}：闲聊、只是道谢，或者拿不准。

上面的"语气参考"只示范说话的感觉，不要照抄措辞，按这一次的内容用自己的话说，开头不要每次都用"好""好嘞""明白"。除了 REPLY，这句话照上面聊天的写法写：一到三句完整、自然的口语，不说行话，不列选项，不提金额，不提工具名和英文技术词（list_media、save_plan 这类），只输出这一行，不要别的。`;

export async function writeOpener(
  recent: Array<{ role: 'user' | 'bot'; text: string }>,
  text: string,
  images: number,
  remembered: string,
  state = '',
): Promise<{ say: string | null; kind: OpenerKind; costUsd: number }> {
  const history = recent.map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.text.slice(0, 400)}`).join('\n');
  const prompt = `${state ? `${state}\n\n` : ''}${history ? `之前的对话（仅供参考）：\n${history}\n\n` : ''}用户刚发来的消息：${text || '（只发了图片）'}${images ? `（附了 ${images} 张图）` : ''}\n\n直接写出你要发给用户的那句话（或 ${PASS}）。`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let out = '';
  let costUsd = 0;
  try {
    for await (const m of query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: claudeExecutable,
        model: config.openerModel,
        effort: 'low',
        systemPrompt: systemPrompt() + remembered + TASK,
        tools: [],
        allowedTools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 1,
        persistSession: false,
        cwd: config.dataDir,
        env: childEnv,
        abortController: abort,
      },
    })) {
      if (m.type === 'result') {
        costUsd = m.total_cost_usd;
        if (m.subtype === 'success') out = m.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { ...parseOpener(out), costUsd };
}

export type OpenerKind = 'ASK' | 'SCRIPT' | 'WORK' | 'REPLY';
// A label as the model writes it: "WORK|", "ASK：", "**REPLY**|", "- PASS".
const LABEL = /^[\s*\-•●>]*(ASK|SCRIPT|WORK|REPLY|PASS)[\s*]*(?:[|｜:：]|$)\s*/i;

/** The model's output as the line to show and its kind; say is null for PASS or anything unusable. */
export function parseOpener(out: string): { say: string | null; kind: OpenerKind } {
  // The first labelled line decides. A full answer runs over several lines: kept up to the next label.
  // Tags such as a stray <thinking_mode>…</thinking_mode> go first, even on the label's own line.
  const lines = out.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/gi, '').trim().split(/\n/);
  const at = lines.findIndex((l) => LABEL.test(l));
  const label = at >= 0 ? LABEL.exec(lines[at]!)![1]!.toUpperCase() : '';
  if (label === PASS) return { say: null, kind: 'WORK' };
  if (label === 'REPLY') {
    const rest = [lines[at]!.replace(LABEL, ''), ...lines.slice(at + 1)];
    const end = rest.findIndex((l, i) => i > 0 && LABEL.test(l));
    return { say: cleanReply((end < 0 ? rest : rest.slice(0, end)).join('\n')), kind: 'REPLY' };
  }
  const kind = (label || 'WORK') as OpenerKind;
  return { say: clean(at >= 0 ? lines[at]!.replace(LABEL, '') : out), kind };
}

/**
 * A whole answer: paragraphs kept, anything that reads like a document (lists, headings, bold, tables) or a
 * stray tag refused, so the agent answers instead.
 */
export function cleanReply(raw: string): string | null {
  const paras = raw.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/gi, '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const text = paras.join('\n\n');
  if (paras.some((l) => /^([-*•●#>|]|\d+[.、)）．]|[（(]\d+[）)]|[①-⑳]|[０-９]+[.、．]|[一二三四五六七八九十]+[、.]|第[一二三四五六七八九十]+[，、])/.test(l) || LABEL.test(l)) || /\*\*|[<>]|\uFFFD/.test(text)) return null;
  if (text.length < 20 || text.length > 700 || /^(ASK|SCRIPT|WORK|REPLY|PASS)\b/i.test(text)) return null;
  return text;
}

/**
 * The reply must be a sentence for the user. Seen in practice: a stray "<thinking_mode>…</thinking_mode>"
 * before the line, a bullet in front of it, or just a label such as "状态：". Anything that is not a usable
 * sentence returns null, and the agent's own opening is shown instead.
 */
export function clean(raw: string): string | null {
  const text = raw
    .replace(/<([a-z_]+)>[\s\S]*?<\/\1>/gi, '')
    .split(/\n+/)
    .map((l) => l.trim().replace(/^[●•·\-*>\s]+/, '').replace(/^["“「]|["”」]$/g, '').trim())
    .filter(Boolean)
    .at(-1) ?? '';
  if (!text || text.toUpperCase().startsWith(PASS) || /^\W*(ASK|SCRIPT|WORK|REPLY|PASS)\b/i.test(text)) return null;
  if (text.length < 6 || text.length > 200 || /[<>]/.test(text) || /[:：]$/.test(text)) return null;
  // A tool name ("先用 list_media 挑镜头") is the agent's plumbing, not something to tell the user.
  if (/\b[a-z]+(?:_[a-z]+)+\b/.test(text)) return null;
  return text;
}
