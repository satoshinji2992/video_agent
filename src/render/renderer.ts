// Renders a code-animation scene: an HTML page that defines window.renderFrame(t) (t in seconds,
// a pure function of time). Each frame is drawn, screenshotted as JPEG and piped into ffmpeg.
// The page is served from a synthetic origin, so it can reach only its own HTML and the session's
// uploaded assets, plus the read-only vendored three.js under /vendor/three/: no file:// access, no
// network, no WebSockets.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { config, FRAME_SIZE, type Aspect } from '../core/config.ts';
import { atomicOutput, ffmpeg } from '../core/ffmpeg.ts';
import { createLimiter } from '../core/limiter.ts';
import { readIndex } from '../media/ingest.ts';

const ORIGIN = 'http://scene.invalid';
const FRAME_TIMEOUT_MS = 5_000;
// One-time page setup (fonts, an optional window.sceneReady promise such as three.js compileAsync). Allowed to
// take longer than a frame: with several WebGL scenes rendering at once they share one software-GL GPU process.
const SETUP_TIMEOUT_MS = 30_000;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
// The project's assets/ also holds 3D models for three.js GLTFLoader: a .glb, or a .gltf with its .bin buffers and
// textures next to it (flat: a page can only ask for /assets/<basename>, so a .gltf that points into subfolders
// does not load).
const ASSET_MIME: Record<string, string> = {
  ...MIME,
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

// Pinned three.js build (vendor/three, see vendor/three/VERSION), served read-only at /vendor/three/...
// The allowlist is the exact set of regular files under that directory, read once into memory, so a
// request can only ever get one of those files back (no path joining, no traversal, no symlinks).
// three.js (vendor/three, unmodified from npm) and our own 3D detail kit (vendor/kit3d).
const VENDOR_DIR = fileURLToPath(new URL('../../vendor/', import.meta.url));
const VENDOR_PREFIX = '/vendor/';
const VENDOR_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // The Draco mesh decoder (examples/jsm/libs/draco/gltf/), fetched by DRACOLoader.
  '.wasm': 'application/wasm',
};
let vendorFiles: Map<string, Buffer> | null = null;
function vendorFile(pathname: string): Buffer | undefined {
  if (!vendorFiles) {
    vendorFiles = new Map();
    if (existsSync(VENDOR_DIR)) {
      for (const e of readdirSync(VENDOR_DIR, { recursive: true, withFileTypes: true })) {
        if (!e.isFile() || !VENDOR_MIME[extname(e.name)]) continue;
        const abs = join(e.parentPath, e.name);
        vendorFiles.set(relative(VENDOR_DIR, abs).split(sep).join('/'), readFileSync(abs));
      }
    }
  }
  return vendorFiles.get(pathname.slice(VENDOR_PREFIX.length));
}

// WebGL is software-rendered by SwiftShader through ANGLE. Ask for it explicitly: newer Chrome no longer falls
// back to it on its own. Its JIT runs in the GPU process, which is acceptable only because scene pages stay
// fully isolated (no network, synthetic origin) and the service runs unprivileged and sandboxed.
export const CHROME_ARGS = ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'];

let browser: Promise<Browser> | null = null;
function getBrowser() {
  browser ??= chromium
    .launch({ executablePath: config.chromePath, headless: true, args: CHROME_ARGS })
    .then((b) => {
      b.on('disconnected', () => (browser = null));
      return b;
    })
    .catch((e) => {
      browser = null;
      throw e;
    });
  return browser;
}

const limit = createLimiter(config.renderConcurrency);
export const renderLoad = () => ({ active: limit.active(), queued: limit.queued(), max: limit.max });

/**
 * The page's readable text: text nodes whose element is displayed, visible, at least 30% opaque (through its
 * ancestors) and inside the viewport. Runs in the page.
 */
function visibleText(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    const el = n.parentElement;
    if (!t || !el) continue;
    let opacity = 1;
    let hidden = false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; }
      opacity *= Number(cs.opacity || '1');
    }
    if (hidden || opacity < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    out.push(t);
  }
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(what)), ms).unref())]);

/**
 * Before the first frame of a three.js page that sets window.__three = { renderer, scene }: make the renderer's
 * counters add up over every render call of that frame (shadow maps, composer passes) instead of keeping only
 * the last one. Returns the page's own autoReset setting to put back, or null when the page exposes nothing.
 * Runs in the page.
 */
function armComplexity(): boolean | null {
  const t = (window as unknown as { __three?: { renderer?: { info?: { autoReset: boolean; reset(): void } }; scene?: unknown } }).__three;
  const info = t?.renderer?.info;
  if (!info || typeof info.reset !== 'function' || !t?.scene) return null;
  const autoReset = info.autoReset !== false;
  info.autoReset = false;
  info.reset();
  return autoReset;
}

export interface SceneComplexity {
  /** Triangles drawn for the first frame, over all render calls (shadow passes included). */
  triangles: number;
  /** Textures resident on the GPU (render targets included). */
  textures: number;
  /** Visible meshes in the scene. */
  meshes: number;
  /** Triangles of the heaviest single visible mesh (an InstancedMesh counts all its instances). */
  maxMeshTriangles: number;
  /**
   * Visible meshes none of whose materials has any texture map (any texture-valued property, envMap included, or a
   * texture uniform of a ShaderMaterial); scene.environment / scene.background do not count as the mesh's maps.
   */
  plainMeshes: number;
}

/**
 * Reads the counters of the frame just drawn and walks the scene; puts the page's autoReset back (null: the counters
 * were not armed, so triangles covers only the frame's last render call). Null when the page sets no
 * window.__three = { renderer, scene }. Runs in the page.
 */
function readComplexity(autoReset: boolean | null): SceneComplexity | null {
  type Obj = { isMesh?: boolean; isInstancedMesh?: boolean; count?: number; geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } }; drawRange?: { count: number } }; material?: unknown };
  const t = (window as unknown as { __three?: { renderer?: { info?: { autoReset: boolean; render: { triangles: number }; memory: { textures: number } } }; scene?: { traverseVisible?(cb: (o: Obj) => void): void } } }).__three;
  const info = t?.renderer?.info;
  if (!info || !t?.scene || typeof t.scene.traverseVisible !== 'function') return null;
  const triangles = Number(info.render?.triangles) || 0;
  if (autoReset !== null) info.autoReset = autoReset;
  let meshes = 0, maxMeshTriangles = 0, plainMeshes = 0;
  t.scene.traverseVisible((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const verts = Math.min(g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0), g?.drawRange?.count ?? Infinity);
    const tris = Math.floor(verts / 3) * (o.isInstancedMesh ? (o.count ?? 1) : 1);
    if (tris > maxMeshTriangles) maxMeshTriangles = tris;
    const mats = (Array.isArray(o.material) ? o.material : [o.material]) as Record<string, unknown>[];
    // No named helper functions in here: the bundler may wrap them in a __name() the page does not have.
    let mapped = false;
    for (const m of mats) {
      if (!m || typeof m !== 'object') continue;
      const u = (m.uniforms && typeof m.uniforms === 'object' ? m.uniforms : {}) as Record<string, { value?: unknown } | null>;
      const values = [...Object.keys(m).map((k) => m[k]), ...Object.keys(u).map((k) => u[k]?.value)];
      if (values.some((v) => !!v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture === true)) { mapped = true; break; }
    }
    if (!mapped) plainMeshes++;
  });
  return { triangles, textures: Number(info.memory?.textures) || 0, meshes, maxMeshTriangles, plainMeshes };
}

export interface RenderResult {
  consoleErrors: string[];
  /** Visible text on the shot's last frame. */
  text: string;
  /**
   * How heavy the 3D scene is, read after its first frame; only for pages that set
   * window.__three = { renderer, scene } (three.js WebGLRenderer and Scene). Null when the page does not set
   * window.__three; absent when it could not be read.
   */
  complexity?: SceneComplexity | null;
  /** Device pixels per CSS pixel actually used (a supersampled render that was too slow falls back to 1). */
  supersample?: number;
}

export async function renderScene(opts: {
  html: string;
  seconds: number;
  aspect: Aspect;
  workspaceDir: string;
  scenePath: string;
  outPath: string;
  /**
   * Render at this many device pixels per CSS pixel and scale the frames down when encoding: anti-aliasing
   * for 3D shots, whose edges and fine detail alias badly at 480p. The page sees it as window.devicePixelRatio
   * (three.js: renderer.setPixelRatio(window.devicePixelRatio)).
   */
  supersample?: number;
}): Promise<RenderResult> {
  await writeFile(opts.scenePath, opts.html);
  const scale = Math.min(2, Math.max(1, opts.supersample ?? 1));
  try {
    return await renderAt(opts, scale);
  } catch (e) {
    // A heavy scene (textured models, an environment map) costs about four times as much at 2x: rendered again
    // at 1x rather than going over the time budget.
    if (!(e instanceof TooSlow)) throw e;
    return renderAt(opts, 1);
  }
}

/** Above this many milliseconds per frame (render + screenshot) a supersampled render starts over at 1x. */
const SLOW_FRAME_MS = 170;
class TooSlow extends Error {}

async function renderAt(opts: Parameters<typeof renderScene>[0], scale: number): Promise<RenderResult> {
  const { width, height } = FRAME_SIZE[opts.aspect];
  const assetsDir = join(opts.workspaceDir, 'assets');

  return limit(async () => {
    const context = await (await getBrowser()).newContext({ viewport: { width, height }, deviceScaleFactor: scale });
    const consoleErrors: string[] = [];
    try {
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === '/' || url.pathname === '/scene.html') {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: opts.html });
        }
        if (url.pathname.startsWith(VENDOR_PREFIX)) {
          const body = route.request().method() === 'GET' ? vendorFile(url.pathname) : undefined;
          if (body) return route.fulfill({ status: 200, contentType: VENDOR_MIME[extname(url.pathname)], body });
          return route.fulfill({ status: 404, body: '' });
        }
        // The user's uploaded pictures by media id (a logo in an end card), originals so transparency is kept.
        const mm = url.pathname.match(/^\/media\/(m\d{1,4})$/);
        if (mm) {
          const item = readIndex(opts.workspaceDir).find((x) => x.id === mm[1] && x.kind === 'image' && x.status === 'ready');
          const f = item ? join(opts.workspaceDir, item.file) : '';
          const t = f ? MIME[extname(f).toLowerCase()] : undefined;
          if (f && t && f.startsWith(join(opts.workspaceDir, 'assets', 'raw') + sep) && existsSync(f)) return route.fulfill({ status: 200, contentType: t, body: await readFile(f) });
          return route.fulfill({ status: 404, body: '' });
        }
        // A file directly inside the project's assets/, by basename only: a regular file (no symlink, no folder).
        const m = url.pathname.match(/^\/assets\/([^/]+)$/);
        let name = '';
        try { name = m ? basename(decodeURIComponent(m[1]!)) : ''; } catch { /* malformed escape */ }
        const file = name && name !== '.' && name !== '..' ? join(assetsDir, name) : '';
        const type = file ? ASSET_MIME[extname(file).toLowerCase()] : undefined;
        const st = file && type ? lstatSync(file, { throwIfNoEntry: false }) : undefined;
        if (route.request().method() === 'GET' && st?.isFile()) return route.fulfill({ status: 200, contentType: type, body: await readFile(file) });
        return route.fulfill({ status: 404, body: '' });
      });
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      const page = await context.newPage();
      page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
      page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
      await page.goto(`${ORIGIN}/scene.html`, { waitUntil: 'load', timeout: 20_000 });
      await withTimeout(page.evaluate(() => document.fonts.ready.then(() => true)), SETUP_TIMEOUT_MS, '等字体加载超时');
      const hasFn = await page.evaluate(() => typeof (window as unknown as { renderFrame?: unknown }).renderFrame === 'function');
      if (!hasFn) throw new Error(`场景没有定义 window.renderFrame(t)。${consoleErrors.length ? '页面报错：' + consoleErrors.join(' | ') : ''}`);
      // Optional: a scene may expose window.sceneReady (a promise) for async setup, e.g. shader compilation.
      await withTimeout(
        page.evaluate(() => Promise.resolve((window as unknown as { sceneReady?: unknown }).sceneReady).then(() => true)),
        SETUP_TIMEOUT_MS,
        `场景准备（window.sceneReady）超过 ${SETUP_TIMEOUT_MS / 1000} 秒没有完成`,
      );

      const total = Math.round(opts.seconds * config.fps);
      /** Text a viewer can read on screen, sampled mid-shot, late and on the last frame. */
      const seen = new Set<string>();
      // Scene complexity of the first frame (window.__three pages); measuring never fails the render.
      const autoReset = await withTimeout(page.evaluate(armComplexity), FRAME_TIMEOUT_MS, 'complexity').catch(() => null);
      let complexity: SceneComplexity | null | undefined;
      await atomicOutput(opts.outPath, (out) =>
        ffmpeg(
          ['-f', 'image2pipe', '-framerate', String(config.fps), '-c:v', 'mjpeg', '-i', '-',
            ...(scale > 1 ? ['-vf', `scale=${width}:${height}:flags=lanczos`] : []),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', out],
          async (stdin) => {
            let timedFrom = 0;
            for (let i = 0; i < total; i++) {
              // Frames 1-4 are timed (frame 0 compiles shaders); a supersampled render that is too slow stops here.
              if (i === 1) timedFrom = performance.now();
              if (i === 5 && scale > 1 && (performance.now() - timedFrom) / 4 > SLOW_FRAME_MS) throw new TooSlow();
              await withTimeout(
                page.evaluate(async (t) => {
                  await (window as unknown as { renderFrame: (t: number) => unknown }).renderFrame(t);
                }, i / config.fps),
                FRAME_TIMEOUT_MS,
                `renderFrame(${(i / config.fps).toFixed(2)}) 超过 ${FRAME_TIMEOUT_MS / 1000} 秒没有返回`,
              );
              if (i === 0) {
                complexity = await withTimeout(page.evaluate(readComplexity, autoReset), FRAME_TIMEOUT_MS, 'complexity').catch(() => undefined);
              }
              const jpg = await withTimeout(page.screenshot({ type: 'jpeg', quality: 88 }), FRAME_TIMEOUT_MS, '截图超时');
              if (i === Math.floor(total * 0.5) || i === Math.floor(total * 0.8) || i === total - 1) {
                for (const t of await page.evaluate(visibleText).catch(() => [] as string[])) seen.add(t);
              }
              if (!stdin.write(jpg)) {
                // All three listeners go once any fires: left behind, they pile up on the pipe frame after frame.
                await new Promise<void>((resolve, reject) => {
                  const done = (err?: Error) => {
                    stdin.off('drain', onDrain);
                    stdin.off('error', onError);
                    stdin.off('close', onClose);
                    if (err) reject(err);
                    else resolve();
                  };
                  const onDrain = () => done();
                  const onError = (e: Error) => done(e);
                  const onClose = () => done(new Error('ffmpeg 提前退出'));
                  stdin.once('drain', onDrain);
                  stdin.once('error', onError);
                  stdin.once('close', onClose);
                });
              }
              if (consoleErrors.length > 20) throw new Error('页面持续报错：' + consoleErrors.slice(0, 3).join(' | '));
            }
          },
        ),
      );
      // The words the finished shot shows (cards, titles, labels): subtitles that would only repeat them are
      // left out. Text drawn on a canvas is not seen.
      return { consoleErrors, text: [...seen].join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000), complexity, supersample: scale };
    } finally {
      await context.close().catch(() => {});
    }
  });
}

export async function closeBrowser() {
  if (browser) await (await browser).close();
}
