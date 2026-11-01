// Web research for scripts that need facts. The model's own web_search tool is not available through the
// relay, so two relay routes are used: Gemini with Google Search grounding, then GPT with web search.
import { relay, relayReady, research } from '../core/config.ts';

export interface Source { title: string; url: string; domain: string }
export interface Findings { summary: string; sources: Source[]; provider: string }

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

/** Searches with Gemini, falling back to GPT. Throws when neither works or no relay is configured. */
export async function search(q: string): Promise<Findings> {
  if (!relayReady()) throw new Error('查资料服务未配置');
  const errors: string[] = [];
  for (const route of [gemini, gpt]) {
    try {
      return await route(q);
    } catch (e) {
      errors.push(String((e as Error).message ?? e));
    }
  }
  throw new Error(`查资料失败：${errors.join('；')}`);
}
