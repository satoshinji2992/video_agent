// Pictures from the open web, used for only two things: a link the user gave in the conversation, and the advertised
// brand's own site (its logo, product pictures). Everything else on the web stays off limits.
//
// Every request is https to a public address. The host is resolved first and every address it resolves to must be
// public (no loopback, private, link-local, carrier-grade NAT, cloud metadata, multicast or reserved ranges); on a
// direct connection the socket is pinned to the address that was checked, so a second DNS answer cannot redirect it.
// Redirects are followed by hand and every hop is checked the same way. Bodies are size-capped; a picture is judged by
// its bytes as well as its content-type and re-encoded as PNG (an SVG is kept as SVG after a safety check). A page
// offers its og:image, logo images and icons as candidates.
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg } from '../core/ffmpeg.ts';
import { USER_AGENT } from '../core/http.ts';

const MB = 1024 * 1024;
export const WEB_LIMITS = { pageBytes: 2 * MB, imageBytes: 10 * MB, hops: 5, timeoutMs: 20_000, candidates: 4, maxSide: 2048 };

export class WebImageError extends Error {}

// ------------------------------------------------------------------------------------------------ addresses

const v4 = (ip: string) => ip.split('.').map(Number) as [number, number, number, number];

/** True for addresses on the public internet; false for anything local, private, shared or reserved. */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = v4(ip);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (also some cloud metadata, e.g. 100.100.100.200)
      (a === 169 && b === 254) || // link-local, cloud metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicIp(mapped[1]!);
    // A first group of 0 is never public: ::, ::1, IPv4-compatible ::a.b.c.d / ::7f00:1 and the rest of ::/16
    // (the IPv4-mapped ::ffff: form is judged by its IPv4 address above).
    const first = parseInt(s.split(':')[0] || '0', 16);
    if (first === 0) return false;
    // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8, documentation 2001:db8::/32.
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
    if (/^2001:0?db8:/.test(s)) return false;
    return true;
  }
  return false;
}

/** The URL if it is https on the default port, without credentials, to a host that is not local by name. */
export function checkUrl(raw: string, base?: string): URL {
  let u: URL;
  try { u = new URL(raw, base); } catch { throw new WebImageError('不是有效的网址'); }
  if (u.protocol !== 'https:') throw new WebImageError('只接受 https 地址');
  if (u.username || u.password) throw new WebImageError('网址里不能带账号密码');
  if (u.port && u.port !== '443') throw new WebImageError('只接受默认端口的 https 地址');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || !host.includes('.') && !isIP(host)) {
    throw new WebImageError('不能访问本机或内网地址');
  }
  if (isIP(host) && !isPublicIp(host)) throw new WebImageError('不能访问本机或内网地址');
  return u;
}

/** Every address of the host, all of them public, or an error. */
export async function publicAddresses(host: string): Promise<Array<{ address: string; family: number }>> {
  const h = host.replace(/^\[|\]$/g, '');
  const list = isIP(h) ? [{ address: h, family: isIP(h) }] : await lookup(h, { all: true }).catch(() => []);
  if (!list.length) throw new WebImageError(`找不到网站 ${host}`);
  if (list.some((a) => !isPublicIp(a.address))) throw new WebImageError('这个网址指向本机或内网地址，不能访问');
  return list;
}

// ------------------------------------------------------------------------------------------------ fetching

export interface Got { url: string; status: number; type: string; body: Buffer }
type Sent = Omit<Got, 'url'> & { location: string | null };

const tooBig = (cap: number) => new WebImageError(`文件超过 ${Math.round(cap / MB)} MB 上限`);

/** The whole body, failing as soon as it passes `cap` bytes (a declared length over the cap fails before reading). */
export async function readCapped(chunks: AsyncIterable<Uint8Array>, cap: number, declared?: number): Promise<Buffer> {
  if (declared !== undefined && Number.isFinite(declared) && declared > cap) throw tooBig(cap);
  const out: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) {
    n += c.length;
    if (n > cap) throw tooBig(cap);
    out.push(c);
  }
  return Buffer.concat(out);
}

/** A proxy is in use (development machines): the socket cannot be pinned, the addresses are still checked first. */
export const proxied = () => process.env.NODE_USE_ENV_PROXY === '1' && Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);

/** One request over a socket pinned to `addr`; the body is read up to `cap` bytes. */
function pinned(u: URL, addr: { address: string; family: number }, cap: number, signal: AbortSignal): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname, servername: u.hostname.replace(/^\[|\]$/g, ''), port: 443, path: `${u.pathname}${u.search}`, method: 'GET', signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,text/html;q=0.9,*/*;q=0.5' },
      // The checked address, whatever the resolver says now.
      lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)),
    } as unknown as RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      const location = status >= 300 && status < 400 ? String(res.headers.location ?? '') || null : null;
      if (location) { res.resume(); return resolve({ status, type: '', body: Buffer.alloc(0), location }); }
      readCapped(res, cap, Number(res.headers['content-length'] ?? NaN))
        .then((body) => resolve({ status, type: String(res.headers['content-type'] ?? ''), body, location: null }))
        .catch((e) => { req.destroy(); reject(e); });
    });
    req.on('error', reject);
    req.end();
  });
}

/** The same through fetch(), for proxied development setups. */
async function viaFetch(u: URL, cap: number, signal: AbortSignal): Promise<Sent> {
  const res = await fetch(u, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,text/html;q=0.9,*/*;q=0.5' } });
  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (location) { await res.body?.cancel().catch(() => {}); return { status: res.status, type: '', body: Buffer.alloc(0), location }; }
  try {
    const body = await readCapped((res.body ?? []) as AsyncIterable<Uint8Array>, cap, Number(res.headers.get('content-length') ?? NaN));
    return { status: res.status, type: res.headers.get('content-type') ?? '', body, location: null };
  } catch (e) {
    await res.body?.cancel().catch(() => {});
    throw e;
  }
}

/** How requests go out; tests replace both. */
export interface WebDeps {
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>>;
  send: (u: URL, addr: { address: string; family: number }, cap: number, signal: AbortSignal) => Promise<Sent>;
}
const NET: WebDeps = { resolve: publicAddresses, send: (u, addr, cap, signal) => (proxied() ? viaFetch(u, cap, signal) : pinned(u, addr, cap, signal)) };

/** GET with every hop checked: https, a public address, at most WEB_LIMITS.hops redirects. */
export async function webGet(raw: string, cap: number, deps: WebDeps = NET): Promise<Got> {
  const signal = AbortSignal.timeout(WEB_LIMITS.timeoutMs);
  let u = checkUrl(raw);
  for (let hop = 0; hop <= WEB_LIMITS.hops; hop++) {
    const addrs = await deps.resolve(u.hostname);
    let r: Sent;
    try {
      r = await deps.send(u, addrs[0]!, cap, signal);
    } catch (e) {
      if (e instanceof WebImageError) throw e;
      throw new WebImageError((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError' ? `${u.hostname} 响应超时` : `连不上 ${u.hostname}`);
    }
    if (!r.location) {
      if (r.status === 403 || r.status === 429) throw new WebImageError(`${u.hostname} 拒绝了请求（${r.status}）`);
      if (r.status < 200 || r.status >= 300) throw new WebImageError(`${u.hostname} 返回错误 ${r.status}`);
      return { url: u.toString(), status: r.status, type: r.type.toLowerCase(), body: r.body };
    }
    u = checkUrl(r.location, u.toString());
  }
  throw new WebImageError('跳转次数太多');
}

// ------------------------------------------------------------------------------------------------ pictures

type Kind = 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | 'ico';

/** The picture format from the bytes themselves, or null. */
export function sniff(b: Buffer): Kind | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/** An SVG is only kept when it cannot run code or pull anything in. */
function safeSvg(text: string): boolean {
  return !/<script|<foreignObject|\son\w+\s*=|javascript:|<!ENTITY|xlink:href\s*=\s*["']\s*(?!#)|\shref\s*=\s*["']\s*(?!#|data:image\/)/i.test(text);
}

const TYPE_OK: Record<Kind, RegExp> = {
  png: /^image\/(png|apng)/, jpeg: /^image\/(jpe?g|pjpeg)/, webp: /^image\/webp/, gif: /^image\/gif/, svg: /^image\/svg\+xml/, ico: /^image\/(x-icon|vnd\.microsoft\.icon|ico)/,
};

export interface WebPicture { file: string; url: string; width: number; height: number; format: Kind }

/** Saves one fetched picture into `dir` as PNG (or SVG); throws when the bytes are not a picture. */
export async function savePicture(got: Got, dir: string): Promise<WebPicture> {
  const kind = sniff(got.body);
  if (!kind) throw new WebImageError('这个地址的内容不是图片');
  // A server that labels the file at all must label it as what it is; a generic label is let through.
  if (got.type && !/^(application\/octet-stream|binary\/octet-stream)/.test(got.type) && !TYPE_OK[kind].test(got.type)) {
    throw new WebImageError(`文件类型对不上（声明为 ${got.type.split(';')[0]}，实际是 ${kind}）`);
  }
  const stem = `web-${createHash('sha1').update(got.body).digest('hex').slice(0, 12)}`;
  if (kind === 'svg') {
    const text = got.body.toString('utf8');
    if (!safeSvg(text)) throw new WebImageError('这个 SVG 里有脚本或外部引用，不能用');
    const file = `${stem}.svg`;
    await writeFile(join(dir, file), text);
    const m = /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
    return { file, url: got.url, width: Math.round(Number(m?.[1] ?? 0)), height: Math.round(Number(m?.[2] ?? 0)), format: kind };
  }
  const tmp = join(dir, `${stem}.download`);
  const file = `${stem}.png`;
  await writeFile(tmp, got.body);
  try {
    // Decoded and written again: only pixels survive, at most maxSide on the long edge.
    const s = WEB_LIMITS.maxSide;
    await ffmpeg(['-i', tmp, '-frames:v', '1', '-vf', `scale='min(${s},iw)':'min(${s},ih)':force_original_aspect_ratio=decrease`, join(dir, file)]);
  } catch {
    throw new WebImageError('图片无法解码');
  } finally {
    await rm(tmp, { force: true });
  }
  const { width, height } = await pngSize(join(dir, file));
  if (width < 16 || height < 16) { await rm(join(dir, file), { force: true }); throw new WebImageError('图片太小'); }
  return { file, url: got.url, width, height, format: kind };
}

async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const b = await readFile(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// ------------------------------------------------------------------------------------------------ pages

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find((x) => x !== undefined)?.trim() ?? '';
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Picture URLs a page offers, best first for the purpose: logos and icons for a logo; og:image and the main pictures for a picture. */
export function pageCandidates(html: string, base: string, want: 'logo' | 'image'): string[] {
  const og: string[] = [], logos: string[] = [], big: string[] = [], touch: string[] = [], icons: Array<{ url: string; size: number }> = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (/^(og:image(:secure_url)?|twitter:image(:src)?)$/.test(key) && attr(tag, 'content')) og.push(attr(tag, 'content'));
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel').toLowerCase(), href = attr(tag, 'href');
    if (!href) continue;
    if (/apple-touch-icon/.test(rel)) touch.push(href);
    else if (/\bicon\b/.test(rel)) icons.push({ url: href, size: Math.max(0, ...(attr(tag, 'sizes').match(/\d+/g) ?? ['0']).map(Number)) });
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = attr(tag, 'src') || attr(tag, 'data-src');
    if (!src) continue;
    if (/logo/i.test(`${src} ${attr(tag, 'alt')} ${attr(tag, 'class')} ${attr(tag, 'id')}`)) logos.push(src);
    // The page's main pictures: declared at least 300 px on a side.
    else if (Math.max(Number(attr(tag, 'width')) || 0, Number(attr(tag, 'height')) || 0) >= 300) big.push(src);
  }
  const ordered = want === 'logo'
    ? [...logos, ...touch, ...icons.sort((a, b) => b.size - a.size).map((i) => i.url), ...og]
    : [...og, ...big, ...logos, ...touch];
  const out: string[] = [];
  for (const raw of ordered) {
    try {
      const u = checkUrl(decode(raw), base).toString();
      if (!out.includes(u)) out.push(u);
    } catch { /* not https or not public: skipped */ }
  }
  return out;
}

/**
 * Fetches `url`: a picture is saved directly; a page gives up to WEB_LIMITS.candidates pictures. Returns the saved
 * pictures (in `dir`), the page they came from, and why the others were skipped.
 */
export async function fetchWebPictures(url: string, dir: string, want: 'logo' | 'image', deps: WebDeps = NET): Promise<{ page: string; pictures: WebPicture[]; skipped: string[] }> {
  const first = await webGet(url, Math.max(WEB_LIMITS.pageBytes, WEB_LIMITS.imageBytes), deps);
  if (sniff(first.body)) return { page: first.url, pictures: [await savePicture(first, dir)], skipped: [] };
  if (!/^(text\/html|application\/xhtml)/.test(first.type) && !/<html|<head|<meta/i.test(first.body.subarray(0, 4096).toString('utf8'))) {
    throw new WebImageError(`这个地址既不是图片也不是网页（${first.type.split(';')[0] || '未知类型'}）`);
  }
  if (first.body.length > WEB_LIMITS.pageBytes) throw new WebImageError('网页太大');
  const candidates = pageCandidates(first.body.toString('utf8'), first.url, want);
  if (!candidates.length) throw new WebImageError('这个网页上没找到 logo、图标或分享图');
  const pictures: WebPicture[] = [], skipped: string[] = [];
  for (const c of candidates) {
    if (pictures.length >= WEB_LIMITS.candidates) break;
    try {
      const p = await savePicture(await webGet(c, WEB_LIMITS.imageBytes, deps), dir);
      if (!pictures.some((x) => x.file === p.file)) pictures.push(p);
    } catch (e) {
      skipped.push(`${c}：${(e as Error).message}`);
    }
  }
  if (!pictures.length) throw new WebImageError(`网页上的图片都取不下来（${skipped.slice(0, 2).join('；')}）`);
  return { page: first.url, pictures, skipped };
}
