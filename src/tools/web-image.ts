// Pictures from the web. find_web_image looks for candidates (App Store icons for apps, Tavily image search) and
// shows them as a numbered contact sheet; use_web_image takes any https picture or page (a page gives its logo,
// icons, share image or main pictures, and a headless browser opens it when its HTML does not), with every request
// checked (src/media/webimage.ts). What is taken is recorded in assets_manifest.json as 网络图片 with the page URL,
// the picture URL and the time, so its source can always be looked up.
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { tavilyReady } from '../core/config.ts';
import { recordManifest } from '../media/footage.ts';
import { checkUrl, fetchWebPictures, webGet, type WebPicture } from '../media/webimage.ts';
import { browserPictures } from '../render/webpage.ts';
import { tavilySearch } from '../providers/tavily.ts';
import { fail, footageSheet, imageBlock, safe, text, type Ctx } from './shared.ts';

interface Candidate { url: string; page: string; description: string }

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Apps by name from Apple's public search (no key): the 512 px icon, the app's name, its developer and page. */
async function appStoreIcons(name: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const country of ['us', 'cn']) {
    try {
      const r = await webGet(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=software&limit=3&country=${country}`, 1 << 20);
      const j = JSON.parse(r.body.toString('utf8')) as { results?: Array<{ trackName?: string; sellerName?: string; artworkUrl512?: string; artworkUrl100?: string; trackViewUrl?: string }> };
      for (const a of j.results ?? []) {
        const icon = a.artworkUrl512 ?? a.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/512x512bb.');
        if (icon && !out.some((c) => c.url === icon)) out.push({ url: icon, page: a.trackViewUrl ?? '', description: `App Store 图标：${a.trackName ?? name}（${a.sellerName ?? '开发者未知'}）` });
      }
      if (out.length) break;
    } catch { /* the other country, or nothing */ }
  }
  return out.slice(0, 3);
}

export function webImageTools(ctx: Ctx) {
  /** Candidates shown so far in this conversation, by number. */
  const seen = new Map<string, Candidate>();
  let count = 0;

  const findWebImage = tool(
    'find_web_image',
    'Look for a picture on the web: a brand or app logo, a product, a person, a place. For an app or a brand that has one, pass `app` with its name: the App Store\'s 512 px icon comes first (usually the clearest official logo). Image search returns more candidates with short descriptions. Returns them numbered (w1, w2 …) on a contact sheet with their source pages; look, then take one with use_web_image. Prefer clear, official, high-resolution pictures.',
    {
      query: z.string().describe('What to find, in English for international brands, e.g. "NewsBreak app logo"'),
      app: z.string().optional().describe('App or brand name to look up in the App Store'),
      domains: z.array(z.string()).optional().describe('Only search these sites, e.g. the brand\'s own domain'),
    },
    safe(async ({ query, app, domains }) => {
      const found: Candidate[] = [];
      const notes: string[] = [];
      if (app) {
        const icons = await appStoreIcons(app);
        found.push(...icons);
        if (!icons.length) notes.push(`App Store 里没找到"${app}"`);
      }
      const pages: string[] = [];
      if (tavilyReady()) {
        try {
          const r = await tavilySearch(query, { depth: 'basic', images: true, maxResults: 5, includeDomains: domains }, { session: ctx.sessionId, item: '找图' });
          if (r.warning) ctx.emit({ type: 'toast', level: 'warn', text: r.warning });
          for (const im of r.data.images.slice(0, 8)) if (!found.some((c) => c.url === im.url)) found.push({ url: im.url, page: '', description: im.description });
          pages.push(...r.data.results.slice(0, 5).map((x) => `${x.title || host(x.url)} ${x.url}`));
        } catch (e) {
          notes.push(`图片搜索失败：${(e as Error).message}`);
        }
      } else notes.push('图片搜索没有配置（TAVILY_API_KEY），只能查 App Store 图标或直接取网页');
      const usable = found.filter((c) => { try { checkUrl(c.url); return true; } catch { return false; } }).slice(0, 12);
      if (!usable.length) return fail(`没找到候选图${notes.length ? `（${notes.join('；')}）` : ''}。可以换个说法再找，用 use_web_image 直接取品牌官网或相关页面，或者请用户发图片。`);
      const ids = usable.map((c) => { const id = `w${++count}`; seen.set(id, c); return id; });
      const sheet = await footageSheet(usable.map((c) => ({ thumb: c.url })), ctx.store.path('clips', `web-sheet-${ids[0]}.png`), async (u) => {
        const g = await webGet(u, 4 << 20);
        return new Response(new Uint8Array(g.body), { status: 200, headers: { 'content-type': g.type } });
      });
      const lines = usable.map((c, i) => `${ids[i]}（图上 ${i + 1}）${c.description || '（无描述）'}｜图片 ${host(c.url)}${c.page ? `｜页面 ${c.page}` : ''}`);
      return {
        content: [
          text(`找到 ${usable.length} 张候选（缩略图拼在一张图上，按编号对应）：\n${lines.join('\n')}${pages.length ? `\n\n相关页面（也可以把页面地址交给 use_web_image，它会从页面里挑 logo 和主图）：\n${pages.join('\n')}` : ''}${notes.length ? `\n\n${notes.join('；')}` : ''}\n\n用 use_web_image 取你选中的那张（传编号，比如 ${ids[0]}）。`),
          ...(sheet ? [await imageBlock(sheet)] : []),
        ],
      };
    }),
  );

  const useWebImage = tool(
    'use_web_image',
    'Take a picture from the web into assets/: a candidate number from find_web_image (w3), an https image URL, or an https page URL (the page\'s logo, icons, share image or main pictures are picked, up to 4; if its HTML has none, the page is opened in a headless browser and the pictures it shows are taken). Pictures are saved as PNG (an SVG logo stays SVG, usable in code shots only) and recorded with their page, picture URL and time as 网络图片. Use them in code shots as <img src="assets/<file>">, or as `image` of an image shot.',
    {
      source: z.string().describe('w-number from find_web_image, or an https image or page URL'),
      want: z.enum(['logo', 'image']).optional().describe('From a page: the logo (default) or the main picture'),
    },
    safe(async ({ source, want = 'logo' }) => {
      const cand = /^w\d+$/i.test(source.trim()) ? seen.get(source.trim().toLowerCase()) : undefined;
      if (/^w\d+$/i.test(source.trim()) && !cand) return fail(`没有编号 ${source} 的候选图，先用 find_web_image 找。`);
      const url = cand?.url ?? source.trim();
      try { checkUrl(url); } catch (e) { return fail(`${(e as Error).message}：只能取公网上的 https 图片或网页。`); }
      const dir = ctx.store.path('assets');
      await mkdir(dir, { recursive: true });
      let r: { page: string; pictures: WebPicture[]; skipped: string[] };
      let how = '';
      try {
        r = await fetchWebPictures(url, dir, want);
      } catch (e) {
        try {
          r = await browserPictures(url, dir, want);
          how = `（直接抓取没取到：${(e as Error).message}；改用浏览器打开页面取的）`;
        } catch (e2) {
          return fail(`没取到图：${(e as Error).message}；浏览器打开也不行：${(e2 as Error).message}。换一个候选或页面，或者请用户直接发图片。`);
        }
      }
      const page = cand?.page || r.page;
      const fetchedAt = new Date().toISOString();
      for (const p of r.pictures) {
        recordManifest(ctx.store.dir, {
          file: p.file, id: `web:${p.url}`, source: 'web', kind: 'image', title: cand?.description || `${host(page)} 的${want === 'logo' ? ' logo' : '图片'}`,
          pageUrl: page, imageUrl: p.url, license: '网络图片', credit: `网络图片（${host(page) || host(p.url)}）`, needsAttribution: false, fetchedAt,
        });
      }
      const lines = r.pictures.map((p, i) => `${i + 1}. assets/${p.file}（${p.width}×${p.height}${p.format === 'svg' ? '，SVG，只能用在动画镜头里' : ''}）来自 ${p.url}`);
      const previews = await Promise.all(r.pictures.filter((p) => p.format !== 'svg').map((p) => imageBlock(ctx.store.path('assets', p.file))));
      const small = r.pictures.length && r.pictures.every((p) => Math.max(p.width, p.height) < 256);
      return {
        content: [
          text(`取到 ${r.pictures.length} 张${how}，下面是预览，挑清楚、正确的那张用：\n${lines.join('\n')}\n来源已记为"网络图片"（页面 ${page}）。动画镜头里用 <img src="assets/文件名">，做图片镜头时 image 填文件名。${small ? '\n这些图都比较小，放大会糊：优先找更清楚的（App Store 图标、官网、新闻稿里的大图）。' : ''}${r.skipped.length ? `\n没取下来的：${r.skipped.slice(0, 3).join('；')}` : ''}`),
          ...previews,
        ],
      };
    }),
  );
  return { findWebImage, useWebImage };
}
