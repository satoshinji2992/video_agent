// Tavily (https://docs.tavily.com): web search with optional images, and page extraction. Every call is checked
// against the budget first and booked in the ledger afterwards by the credits Tavily reports for it.
import { tavily } from '../core/config.ts';
import { BUDGET_EXHAUSTED, ledger } from '../core/ledger.ts';

export interface TavilyResult { title: string; url: string; content: string; score: number; publishedDate?: string }
export interface TavilyImage { url: string; description: string }
export interface SearchOptions {
  depth?: 'basic' | 'advanced';
  includeDomains?: string[];
  timeRange?: 'day' | 'week' | 'month' | 'year';
  topic?: 'general' | 'news';
  maxResults?: number;
  /** Also return images, each with a short description. */
  images?: boolean;
}
/** Who pays: the session and the ledger item the credits are booked under. */
export interface Payer { session: string; item: string }
interface Booked<T> { data: T; credits: number; warning: string | null }

/** Credits a call costs before Tavily says (search: basic 1, advanced 2; extract: per 5 URLs, basic 1, advanced 2). */
const estimate = (path: string, depth: string, urls = 1) => (path === '/search' ? (depth === 'advanced' ? 2 : 1) : Math.ceil(urls / 5) * (depth === 'advanced' ? 2 : 1));

async function call<T>(path: '/search' | '/extract', body: Record<string, unknown>, payer: Payer, guess: number): Promise<Booked<T>> {
  if (!tavily.apiKey) throw new Error('Tavily 未配置');
  if (!ledger.canSpend(guess * tavily.usdPerCredit)) throw new Error(BUDGET_EXHAUSTED);
  let res: Response;
  try {
    res = await fetch(`${tavily.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tavily.apiKey}` },
      body: JSON.stringify({ ...body, include_usage: true }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error((e as Error).name === 'TimeoutError' ? 'Tavily 响应超时' : 'Tavily 连接失败');
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`Tavily 返回错误 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const data = (await res.json()) as T & { usage?: { credits?: number } };
  const credits = Number.isFinite(Number(data.usage?.credits)) ? Number(data.usage!.credits) : guess;
  const warning = ledger.record({
    session: payer.session, item: payer.item, model: 'tavily', usage: `${path.slice(1)} ${credits} credits`, usd: credits * tavily.usdPerCredit, basis: 'estimate',
  });
  return { data, credits, warning };
}

export async function tavilySearch(query: string, o: SearchOptions, payer: Payer): Promise<Booked<{ results: TavilyResult[]; images: TavilyImage[] }>> {
  const depth = o.depth ?? 'basic';
  const r = await call<{ results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>; images?: Array<string | { url?: string; description?: string }> }>('/search', {
    query, search_depth: depth, max_results: o.maxResults ?? 6, topic: o.topic ?? 'general',
    ...(o.includeDomains?.length ? { include_domains: o.includeDomains } : {}),
    ...(o.timeRange ? { time_range: o.timeRange } : {}),
    ...(o.images ? { include_images: true, include_image_descriptions: true } : {}),
  }, payer, estimate('/search', depth));
  const results = (r.data.results ?? []).filter((x) => x.url).map((x) => ({
    title: x.title ?? '', url: x.url!, content: (x.content ?? '').trim(), score: x.score ?? 0, ...(x.published_date ? { publishedDate: x.published_date } : {}),
  }));
  const images = (r.data.images ?? []).map((x) => (typeof x === 'string' ? { url: x, description: '' } : { url: x.url ?? '', description: x.description ?? '' })).filter((x) => x.url);
  return { ...r, data: { results, images } };
}

export async function tavilyExtract(urls: string[], payer: Payer, depth: 'basic' | 'advanced' = 'basic'): Promise<Booked<Array<{ url: string; text: string }>>> {
  const r = await call<{ results?: Array<{ url?: string; raw_content?: string }> }>('/extract', { urls, extract_depth: depth }, payer, estimate('/extract', depth, urls.length));
  return { ...r, data: (r.data.results ?? []).filter((x) => x.url && x.raw_content).map((x) => ({ url: x.url!, text: x.raw_content!.replace(/\s+/g, ' ').trim() })) };
}
