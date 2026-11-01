// Last resort for use_web_image: open the page in headless Chrome when its pictures cannot be read from the HTML
// (pages built by scripts, or sites that refuse plain requests). Every request the page makes passes the same checks
// as a direct fetch: https (or data:/blob:), to a host whose addresses are all public; service workers, WebSockets,
// media and downloads are off. The pictures the page actually shows are fetched again through webGet (byte caps,
// type checks); when that fails, or for an inline SVG logo, the element itself is screenshotted.
import { chromium, type Route } from 'playwright-core';
import { config } from '../core/config.ts';
import { CHROME_ARGS } from './renderer.ts';
import { checkUrl, proxied, publicAddresses, savePicture, webGet, WEB_LIMITS, WebImageError, type WebPicture } from '../media/webimage.ts';

const PAGE_TIMEOUT_MS = 25_000;

interface Shown { n: number; src: string; svg: boolean; score: number; area: number; top: number }

// Runs in the page, as source text: the build step would otherwise wrap its functions in a helper the page lacks.
// Marks every visible picture (and every SVG that looks like a logo) with data-va-pick=n and lists them.
const COLLECT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= 24 && r.height >= 24 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  // How much an element looks like the site's own logo: a link to the home page, "logo" in its attributes or
  // address, in the header near the top; store badges count against it.
  const home = (a) => { try { const u = new URL(a.getAttribute('href') || '', location.href); return u.origin === location.origin && (u.pathname === '/' || u.pathname === ''); } catch { return false; } };
  const logoScore = (el) => {
    const a = el.closest('a');
    const words = [el.getAttribute('class') || '', el.id, el.getAttribute('alt') || '', el.getAttribute('aria-label') || '', el.currentSrc || el.getAttribute('src') || '',
      (a && a.getAttribute('aria-label')) || '', el.closest('[class*="logo" i],[id*="logo" i]') ? 'logo' : ''].join(' ');
    const r = el.getBoundingClientRect();
    return (a && home(a) ? 3 : 0) + (/logo/i.test(words) ? 3 : 0) + (el.closest('header,nav') ? 1 : 0) + (r.top + window.scrollY < 150 ? 1 : 0)
      - (/app ?store|google ?play|download/i.test(words) ? 4 : 0);
  };
  const out = [];
  let n = 0;
  for (const el of [...document.images, ...document.querySelectorAll('svg')]) {
    if (!visible(el)) continue;
    const svg = el.tagName.toLowerCase() === 'svg';
    if (svg && el.parentElement && el.parentElement.closest('svg')) continue;
    const score = logoScore(el);
    // An inline SVG is only a candidate when it looks like the logo (icons and arrows are SVGs too).
    if (svg && score < 3) continue;
    const r = el.getBoundingClientRect();
    el.setAttribute('data-va-pick', String(n));
    out.push({ n: n++, src: svg ? '' : (el.currentSrc || el.src), svg, score, area: r.width * r.height, top: r.top + window.scrollY });
  }
  return out;
})()`;

export async function browserPictures(url: string, dir: string, want: 'logo' | 'image'): Promise<{ page: string; pictures: WebPicture[]; skipped: string[] }> {
  const start = checkUrl(url);
  await publicAddresses(start.hostname);
  const proxy = proxied() ? { server: (process.env.HTTPS_PROXY || process.env.https_proxy)! } : undefined;
  const browser = await chromium.launch({ executablePath: config.chromePath, args: CHROME_ARGS, ...(proxy ? { proxy } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 3, serviceWorkers: 'block', acceptDownloads: false });
    const hosts = new Map<string, Promise<boolean>>();
    const allowed = (host: string) => {
      let p = hosts.get(host);
      if (!p) hosts.set(host, (p = publicAddresses(host).then(() => true, () => false)));
      return p;
    };
    await context.route('**/*', async (route: Route) => {
      const req = route.request();
      if (['media', 'font', 'websocket', 'eventsource', 'manifest'].includes(req.resourceType())) return route.abort();
      const u = req.url();
      if (/^(data|blob):/i.test(u)) return route.continue();
      try {
        const parsed = checkUrl(u);
        return (await allowed(parsed.hostname)) ? route.continue() : route.abort('blockedbyclient');
      } catch {
        return route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.goto(start.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    // The final address after redirects must still be a public https page.
    checkUrl(page.url());

    const shown = (await page.evaluate(COLLECT)) as Shown[];
    const order = want === 'logo'
      ? [...shown].sort((a, b) => b.score - a.score || a.top - b.top || b.area - a.area)
      : [...shown].sort((a, b) => b.area - a.area);
    const pictures: WebPicture[] = [], skipped: string[] = [];
    for (const s of order) {
      if (pictures.length >= WEB_LIMITS.candidates) break;
      try {
        let pic: WebPicture | null = null;
        if (s.src && /^https:/i.test(s.src)) pic = await savePicture(await webGet(s.src, WEB_LIMITS.imageBytes), dir).catch(() => null);
        if (!pic) {
          // What the page shows, as pixels.
          const shot = await page.locator(`[data-va-pick="${s.n}"]`).first().screenshot({ omitBackground: true, timeout: 5000 });
          pic = await savePicture({ url: s.src && !/^(data|blob):/i.test(s.src) ? s.src : `${page.url()}#element-${s.n}`, status: 200, type: 'image/png', body: shot }, dir);
        }
        if (!pictures.some((p) => p.file === pic!.file)) pictures.push(pic);
      } catch (e) {
        skipped.push(`${s.src || '页面上的 SVG'}：${(e as Error).message}`);
      }
    }
    if (!pictures.length) throw new WebImageError(`浏览器打开了页面，但没找到能用的图片${skipped.length ? `（${skipped.slice(0, 2).join('；')}）` : ''}`);
    return { page: page.url(), pictures, skipped };
  } catch (e) {
    if (e instanceof WebImageError) throw e;
    throw new WebImageError(`用浏览器打开页面失败：${String((e as Error).message).split('\n')[0]!.slice(0, 160)}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
