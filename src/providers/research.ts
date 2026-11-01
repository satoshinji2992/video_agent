// Web research for scripts that need facts. Tavily first: its search results (and, where their snippets are thin,
// the pages themselves through extract) go to the model as quoted excerpts with the original URL and date, so every
// fact can be checked against its source. When Tavily is not configured or fails, two relay routes summarise
// instead: Gemini with Google Search grounding, then GPT with web search.
import { relay, relayReady, research, tavilyReady } from '../core/config.ts';
import { tavilyExtract, tavilySearch, type Payer } from './tavily.ts';

export interface Source { title: string; url: string; domain: string; date?: string }
/** `booked`: the provider already put the cost in the ledger (Tavily does, per call). */
export interface Findings { summary: string; sources: Source[]; provider: string; booked?: boolean; warnings?: string[] }
export interface ResearchOptions { domains?: string[]; timeRange?: 'week' | 'month' | 'year' }

const PROMPT = (q: string) => `请联网查证下面这个问题，用中文写出最相关的事实要点，不超过 300 字。只写有来源支持的内容；数字要写明出处，查不到就说查不到，不要推测。\n\n问题：${q}`;

const domain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const dedupe = (list: Source[]) => [...new Map(list.filter((s) => /^https?:\/\//.test(s.url)).map((s) => [s.url, s])).values()].slice(0, 8);

async function gemini(q: string): Promise<Findings> {
  const res = await fetch(`${relay.url}/v1beta/models/${research.geminiModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.apiKey}` },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT(q) }] }], tools: [{ google_search: {} }] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }> };
  const c = j.candidates?.[0];
  const summary = (c?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!summary) throw new Error('gemini empty');
  // Grounding links are short-lived redirect URLs and the title is only the site name: follow each redirect
  // once to keep the real page address.
  const raw = (c?.groundingMetadata?.groundingChunks ?? []).map((g) => ({ title: g.web?.title ?? '', url: g.web?.uri ?? '', domain: g.web?.title ?? domain(g.web?.uri ?? '') }));
  const sources = await Promise.all(dedupe(raw).map(async (s) => {
    try {
      const r = await fetch(s.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(4000) });
      const to = r.headers.get('location');
      if (to && /^https?:\/\//.test(to)) return { ...s, url: to, domain: domain(to) };
    } catch {}
    return s;
  }));
  return { summary, sources, provider: research.geminiModel };
}

async function gpt(q: string): Promise<Findings> {
  const res = await fetch(`${relay.url}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.apiKey}` },
    body: JSON.stringify({ model: research.gptModel, input: PROMPT(q), tools: [{ type: 'web_search' }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`gpt ${res.status}`);
  const j = (await res.json()) as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }> }> };
  const parts = (j.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text');
  const summary = parts.map((p) => p.text ?? '').join('').trim();
  if (!summary) throw new Error('gpt empty');
  const sources = parts.flatMap((p) => p.annotations ?? []).filter((a) => a.url).map((a) => ({ title: a.title ?? domain(a.url!), url: a.url!, domain: domain(a.url!) }));
  return { summary, sources: dedupe(sources), provider: research.gptModel };
}

/** A window of a page's text around the first query word it contains, at most `n` characters. */
function excerpt(text: string, q: string, n = 1500): string {
  const words = q.toLowerCase().split(/[\s,，、。？?：:；;"“”'()（）]+/).filter((w) => w.length >= 2);
  const lower = text.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - 200);
  return `${from ? '…' : ''}${text.slice(from, from + n)}${from + n < text.length ? '…' : ''}`;
}
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

async function viaTavily(q: string, o: ResearchOptions, payer: Payer): Promise<Findings> {
  const warnings: string[] = [];
  const s = await tavilySearch(q, { depth: 'advanced', maxResults: 6, includeDomains: o.domains, timeRange: o.timeRange }, payer);
  if (s.warning) warnings.push(s.warning);
  const results = s.data.results.slice(0, 6);
  if (!results.length) throw new Error('Tavily 没有找到结果');
  // The top results' own pages, when their snippets are too short to rely on.
  const thin = results.slice(0, 2).filter((r) => r.content.length < 500).map((r) => r.url);
  const pages = new Map<string, string>();
  if (thin.length) {
    try {
      const x = await tavilyExtract(thin, payer);
      if (x.warning) warnings.push(x.warning);
      for (const p of x.data) pages.set(p.url, excerpt(p.text, q));
    } catch { /* the snippets stay */ }
  }
  const sources = results.map((r) => ({ title: r.title || domain(r.url), url: r.url, domain: domain(r.url), ...(r.publishedDate ? { date: r.publishedDate.slice(0, 10) } : {}) }));
  const summary = `检索结果（按相关度排序）。每条是来源原文的摘录，带原始链接和日期；用之前先核对，数字和说法以原文为准，原文里没有的不要写：\n\n${results.map((r, i) =>
    `[${i + 1}] ${sources[i]!.title}｜${sources[i]!.domain}｜${sources[i]!.date ? `发布于 ${sources[i]!.date}` : '日期未标注'}\n${r.url}\n${pages.get(r.url) ?? clip(r.content, 700)}`).join('\n\n')}`;
  return { summary, sources, provider: 'tavily', booked: true, warnings };
}

/** Searches with Tavily, falling back to Gemini, then GPT. Throws when nothing works or nothing is configured. */
export async function search(q: string, o: ResearchOptions = {}, payer: Payer = { session: 'system', item: '查资料' }): Promise<Findings> {
  const errors: string[] = [];
  if (tavilyReady()) {
    try { return await viaTavily(q, o, payer); } catch (e) { errors.push(String((e as Error).message ?? e)); }
  }
  if (!relayReady()) throw new Error(errors.length ? `查资料失败：${errors.join('；')}` : '查资料服务未配置');
  for (const route of [gemini, gpt]) {
    try {
      return await route(q);
    } catch (e) {
      errors.push(String((e as Error).message ?? e));
    }
  }
  throw new Error(`查资料失败：${errors.join('；')}`);
}
