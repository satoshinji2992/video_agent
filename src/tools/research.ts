// research: web search with sources, a few per turn.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { ledger } from '../core/ledger.ts';
import { research } from '../core/config.ts';
import { search } from '../providers/research.ts';
import { type Ctx, fail, safe, text } from './shared.ts';

/** At most this many web searches per turn. */
const RESEARCH_PER_TURN = 2;
const researchCount = new Map<string, number>();

export function researchTools(ctx: Ctx) {
  const researchTool = tool(
    'research',
    'Search the web before making a video that needs facts (explainers, an industry, technology, an unfamiliar brand or app). Returns key points in Chinese with sources. At most 2 calls per turn. Numbers and cases in the video may only come from what this returns; otherwise write qualitatively or mark them as illustrative.',
    { query: z.string().describe('What to look up, as a precise question.') },
    safe(async ({ query }) => {
      const turn = ctx.turnId();
      const n = researchCount.get(turn) ?? 0;
      if (n >= RESEARCH_PER_TURN) return fail('这一轮已经查过 2 次了，用已有的结果继续做。');
      researchCount.set(turn, n + 1);
      try {
        const r = await search(query);
        const warning = ledger.record({ session: ctx.sessionId, item: '查资料', model: r.provider, usage: 'search', usd: research.usdPerCall, basis: 'estimate' });
        if (warning) ctx.emit({ type: 'toast', level: 'warn', text: warning });
        ctx.emit({ type: 'research', query, sources: r.sources });
        // Explainers should rest on primary sources (the agency, the lab, the paper), not encyclopedias.
        const primary = r.sources.some((x) => /(\.gov|\.edu|\.int|jhuapl|nasa|esa\.|arxiv|doi\.org|nature\.com|science\.org|aas\.org|iop\.org|springer|wiley)/i.test(x.url));
        const hint = r.sources.length && !primary && n + 1 < RESEARCH_PER_TURN ? '这些来源都是二手的（百科、科普站）。讲科学、技术、历史事实的片子，再查一次原始来源（任务方/机构官网、论文，比如在查询里写明 NASA、APL、ESA 或 paper），剧本卡里优先列原始来源。' : '';
        return { content: [text(`${r.summary}\n\n来源：\n${r.sources.map((x, i) => `${i + 1}. ${x.title} ${x.url}`).join('\n') || '（没有返回链接）'}\n\n${hint}如果出剧本卡，用到的来源放进 present_script 的 sources；不出剧本就直接按资料做。`)] };
      } catch (e) {
        return fail(`${(e as Error).message}。没有可用的资料：片子里不要写具体数字和案例，用定性的说法，或者明确标成"示意"。`);
      }
    }),
  );
  return { researchTool };
}
