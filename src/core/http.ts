// Requests to public libraries (Wikimedia Commons, NASA, Poly Haven …): one User-Agent that names the software and
// where to reach its maintainers (Wikimedia's policy asks for contact details, Poly Haven for the software's name),
// a retry for refusals that are usually temporary, and an error message that says who refused and why.
import { readFileSync } from 'node:fs';

const VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0'); } catch { return '0'; }
})();
export const USER_AGENT = `video_agent/${VERSION} (+https://github.com/satoshinji2992/video_agent)`;

/** Refusals worth asking again: Wikimedia's temporary 403s, rate limits and server errors. */
export const retryable = (status: number) => status === 403 || status === 429 || status >= 500;

/** Waits before the second and third try; a Retry-After from the server wins, up to MAX_WAIT_MS. */
const DELAYS_MS = [1000, 3000];
const MAX_WAIT_MS = 10_000;

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? t - Date.now() : null;
}

/** A short reason from a refusal's body (Wikimedia explains its 403s there), at most a few KB read. */
async function reasonOf(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return '';
    let text = '';
    const dec = new TextDecoder();
    while (text.length < 4096) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {
    return '';
  }
}

/** A library that kept refusing after the retries; `status` and `reason` are what it said the last time. */
// Plain fields, no parameter properties: models.ts loads this module in a worker under Node's own type stripping.
export class Refused extends Error {
  readonly who: string;
  readonly status: number;
  readonly reason: string;
  constructor(who: string, status: number, reason: string) {
    const why = status === 429 ? '请求太频繁，暂时限流' : status >= 500 ? `服务暂时出错（${status}）` : `拒绝了请求（${status}）`;
    super(`${who}${why}${reason ? `：${reason}` : ''}，已重试 ${DELAYS_MS.length} 次。这是对方的临时限制，不是不能联网。`);
    this.who = who;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Sends the request (again) until it is not a refusal worth retrying, at most DELAYS_MS.length more times. A final
 * refusal throws Refused; any other response is returned as is for the caller to judge.
 */
export async function withRetry(who: string, send: () => Promise<Response>, delays = DELAYS_MS): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await send();
    if (!retryable(res.status)) return res;
    if (i >= delays.length) throw new Refused(who, res.status, await reasonOf(res));
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, retryAfterMs(res) ?? delays[i]!));
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
  }
}
