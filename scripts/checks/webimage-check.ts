// Offline check of web picture fetching (src/media/webimage.ts, src/tools/web-image.ts) and of the library retry
// (src/core/http.ts). DNS and the network are replaced by fakes, so nothing leaves this machine: private and reserved
// addresses, http, odd ports, redirects into the local network (by IP and by a name that resolves there), too many
// hops, byte caps, content-type mismatches, unsafe SVG, page candidates (og:image, logos, icons, main pictures), and
// the retry with Retry-After. Usage: npx tsx scripts/checks/webimage-check.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUrl, fetchWebPictures, isPublicIp, pageCandidates, readCapped, webGet, type WebDeps } from '../../src/media/webimage.ts';
import { Refused, withRetry } from '../../src/core/http.ts';

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => {
  try { await p; check(false, `${what} (was let through)`); } catch (e) { check(re.test((e as Error).message), `${what}: ${(e as Error).message}`); }
};

console.log('addresses');
for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::5', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', '::7f00:1', '::127.0.0.1', '::8.8.8.8', '::a00:1', '0:0:0:0:0:0:0:1', '0::5', '::1:2:3']) {
  check(!isPublicIp(ip), `${ip} is not public`);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) check(isPublicIp(ip), `${ip} is public`);

console.log('urls');
for (const [u, why] of [['http://example.com/a.png', 'https'], ['https://localhost/a.png', '本机'], ['https://127.0.0.1/a.png', '本机'], ['https://[::1]/a.png', '本机'],
  ['https://example.com:8443/a.png', '端口'], ['https://user:pw@example.com/a.png', '账号'], ['https://intranet.internal/a.png', '本机'], ['https://printer/a.png', '本机'], ['ftp://example.com/a', 'https']] as const) {
  try { checkUrl(u); check(false, `${u} refused`); } catch (e) { check((e as Error).message.includes(why), `${u} refused: ${(e as Error).message}`); }
}
check(checkUrl('https://www.example.com/logo.png').hostname === 'www.example.com', 'plain https URL accepted');

// A fake internet: names resolve as listed, pages answer from a table.
const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xd32f2f:size=200x80', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']);
const DNS: Record<string, string> = { 'brand.example': '93.184.216.34', 'cdn.brand.example': '93.184.216.35', 'sneaky.example': '10.0.0.7', 'other.example': '93.184.216.36' };
type Page = { status?: number; type?: string; body?: Buffer | string; location?: string };
const PAGES: Record<string, Page> = {
  'https://brand.example/': { type: 'text/html; charset=utf-8', body: `<html><head><meta property="og:image" content="https://cdn.brand.example/share.png">
    <link rel="icon" sizes="32x32" href="/favicon.png"><link rel="apple-touch-icon" href="https://sneaky.example/touch.png"></head>
    <body><img class="site-logo" src="/img/logo.png" alt="Brand"><img src="http://cdn.brand.example/insecure-logo.png"></body></html>` },
  'https://brand.example/img/logo.png': { type: 'image/png', body: png },
  'https://brand.example/favicon.png': { type: 'image/png', body: png },
  'https://cdn.brand.example/share.png': { type: 'image/png', body: png },
  'https://brand.example/to-ip': { status: 302, location: 'https://10.0.0.8/x.png' },
  'https://brand.example/to-http': { status: 301, location: 'http://brand.example/logo.png' },
  'https://brand.example/to-sneaky': { status: 302, location: 'https://sneaky.example/logo.png' },
  'https://brand.example/huge.png': { type: 'image/png', body: Buffer.alloc(11 * 1024 * 1024) },
  'https://brand.example/liar.png': { type: 'text/html', body: png },
  'https://brand.example/evil.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>' },
  'https://brand.example/ok.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#d32f2f"/></svg>' },
  'https://brand.example/text': { type: 'text/plain', body: 'hello' },
};
for (let i = 0; i < 8; i++) PAGES[`https://brand.example/loop${i}`] = { status: 302, location: `https://brand.example/loop${i + 1}` };
const sent: string[] = [];
const deps: WebDeps = {
  resolve: async (host) => {
    const a = DNS[host];
    if (!a) throw new Error(`找不到网站 ${host}`);
    if (!isPublicIp(a)) throw new Error('这个网址指向本机或内网地址，不能访问');
    return [{ address: a, family: 4 }];
  },
  send: async (u, _addr, cap) => {
    sent.push(u.toString());
    const p = PAGES[u.toString()] ?? { status: 404 };
    const body = Buffer.from(p.body ?? '');
    async function* chunks() { for (let i = 0; i < body.length; i += 65536) yield body.subarray(i, i + 65536); }
    return { status: p.status ?? 200, type: p.type ?? '', location: p.location ?? null, body: p.location ? Buffer.alloc(0) : await readCapped(chunks(), cap) };
  },
};

console.log('redirects and addresses on every hop');
await rejects(webGet('https://sneaky.example/logo.png', 1 << 20, deps), /内网/, 'a name that resolves to 10.0.0.7');
await rejects(webGet('https://brand.example/to-ip', 1 << 20, deps), /本机或内网/, 'redirect to https://10.0.0.8');
await rejects(webGet('https://brand.example/to-http', 1 << 20, deps), /https/, 'redirect to http');
await rejects(webGet('https://brand.example/to-sneaky', 1 << 20, deps), /内网/, 'redirect to a name that resolves to the local network');
await rejects(webGet('https://brand.example/loop0', 1 << 20, deps), /跳转次数太多/, 'eight redirects in a row');
check(!sent.some((u) => !isPublicIp(DNS[new URL(u).hostname] ?? new URL(u).hostname)), `no request ever went to a local address (${sent.length} sent)`);

console.log('pictures');
const dir = mkdtempSync(join(tmpdir(), 'webimage-check-'));
await rejects(fetchWebPictures('https://brand.example/huge.png', dir, 'logo', deps), /上限/, '11 MB picture over the 10 MB cap');
await rejects(fetchWebPictures('https://brand.example/liar.png', dir, 'logo', deps), /类型对不上/, 'PNG bytes served as text/html');
await rejects(fetchWebPictures('https://brand.example/evil.svg', dir, 'logo', deps), /脚本/, 'SVG with a script');
await rejects(fetchWebPictures('https://brand.example/text', dir, 'logo', deps), /既不是图片也不是网页/, 'plain text');
const svg = await fetchWebPictures('https://brand.example/ok.svg', dir, 'logo', deps);
check(svg.pictures[0]?.format === 'svg' && svg.pictures[0].width === 120, `clean SVG kept as SVG (${svg.pictures[0]?.file})`);
const page = await fetchWebPictures('https://brand.example/', dir, 'logo', deps);
check(page.pictures.length >= 1 && page.pictures[0]!.url === 'https://brand.example/img/logo.png', `logo image picked first from the page (${page.pictures.map((p) => p.url).join(', ')})`);
check(page.skipped.some((s) => /sneaky/.test(s)), 'the icon on a local-network host was skipped');
check(!page.pictures.some((p) => /insecure/.test(p.url)), 'the http logo was not used');
const saved = readFileSync(join(dir, page.pictures[0]!.file));
check(saved.subarray(1, 4).toString() === 'PNG' && page.pictures[0]!.width === 200, 'saved as a re-encoded 200 px PNG');
const og = pageCandidates(PAGES['https://brand.example/']!.body as string, 'https://brand.example/', 'image');
check(og[0] === 'https://cdn.brand.example/share.png', 'want "image" puts og:image first');
rmSync(dir, { recursive: true, force: true });

console.log('page candidates');
const html = `<head><meta property="og:image" content="https://cdn.brand.example/share.png"><meta name="twitter:image" content="/tw.png">
  <link rel="icon" sizes="16x16" href="/i16.png"><link rel="icon" sizes="192x192" href="/i192.png"><link rel="apple-touch-icon" href="/touch.png"></head>
  <body><img src="/hero.jpg" width="1200" height="600"><img src="/thumb.jpg" width="80" height="80"><img src="/assets/brand-logo.svg" alt="Brand">
  <img src="http://brand.example/insecure.png" width="900"><img src="https://10.0.0.9/inner.png" width="900"></body>`;
const forLogo = pageCandidates(html, 'https://brand.example/', 'logo');
check(forLogo[0] === 'https://brand.example/assets/brand-logo.svg' && forLogo[1] === 'https://brand.example/touch.png' && forLogo[2] === 'https://brand.example/i192.png', `logo order: logo image, touch icon, largest icon (${forLogo.slice(0, 3).join(', ')})`);
const forImage = pageCandidates(html, 'https://brand.example/', 'image');
check(forImage[0] === 'https://cdn.brand.example/share.png' && forImage.includes('https://brand.example/hero.jpg') && !forImage.includes('https://brand.example/thumb.jpg'), `picture order: og:image, then main pictures; small ones left out (${forImage.slice(0, 4).join(', ')})`);
check(![...forLogo, ...forImage].some((u) => /insecure|10\.0\.0\.9/.test(u)), 'http and private-address pictures never offered');

console.log('library retry');
let calls = 0;
const res = await withRetry('Wikimedia Commons', async () => (++calls < 3 ? new Response('busy', { status: 403 }) : new Response('{}', { status: 200 })), [10, 30]);
check(res.status === 200 && calls === 3, `two 403s then 200: answered after ${calls} tries`);
calls = 0;
try {
  await withRetry('Wikimedia Commons', async () => { calls++; return new Response('<p>Please set a user-agent and respect our robot policy</p>', { status: 403 }); }, [10, 30]);
  check(false, 'three 403s throw');
} catch (e) {
  check(e instanceof Refused && calls === 3 && /Wikimedia Commons拒绝了请求（403）：Please set a user-agent/.test((e as Error).message) && /不是不能联网/.test((e as Error).message), `three 403s: ${(e as Error).message}`);
}
const t0 = Date.now();
calls = 0;
await withRetry('x', async () => (++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : new Response('', { status: 200 })), [10, 30]);
check(Date.now() - t0 >= 950, `Retry-After: 1 waited ${Date.now() - t0} ms instead of 10`);
calls = 0;
const r404 = await withRetry('x', async () => { calls++; return new Response('', { status: 404 }); }, [10, 30]);
check(r404.status === 404 && calls === 1, '404 is not retried');

if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('All web picture checks passed');
