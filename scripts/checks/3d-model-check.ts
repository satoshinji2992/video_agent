// Checks that 3D shot pages can load glTF models offline: Khronos sample models are downloaded into a temp
// project's assets/, then a page loads each through the vendored GLTFLoader (plain GLB, Draco through DRACOLoader,
// meshopt through MeshoptDecoder) and is rendered by the real scene renderer (supersample 2, 16:9 and 9:16),
// pinned to 4 cores. Asserts frames are not blank and do move, no console errors, no request left the synthetic
// origin and none was aborted; prints each model's license (from the sample repo's metadata.json), per-frame
// time (reported against the 150 ms budget, not asserted: it depends on the model and the machine's load) and the
// scene complexity the renderer reports. A page without window.__three must report complexity null.
// Usage: npx tsx scripts/checks/3d-model-check.ts [--out DIR] [--seconds N] [--no-pin] [name-filter...]
//   --out keeps the videos and a few extracted frames in DIR; without it everything is temporary.
//   Re-runs itself under `taskset -c 28-31` unless --no-pin (or already pinned).
// Offline (sample downloads fail) the model cases are skipped and only the no-__three case runs.
// Behind an HTTP proxy run it with NODE_USE_ENV_PROXY=1 if Node's fetch does not reach GitHub.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { FRAME_SIZE, config, type Aspect } from '../../src/core/config.ts';
import { closeBrowser, renderScene, type RenderResult } from '../../src/render/renderer.ts';

const CPUS = '28-31';
const BUDGET_MS = 150;
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  argv.splice(i, 2);
  return v;
};
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

/** Runs a child with a SIGKILL timeout and returns its stdout. */
function run(cmd: string, args: string[], ms = 60_000, inherit = false): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), ms);
    p.stdout?.on('data', (b: Buffer) => out.push(b));
    p.stderr?.on('data', (b: Buffer) => err.push(b));
    p.on('error', (e) => { clearTimeout(timer); rej(e); });
    p.on('close', (code, sig) => {
      clearTimeout(timer);
      code === 0 ? res(Buffer.concat(out)) : rej(new Error(`${cmd} exited ${code ?? sig}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
  });
}

const allowed = /Cpus_allowed_list:\s*(\S+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
if (!flag('--no-pin') && allowed !== CPUS) {
  // Chrome and ffmpeg inherit the affinity: the whole render runs on 4 cores, like the production server.
  await run('taskset', ['-c', CPUS, process.execPath, ...process.execArgv, process.argv[1]!, ...process.argv.slice(2), '--no-pin'], 3_600_000, true)
    .then(() => process.exit(0), () => process.exit(1));
}

const OUT = opt('--out');
const SECONDS = Number(opt('--seconds') ?? 3);
const filters = argv;
const ASPECTS: Aspect[] = ['16:9', '9:16'];

const BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
const CASES = [
  { name: 'helmet-glb', model: 'DamagedHelmet', entry: 'DamagedHelmet.glb', files: ['glTF-Binary/DamagedHelmet.glb'] },
  { name: 'duck-draco', model: 'Duck', entry: 'Duck.gltf', files: ['glTF-Draco/Duck.gltf', 'glTF-Draco/Duck.bin', 'glTF-Draco/DuckCM.png'] },
  { name: 'brainstem-meshopt', model: 'BrainStem', entry: 'BrainStem.gltf', files: ['glTF-Meshopt/BrainStem.gltf', 'glTF-Meshopt/BrainStem.bin'] },
].filter((c) => !filters.length || filters.some((f) => c.name.includes(f)));

const BG = [0x20, 0x24, 0x2c] as const;

/** Download with a byte cap, a timeout and redirects followed by hand only within raw.githubusercontent.com. */
async function download(url: string, maxBytes = 32 << 20): Promise<Buffer> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== 'https:' || u.hostname !== 'raw.githubusercontent.com') throw new Error(`redirect off allowlist: ${u}`);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) { await res.body?.cancel().catch(() => {}); u = new URL(loc, u); continue; }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${u}`);
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of res.body as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > maxBytes) throw new Error(`over ${maxBytes} bytes: ${u}`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`too many redirects: ${url}`);
}

/** The model's license line(s) from the sample repo's metadata.json. */
async function license(model: string) {
  try {
    const meta = JSON.parse((await download(`${BASE}${model}/metadata.json`, 1 << 20)).toString('utf8')) as {
      legal?: { license?: string; owner?: string; artist?: string; year?: string; what?: string }[];
    };
    return (meta.legal ?? []).map((l) => `${l.license} (${l.what ?? '?'}: ${l.artist ?? l.owner ?? '?'} ${l.year ?? ''})`.trim()).join('; ') || 'not stated';
  } catch (e) {
    return `unknown (${(e as Error).message})`;
  }
}

/** 64-px-wide RGB samples at 4 fps: share of pixels that are not background, and mean change between samples. */
async function analyze(mp4: string, w: number, h: number) {
  const tw = 64, th = Math.round((64 * h) / w / 2) * 2;
  const raw = await run('ffmpeg', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', mp4, '-vf', `fps=4,scale=${tw}:${th}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  const n = tw * th * 3, frames = Math.floor(raw.length / n);
  const cover: number[] = [], diffs: number[] = [];
  for (let f = 0; f < frames; f++) {
    let fg = 0, d = 0;
    for (let i = 0; i < n; i += 3) {
      const o = f * n + i;
      if (Math.max(Math.abs(raw[o]! - BG[0]), Math.abs(raw[o + 1]! - BG[1]), Math.abs(raw[o + 2]! - BG[2])) > 20) fg++;
      if (f > 0) for (let k = 0; k < 3; k++) d += Math.abs(raw[o + k]! - raw[o + k - n]!);
    }
    cover.push(fg / (n / 3));
    if (f > 0) diffs.push(d / n);
  }
  return { minCover: Math.min(...cover), avgDiff: diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length), samples: frames };
}

/** A shot page that loads /assets/<entry>; withThree=false leaves out window.__three. */
function page(entry: string | null, withThree = true) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#20242c}canvas{display:block}</style>
<script type="importmap">{ "imports": { "three": "/vendor/three/build/three.module.js", "three/addons/": "/vendor/three/examples/jsm/" } }</script>
</head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242c);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 5, 4);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100);
const pivot = new THREE.Group();
scene.add(pivot);
${withThree ? 'window.__three = { renderer, scene };' : '// no window.__three on purpose'}

const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
const load = ${entry ? `loader.loadAsync(${JSON.stringify('/assets/' + entry)})` : `Promise.resolve({ scene: new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 128, 16), new THREE.MeshStandardMaterial({ color: 0xd08040 })), animations: [] })`};
let mixer = null;
window.sceneReady = load.then(async (gltf) => {
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  pivot.scale.setScalar(2 / Math.max(size.x, size.y, size.z));
  pivot.add(root);
  if (gltf.animations.length) { mixer = new THREE.AnimationMixer(root); mixer.clipAction(gltf.animations[0]).play(); }
  const dist = 1.25 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect);
  camera.position.set(0, dist * 0.25, dist);
  camera.lookAt(0, 0, 0);
  await renderer.compileAsync(scene, camera);
  draco.dispose();
});
window.renderFrame = (t) => {
  pivot.rotation.y = -0.6 + t * 0.5;
  if (mixer) mixer.setTime(t);
  renderer.render(scene, camera);
};
</script></body></html>`;
}

// Network audit without touching the renderer: wrap the browser it launches so every context it opens reports
// requests that leave the synthetic origin, and the ones that failed (the renderer aborts those).
const net = { outside: [] as string[], failed: [] as string[], served: 0 };
const origLaunch = chromium.launch.bind(chromium);
(chromium as { launch: typeof chromium.launch }).launch = async (o) => {
  const b: Browser = await origLaunch(o);
  const newContext = b.newContext.bind(b);
  b.newContext = async (co) => {
    const ctx: BrowserContext = await newContext(co);
    ctx.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('http://scene.invalid/')) net.served++;
      else if (!u.startsWith('blob:') && !u.startsWith('data:')) net.outside.push(u);
    });
    ctx.on('requestfailed', (r) => net.failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
    return ctx;
  };
  return b;
};

const tmp = mkdtempSync(join(tmpdir(), '3d-model-check-'));
const out = OUT ? resolve(OUT) : join(tmp, 'out');
mkdirSync(join(out, 'frames'), { recursive: true });
const work = join(tmp, 'project');
mkdirSync(join(work, 'assets'), { recursive: true });
const rows: Record<string, unknown>[] = [];
let failures = 0;

const render = async (html: string, tag: string, aspect: Aspect, seconds: number, outPath: string) => {
  const t0 = performance.now();
  const r: RenderResult = await renderScene({ html, seconds, aspect, workspaceDir: work, scenePath: join(work, `${tag}.html`), outPath, supersample: 2 });
  return { ms: performance.now() - t0, r };
};

try {
  console.log(`cpus ${allowed}, ${SECONDS}s at ${config.fps} fps, supersample 2`);
  // A page without window.__three: the renderer must say so with complexity null (not leave it out).
  {
    net.outside.length = 0; net.failed.length = 0;
    const { r } = await render(page(null, false), 'no-three', '16:9', 2 / config.fps, join(tmp, 'no-three.mp4'));
    const problems = [r.complexity !== null && `complexity should be null, got ${JSON.stringify(r.complexity)}`, r.consoleErrors.length && `page errors: ${r.consoleErrors.join(' | ')}`].filter(Boolean);
    if (problems.length) failures++;
    rows.push({ case: 'no-__three', aspect: '16:9', complexity: JSON.stringify(r.complexity), ok: problems.length ? problems.join('; ') : 'OK' });
    console.log(`no-__three: complexity=${JSON.stringify(r.complexity)} ${problems.length ? problems.join('; ') : 'OK'}`);
  }
  for (const c of CASES) {
    try {
      let bytes = 0;
      for (const f of c.files) {
        const buf = await download(`${BASE}${c.model}/${f}`);
        writeFileSync(join(work, 'assets', f.split('/').pop()!), buf);
        bytes += buf.length;
      }
      console.log(`downloaded ${c.name}: ${c.files.map((f) => `${c.model}/${f}`).join(' ')} (${bytes} bytes)`);
      console.log(`  license: ${await license(c.model)}`);
    } catch (e) {
      console.log(`SKIP ${c.name}: download failed (${(e as Error).message})`);
      rows.push({ case: c.name, ok: 'SKIP offline' });
      continue;
    }
    const html = page(c.entry);
    for (const aspect of ASPECTS) {
      const tag = `${c.name}_${aspect.replace(':', 'x')}`;
      net.outside.length = 0; net.failed.length = 0; net.served = 0;
      try {
        // A one-frame render (launch, page load, model decode, shader compile) and a full one: the difference
        // over the extra frames is the steady per-frame cost (renderFrame + 2x screenshot + JPEG + encode).
        const one = await render(html, tag, aspect, 1 / config.fps, join(tmp, `${tag}_one.mp4`));
        const mp4 = join(out, `${tag}.mp4`);
        const full = await render(html, tag, aspect, SECONDS, mp4);
        const frames = Math.round(SECONDS * config.fps);
        const perFrame = (full.ms - one.ms) / (frames - 1);
        const { width, height } = FRAME_SIZE[aspect];
        const a = await analyze(mp4, width, height);
        if (OUT) {
          for (const at of [0.1, SECONDS / 2, SECONDS - 0.1]) {
            await run('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-ss', at.toFixed(2), '-i', mp4, '-frames:v', '1', join(out, 'frames', `${tag}_t${at.toFixed(1)}.png`)]);
          }
        }
        const cx = full.r.complexity;
        const errors = [...new Set([...one.r.consoleErrors, ...full.r.consoleErrors])];
        const problems = [
          a.minCover < 0.02 && `blank frame (model covers ${(a.minCover * 100).toFixed(1)}%)`,
          a.avgDiff < 0.3 && `no motion (avg diff ${a.avgDiff.toFixed(2)})`,
          !cx && `no complexity reported (${JSON.stringify(cx)})`,
          cx && one.r.complexity && JSON.stringify(cx) !== JSON.stringify(one.r.complexity) && 'complexity differs between runs',
          errors.length && `page errors: ${errors.slice(0, 3).join(' | ')}`,
          net.outside.length && `requests left the origin: ${net.outside.join(', ')}`,
          net.failed.length && `aborted/failed requests: ${net.failed.join(', ')}`,
        ].filter(Boolean);
        const row = {
          case: c.name, aspect, frames,
          setupMs: Math.round(one.ms), perFrameMs: Math.round(perFrame), budget: perFrame > BUDGET_MS ? `OVER ${BUDGET_MS}` : 'ok', totalMs: Math.round(full.ms),
          minCoverPct: +(a.minCover * 100).toFixed(1), avgFrameDiff: +a.avgDiff.toFixed(2),
          ...cx,
          requests: `${net.served} served, ${net.outside.length} outside, ${net.failed.length} aborted`,
          ok: problems.length ? problems.join('; ') : 'OK',
        };
        if (problems.length) failures++;
        rows.push(row);
        console.log(JSON.stringify(row));
      } catch (e) {
        failures++;
        rows.push({ case: c.name, aspect, ok: `FAIL ${(e as Error).message}` });
        console.log(`FAIL ${tag}: ${(e as Error).message}`);
      }
    }
  }
} finally {
  await closeBrowser();
  rmSync(tmp, { recursive: true, force: true });
}
console.table(rows);
if (OUT) console.log(`videos and frames kept in ${out}`);
process.exit(failures ? 1 : 0);
