// Live checks for src/render/models.ts: library search, fetching with the shared cache, the optimisation caps, the
// User-Agent on every request, the assets manifest, and refusals (a redirect off the allowlist, a file listed on
// another host, a download over the byte cap, path traversal in a zip). A setInterval drift probe measures how long
// the main event loop stalls during each step (the optimisation runs in a worker thread and should not stall it).
// Usage: npx tsx scripts/checks/models-check.ts [--quick]
//   --quick skips the heavy model (a ~700k-triangle plant simplified to the default 250k budget).
// Offline (Poly Haven unreachable) the check is skipped and exits 0. Behind an HTTP proxy run it with
// NODE_USE_ENV_PROXY=1 (Node's fetch ignores HTTPS_PROXY otherwise). Everything is written under a temp dir.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const QUICK = process.argv.includes('--quick');
const TMP = mkdtempSync(join(tmpdir(), 'models-check-'));
process.env.DATA_DIR = join(TMP, 'data');
const ASSETS = join(TMP, 'project', 'assets');

// Every request goes through this: logged with its User-Agent; the test hosts' URLs get canned responses.
const realFetch = globalThis.fetch;
const requests: Array<{ url: string; ua: string | null }> = [];
const mocks = new Map<string, () => Response>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, ua: new Headers(init?.headers).get('user-agent') });
  const mock = mocks.get(url);
  return mock ? mock() : realFetch(input, init);
}) as typeof fetch;

const { fetchModel, modelStats, searchModels } = await import('../../src/render/models.ts');

let failures = 0;
const check = (ok: unknown, what: string) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
};

/** Runs a step with a 10 ms drift probe; returns its result, wall time and the worst event-loop stall. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; ms: number; stall: number }> {
  let last = performance.now(), stall = 0;
  const probe = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last - 10); last = now; }, 10);
  const t = performance.now();
  try {
    return { value: await fn(), ms: Math.round(performance.now() - t), stall: Math.round(stall) };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)), ms: Math.round(performance.now() - t), stall: Math.round(stall) };
  } finally {
    clearInterval(probe);
  }
}
const stalls: Array<[string, number, number]> = [];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
}

try {
  const online = await realFetch('https://api.polyhaven.com/types', { headers: { 'User-Agent': 'video_agent' }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.ok).catch(() => false);
  if (!online) {
    console.log('Poly Haven unreachable: skipped (offline).');
    process.exit(0);
  }

  // --- Search -----------------------------------------------------------------------------------------------
  console.log('search');
  const SEARCHES: Array<[string, RegExp]> = [
    ['bread', /\bbread|bun|loaf/i], ['flower pot', /\bpot|planter/i], ['chair', /\bchair/i],
    ['wrench', /\bwrench/i], ['telescope', /\btelescope/i], ['mars rover', /\brover/i],
  ];
  for (const [q, want] of SEARCHES) {
    const r = await timed(() => searchModels(q, { limit: 6 }));
    stalls.push([`search "${q}"`, r.ms, r.stall]);
    const list = r.value ?? [];
    console.log(`  "${q}" ${r.ms} ms, stall ${r.stall} ms: ${r.error ? `ERROR ${r.error.message}` : list.map((c) => `${c.id}${c.realShape ? ' [realShape]' : ''}`).join(', ')}`);
    check(list.length > 0, `"${q}" finds models`);
    check(list[0] && want.test(`${list[0].title} ${list[0].depicts}`), `"${q}" top result fits: ${list[0]?.title ?? '-'} — ${list[0]?.depicts.slice(0, 80) ?? ''}`);
    check(list.every((c) => ['CC0', 'Public domain (NASA)'].includes(c.license) && c.credit && c.depicts && /^https:\/\//.test(c.pageUrl) && typeof c.realShape === 'boolean'),
      `"${q}" every candidate has licence, credit, what it depicts, realShape and a page`);
    check(list.every((c) => (c.source === 'polyhaven' ? c.credit.startsWith('模型：Poly Haven') : c.credit === 'NASA')), `"${q}" credits name the library`);
  }

  // --- Poly Haven fetch, twice (the second from the cache) ----------------------------------------------------
  console.log('fetch Poly Haven');
  const PH = 'polyhaven:combination_wrench';
  const phCaps = { maxTriangles: 1200, maxTexture: 1024 };
  const n0 = requests.length;
  const first = await timed(() => fetchModel(PH, ASSETS, phCaps));
  stalls.push([`fetch ${PH}`, first.ms, first.stall]);
  check(first.value, `${PH} fetched in ${first.ms} ms${first.error ? `: ${first.error.message}` : ''}`);
  const downloads1 = requests.slice(n0).filter((r) => r.url.includes('dl.polyhaven.org')).length;
  check(downloads1 > 0, `first fetch downloaded ${downloads1} files`);
  const n1 = requests.length;
  const second = await timed(() => fetchModel(PH, ASSETS, phCaps));
  stalls.push([`fetch ${PH} again`, second.ms, second.stall]);
  check(second.value?.file === first.value?.file, `second fetch gives the same file (${second.ms} ms)`);
  check(requests.length === n1, `second fetch made no request (${requests.length - n1})`);
  if (first.value) {
    const st = await modelStats(join(ASSETS, first.value.file));
    console.log(`  ${first.value.file}: ${JSON.stringify(st)} sizeMetres ${JSON.stringify(first.value.sizeMetres)}`);
    check(st.triangles <= phCaps.maxTriangles && st.triangles === first.value.triangles, `triangles ${st.triangles} ≤ ${phCaps.maxTriangles}`);
    check(st.textures.maxSize <= phCaps.maxTexture && st.textures.maxSize > 0, `textures ${st.textures.count}, largest ${st.textures.maxSize} px ≤ ${phCaps.maxTexture}`);
    const r = st.bbox ? Math.max(...st.bbox.min.map(Math.abs), ...st.bbox.max.map(Math.abs)) : 0;
    const c = st.bbox ? st.bbox.min.map((v, i) => Math.abs(v + st.bbox!.max[i]!)) : [9];
    check(r <= 1.0001 && r > 0.5 && Math.max(...c) < 1e-3, `centred in a unit sphere (largest |coord| ${r.toFixed(3)})`);
    check(st.bytes === statSync(join(ASSETS, first.value.file)).size && st.bytes === first.value.bytes, `file ${st.bytes} bytes`);
    // Poly Haven lists the model's size in millimetres; the size kept from the file should agree.
    const info = await realFetch(`https://api.polyhaven.com/info/${PH.slice(10)}`, { headers: { 'User-Agent': 'video_agent' } }).then((x) => x.json() as Promise<{ dimensions?: number[] }>);
    const a = [...(info.dimensions ?? [])].map((v) => v / 1000).sort(), b = [...(first.value.sizeMetres ?? [])].sort();
    check(a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]!) <= 0.05 * Math.max(v, 0.01)), `size in metres ${JSON.stringify(b)} ≈ Poly Haven's ${JSON.stringify(a.map((v) => +v.toFixed(4)))}`);
  }

  // --- NASA 3D Resources fetch ----------------------------------------------------------------------------------
  console.log('fetch NASA 3D Resources');
  const rovers = await searchModels('mars rover', { sources: ['nasa3d'], limit: 3 }).catch(() => []);
  const nasaId = rovers[0]?.id;
  check(nasaId, `NASA 3D model to fetch: ${nasaId ?? '-'}`);
  let nasaFile = '';
  if (nasaId) {
    const r = await timed(() => fetchModel(nasaId, ASSETS, { maxTriangles: 60_000, maxTexture: 1024 }));
    stalls.push([`fetch ${nasaId}`, r.ms, r.stall]);
    check(r.value, `${nasaId} fetched in ${r.ms} ms${r.error ? `: ${r.error.message}` : ''}`);
    if (r.value) {
      nasaFile = r.value.file;
      const st = await modelStats(join(ASSETS, r.value.file));
      console.log(`  ${r.value.file}: ${JSON.stringify(st)} sizeMetres ${JSON.stringify(r.value.sizeMetres)}`);
      check(st.triangles <= 60_000, `triangles ${st.triangles} ≤ 60000`);
      check(st.textures.maxSize <= 1024, `largest texture ${st.textures.maxSize} px ≤ 1024`);
      check(r.value.entry.credit === 'NASA' && r.value.entry.license === 'Public domain (NASA)', `credit ${r.value.entry.credit}, ${r.value.entry.license}`);
    }
  }

  // --- Heavy model: simplification in the worker must not stall the main thread ---------------------------------
  if (!QUICK) {
    console.log('heavy model');
    const heavy = 'polyhaven:didelta_spinosa';
    const r = await timed(() => fetchModel(heavy, ASSETS, {}));
    stalls.push([`fetch ${heavy} (default caps)`, r.ms, r.stall]);
    check(r.value, `${heavy} fetched in ${r.ms} ms${r.error ? `: ${r.error.message}` : ''}`);
    if (r.value) {
      const st = await modelStats(join(ASSETS, r.value.file));
      console.log(`  ${r.value.file}: ${st.triangles} triangles, ${st.textures.count} textures ≤ ${st.textures.maxSize} px, ${(st.bytes / 1048576).toFixed(1)} MB`);
      check(st.triangles <= 250_000 && st.textures.maxSize <= 2048, 'default caps: ≤ 250000 triangles, textures ≤ 2048 px');
    }
    check(r.stall < 100, `main thread stall ${r.stall} ms < 100 ms`);
  }

  // --- Manifest ------------------------------------------------------------------------------------------------
  console.log('manifest');
  const manifest = JSON.parse(readFileSync(join(ASSETS, '..', 'assets_manifest.json'), 'utf8')) as Array<Record<string, unknown>>;
  for (const f of [first.value?.file, nasaFile].filter(Boolean)) {
    const e = manifest.find((m) => m.file === f);
    check(e && e.model3d === true && e.kind === 'model' && typeof e.realShape === 'boolean' && e.license && e.credit && e.depicts && e.pageUrl,
      `entry for ${f}: ${e ? `${e.source} ${e.license} "${e.credit}" realShape=${e.realShape}` : 'missing'}`);
  }
  check(new Set(manifest.map((m) => m.file)).size === manifest.length, `${manifest.length} entries, none twice`);

  // --- Refusals -------------------------------------------------------------------------------------------------
  console.log('refusals');
  const json = (v: unknown) => () => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const info = { name: 'Test Model', type: 2, categories: ['test'], tags: ['test'], authors: { Tester: 'All' } };
  const phFiles = (url: string, size = 100) => ({ gltf: { '1k': { gltf: { url, size, include: {} } } } });
  const evil = () => requests.filter((r) => new URL(r.url).hostname.endsWith('example.net')).length;

  mocks.set('https://api.polyhaven.com/info/zz_redirect', json(info));
  mocks.set('https://api.polyhaven.com/files/zz_redirect', json(phFiles('https://dl.polyhaven.org/file/zz_redirect/model.gltf')));
  mocks.set('https://dl.polyhaven.org/file/zz_redirect/model.gltf', () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/steal' } }));
  const redir = await fetchModel('polyhaven:zz_redirect', ASSETS, phCaps).then(() => null, (e: Error) => e.message);
  check(redir?.includes('不在允许的来源') && evil() === 0, `redirect to another host refused (${redir})`);

  mocks.set('https://api.polyhaven.com/info/zz_offlist', json(info));
  mocks.set('https://api.polyhaven.com/files/zz_offlist', json(phFiles('https://evil.example.net/model.gltf')));
  const off = await fetchModel('polyhaven:zz_offlist', ASSETS, phCaps).then(() => null, (e: Error) => e.message);
  check(off?.includes('不在允许的来源') && evil() === 0, `file listed on another host refused (${off})`);

  // Listed as bigger than the cap: refused before anything is downloaded.
  const n2 = requests.length;
  const listed = await fetchModel('polyhaven:ArmChair_01', ASSETS, { maxTexture: 1024, maxBytes: 200_000 }).then(() => null, (e: Error) => e.message);
  check(listed?.includes('下载上限') && !requests.slice(n2).some((r) => r.url.includes('dl.polyhaven.org')), `model listed over the byte cap refused before downloading (${listed})`);

  // Listed as small but streams more, without a Content-Length: cut off at the cap, nothing left behind.
  mocks.set('https://api.polyhaven.com/info/zz_big', json(info));
  mocks.set('https://api.polyhaven.com/files/zz_big', json(phFiles('https://dl.polyhaven.org/file/zz_big/model.gltf')));
  mocks.set('https://dl.polyhaven.org/file/zz_big/model.gltf', () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 48; i++) c.enqueue(new Uint8Array(64 * 1024)); c.close(); },
  })));
  const big = await fetchModel('polyhaven:zz_big', ASSETS, { maxBytes: 1024 * 1024 }).then(() => null, (e: Error) => e.message);
  const leftovers = files(join(TMP, 'data', 'model-cache')).filter((f) => f.includes('zz_big') || f.includes('.part'));
  check(big?.includes('下载上限') && !leftovers.length, `stream over the byte cap cut off, nothing left behind (${big})`);

  // A NASA page whose only download is a zip with a path-traversal entry and the model further down.
  if (first.value) {
    const glb = readFileSync(join(ASSETS, first.value.file));
    const zip = makeZip([['../../escaped.glb', Buffer.from('not a model')], ['docs/readme.txt', Buffer.from('hello')], ['model/thing.glb', glb]]);
    const page = `<html><head><meta property="og:title" content="Zip Test - NASA Science"><meta property="og:description" content="A test object."></head><body>
      <h4 class="label">Source</h4> <p>NASA/Test Center</p>
      <div class="hds-list-row hds-file-list-row"><h2 class="heading-22">zip-test.zip</h2><p class="p-sm"> (${(zip.length / 1024).toFixed(2)} KB)</p>
      <a href="https://assets.science.nasa.gov/content/dam/zz/zip-test.zip?x=1">Download</a></div></body></html>`;
    mocks.set('https://science.nasa.gov/3d-resources/zz-zip-test/', () => new Response(page, { headers: { 'content-type': 'text/html' } }));
    mocks.set('https://assets.science.nasa.gov/content/dam/zz/zip-test.zip?x=1', () => new Response(new Uint8Array(zip)));
    const z = await timed(() => fetchModel('nasa3d:zz-zip-test', ASSETS, phCaps));
    const escaped = files(TMP).filter((f) => f.endsWith('escaped.glb'));
    check(z.value && !escaped.length, `zip: model taken out, traversal entry never written (${z.error?.message ?? z.value?.file})`);
  }

  // --- User-Agent ---------------------------------------------------------------------------------------------
  // Poly Haven wants the software named ('video_agent'), Wikimedia a contact URL: video_agent/<version> (+https://…).
  const wrongUa = requests.filter((r) => !/^video_agent\/\S+ \(\+https:\/\/\S+\)$/.test(r.ua ?? ''));
  check(requests.length > 0 && !wrongUa.length, `User-Agent 'video_agent/<version> (+<url>)' on all ${requests.length} requests${wrongUa.length ? `; not on ${wrongUa[0]!.url} (${wrongUa[0]!.ua})` : ''}`);
  check(requests.every((r) => /^https:\/\//.test(r.url)), 'every request over https');
  // Worker threads share the process, so this covers the optimisation too.
  const native = ((process.report.getReport() as { sharedObjects?: string[] }).sharedObjects ?? []).filter((f) => /sharp|vips/i.test(f));
  check(!native.length, `no native image library loaded${native.length ? `: ${native.join(', ')}` : ''}`);

  console.log('\nmain-thread stalls (10 ms drift probe):');
  for (const [what, ms, stall] of stalls) console.log(`  ${what.padEnd(56)} ${String(ms).padStart(6)} ms   worst stall ${stall} ms`);
  const cache = files(join(TMP, 'data', 'model-cache')).map((f) => f.slice(TMP.length + 1));
  console.log(`\ncache (${cache.length} files):\n  ${cache.slice(0, 40).join('\n  ')}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

/** A plain zip (deflate) of the given entries; names are written as given, including hostile ones. */
function makeZip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), comp = deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    offset += lh.length + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
