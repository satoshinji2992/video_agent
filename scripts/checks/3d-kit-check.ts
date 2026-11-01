// Renders one demo page per technique of the generic detail kit (vendor/kit3d/) through the real
// scene renderer at supersample 2, pinned to 4 cores, at 854x480 and 480x854. Fails on console errors, blank frames,
// more than 150k triangles or frames near the renderer's timeout; warns when the in-page draw time exceeds the 60 ms
// target or the end-to-end frame time is far above baseline-plain (a plain lit scene rendered in the same run). Prints
// per-demo triangles and timings and saves frames (PNG at the real output size) for a visual check. Subjects are deliberately generic: a stone, a loaf on a board, a row of
// surface recipes, a camera body, material swatches, a backpack.
// Usage: npx tsx scripts/checks/3d-kit-check.ts --out DIR [--seconds N] [--aspects 16:9,9:16] [--no-pin] [name-filter...]
//   Re-runs itself under `taskset -c 24-27` unless --no-pin (or already pinned).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { FRAME_SIZE, config, type Aspect } from '../../src/core/config.ts';
import { closeBrowser, renderScene } from '../../src/render/renderer.ts';

const CPUS = '24-27';
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  argv.splice(i, 2);
  return v;
};
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

/** Run a child process with a hard SIGKILL timeout; resolves with stdout. */
function run(cmd: string, args: string[], timeoutMs = 60_000, inherit = false): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout?.on('data', (d: Buffer) => out.push(d));
    p.stderr?.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); rej(e); });
    p.on('close', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) res(Buffer.concat(out));
      else rej(new Error(`${cmd} exited ${code ?? sig}: ${Buffer.concat(err).toString().slice(0, 400)}`));
    });
  });
}

const allowed = /Cpus_allowed_list:\s*(\S+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
if (!flag('--no-pin') && allowed !== CPUS) {
  // Chrome and ffmpeg inherit the affinity, so the whole render runs on these 4 cores.
  await run('taskset', ['-c', CPUS, process.execPath, ...process.execArgv, process.argv[1]!, ...process.argv.slice(2), '--no-pin'], 3_600_000, true)
    .then(() => process.exit(0), (e: Error) => { console.error(e.message); process.exit(1); });
}

const outArg = opt('--out');
if (!outArg) throw new Error('--out DIR is required (frames and work files go there)');
const OUT = resolve(outArg);
const SECONDS = Number(opt('--seconds') ?? 2);
const ASPECTS = (opt('--aspects') ?? '16:9,9:16').split(',') as Aspect[];
const filters = argv;
/** Per-subject triangle budget at default detail. */
const TRI_BUDGET = 150_000;
/**
 * Draw-time target (in-page renderer.render + readPixels, median of 8), ms on 4 cores at supersample 2. Over it is a
 * warning, not a failure: on a shared machine the absolute numbers swing 2-3x, so compare with baseline-plain (a plain
 * lit scene with no kit detail, rendered in the same run).
 */
const RENDER_TARGET_MS = 60;
/** End-to-end per-frame (renderFrame + screenshot + encode) may exceed baseline-plain's by this factor before a warning. */
const FRAME_VS_BASELINE = 2.5;
/** Hard failure: the renderer aborts a shot whose frame takes over 5 s; flag anything near it. */
const FRAME_HARD_MS = 2_000;

// ---------- demo pages ----------
// Each demo is the body of an async function with these in scope: THREE, kit (all kit exports), renderer, scene,
// camera, W, H, fit(radius, target, azimuth, elevation) and turntable (a Group at the origin, already in the scene).
// It returns { subject, draw(t) } (draw moves things; the page renders after it).
interface Demo { bg: string; env?: string; code: string }
const DEMOS: Record<string, Demo> = {
  // Reference for timings: a plain lit scene without any kit detail (stock PMREM environment, untextured standard
  // materials), so kit costs can be read relative to it on a busy machine.
  'baseline-plain': {
    bg: '#cfccc6',
    env: '{ fast: false }',
    code: `
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.8), new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.4 }));
      box.position.y = 0.35;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 48, 24), new THREE.MeshStandardMaterial({ color: 0xb04030, roughness: 0.3 }));
      ball.position.set(0.85, 0.3, 0.3);
      turntable.add(box, ball);
      fit(1.0, [0, 0.32, 0], 0.5, 0.3);
      return { subject: turntable, draw: (t) => { turntable.rotation.y = t * 0.18; } };`,
  },
  // Surface detail: a displaced, curvature-tinted rock with two smoother pebbles, on a reflective ground.
  'surface-stone': {
    bg: '#cfccc6',
    env: '{ intensity: 0.75, key: 1.8, rim: 1.4 }',
    code: `
      const rock = kit.detailSurface(kit.superEllipsoid([1.3, 0.78, 1.0], { power: 2.3, segments: 72 }), 'rock', { seed: 4, size: 1.1, displace: { base: { y: -0.3, soft: 0.04 } } });
      const p1 = kit.detailSurface(kit.superEllipsoid([0.42, 0.2, 0.32], { power: 2.2, segments: 30, bottom: 0.4 }), 'stone', { seed: 9, size: 0.4 });
      const p2 = kit.detailSurface(kit.superEllipsoid([0.3, 0.16, 0.26], { power: 2.2, segments: 26, bottom: 0.4 }), 'stone', { seed: 12, size: 0.3, tint: { color: 0x7d776f } });
      for (const m of [rock, p1, p2]) { m.geometry.computeBoundingBox(); m.position.y = -m.geometry.boundingBox.min.y; turntable.add(m); }
      p1.position.set(0.95, p1.position.y, 0.35); p1.rotation.y = 0.6;
      p2.position.set(-0.85, p2.position.y, 0.5); p2.rotation.y = 2.1;
      scene.add(kit.ground(renderer, { color: 0xcfccc6, reflection: 0.15 }));
      turntable.add(kit.contactShadow(renderer, turntable, { opacity: 0.8 }));
      fit(1.0, [0, 0.32, 0], 0.5, 0.3);
      return { subject: turntable, draw: (t) => { turntable.rotation.y = t * 0.18; } };`,
  },
  // Surface detail: a scored loaf (crust recipe + grooves) on a wooden board.
  'surface-bread': {
    bg: '#2b2622',
    env: '{ intensity: 0.7, key: 1.7, rim: 1.4 }',
    code: `
      const scores = [-0.42, -0.06, 0.3].map((x) => ({ a: [x - 0.12, 0.33, -0.22], b: [x + 0.16, 0.33, 0.22], width: 0.085, depth: 0.05 }));
      const loaf = kit.detailSurface(kit.superEllipsoid([1.5, 0.64, 0.74], { power: 2.6, segments: 80, bottom: 0.7 }), 'crust', { seed: 2, displace: { grooves: scores } });
      loaf.geometry.computeBoundingBox();
      const boardGeo = kit.roundedBox(2.1, 0.07, 1.15, { radius: 0.025, segments: 4, uvTile: 1 });
      const board = new THREE.Mesh(boardGeo, kit.wood({ finish: 'oiled', repeat: [0.9, 0.9] }));
      board.position.y = 0.035;
      loaf.position.y = 0.07 - loaf.geometry.boundingBox.min.y;
      turntable.add(board, loaf);
      turntable.add(kit.contactShadow(renderer, loaf, { opacity: 0.85, y: 0.071, blur: 0.8 }));
      scene.add(kit.ground(renderer, { color: 0x2b2622, reflection: 0, glow: 0.25 }));
      turntable.add(kit.blobShadow({ radius: 1.15, scale: [1, 0.62], opacity: 0.7 }));
      fit(1.2, [0, 0.25, 0], 0.35, 0.42);
      return { subject: turntable, draw: (t) => { turntable.rotation.y = -0.25 + t * 0.12; } };`,
  },
  // Surface recipes side by side: rock, stone, bark (cylinder), crust (bun), clay (lathe pot), terrain (plane).
  'surface-recipes': {
    bg: '#d4d1cb',
    code: `
      const items = [];
      const lift = (m) => { m.geometry.computeBoundingBox(); m.position.y = -m.geometry.boundingBox.min.y; return m; };
      items.push(lift(kit.detailSurface(kit.superEllipsoid([0.7, 0.45, 0.6], { power: 2.3, segments: 48 }), 'rock', { seed: 3, size: 0.6 })));
      items.push(lift(kit.detailSurface(kit.superEllipsoid([0.6, 0.3, 0.45], { power: 2.2, segments: 32, bottom: 0.4 }), 'stone', { seed: 5, size: 0.5 })));
      const log = new THREE.CylinderGeometry(0.24, 0.27, 0.6, 96, 48);
      items.push(lift(kit.detailSurface(log, 'bark', { seed: 6, size: 0.5 })));
      items.push(lift(kit.detailSurface(kit.superEllipsoid([0.6, 0.34, 0.6], { power: 2.2, segments: 40, bottom: 0.8 }), 'crust', { seed: 7, size: 0.6 })));
      const prof = []; for (let i = 0; i <= 48; i++) { const s = i / 48; prof.push(new THREE.Vector2(0.12 + 0.17 * Math.sin(Math.PI * Math.min(1, s * 1.15)) + 0.03 * s, s * 0.55)); }
      items.push(lift(kit.detailSurface(new THREE.LatheGeometry(prof, 96), 'clay', { seed: 8, size: 0.5 })));
      const plane = new THREE.PlaneGeometry(0.75, 0.75, 128, 128).rotateX(-Math.PI / 2);
      items.push(lift(kit.detailSurface(plane, 'terrain', { seed: 9, size: 0.6 })));
      const cols = W > H ? 3 : 2, rows = Math.ceil(items.length / cols), gap = W > H ? 0.95 : 1.0;
      items.forEach((m, i) => { const c = i % cols, r = Math.floor(i / cols); m.position.x = (c - (cols - 1) / 2) * gap; m.position.z = (r - (rows - 1) / 2) * gap; turntable.add(m); });
      for (const m of items) { const s = kit.blobShadow({ radius: 0.38, opacity: 0.45 }); s.position.x = m.position.x; s.position.z = m.position.z; turntable.add(s); }
      scene.add(kit.ground(renderer, { color: 0xd4d1cb, reflection: 0 }));
      fit(W > H ? 1.25 : 1.5, [0, 0.15, 0], 0, W > H ? 0.6 : 0.75);
      return { subject: turntable, draw: (t) => { for (const m of items) m.rotation.y = 0.4 + t * 0.25; } };`,
  },
  // Hard surface: a camera body with a parting seam, panels, screws, a sagging cable with boots, a mic grille, vents and decals.
  'hard-camera': {
    bg: '#aeb2b7',
    env: '{ intensity: 0.9, key: 2.0, rim: 2.2, shadow: { radius: 1.6 } }',
    code: `
      const cam = new THREE.Group();
      const bodyMat = kit.plastic({ finish: 'textured', color: 0x2a2b2e, repeat: 3 });
      kit.seams(bodyMat, [
        { type: 'rect', center: [0.66, -0.06, 0.02], normal: [1, 0, 0], up: [0, 1, 0], size: [0.3, 0.26], radius: 0.03 },
        { type: 'rect', center: [0.15, -0.33, 0], normal: [0, -1, 0], up: [0, 0, -1], size: [0.5, 0.3], radius: 0.02 },
        { type: 'line', a: [-0.28, -0.33, 0.226], b: [-0.28, 0.25, 0.226], normal: [0, 0, 1] },
        { type: 'plane', normal: [0, 1, 0], offset: -0.2 },
        { type: 'rect', center: [0.45, 0.12, 0.226], normal: [0, 0, 1], up: [0, 1, 0], size: [0.16, 0.1], radius: 0.02 },
      ], { width: 0.005 });
      const body = new THREE.Mesh(kit.roundedBox(1.32, 0.66, 0.45, { radius: 0.06, segments: 5, uvTile: 0.5 }), bodyMat);
      const topMat = kit.metal({ finish: 'blasted', color: 'gunmetal', repeat: 2 });
      kit.seams(topMat, [{ type: 'plane', normal: [0, 1, 0], offset: 0.45 }, { type: 'rect', center: [-0.3, 0.52, 0], normal: [0, 1, 0], up: [0, 0, -1], size: [0.34, 0.26], radius: 0.04 }], { width: 0.004 });
      const top = new THREE.Mesh(kit.roundedBox(1.3, 0.2, 0.43, { radius: 0.05, segments: 5, uvTile: 0.5 }), topMat);
      top.position.y = 0.42;
      body.position.y = 0;
      const grip = new THREE.Mesh(kit.superEllipsoid([0.3, 0.72, 0.56], { power: 3, segments: 28, uvTile: 0.25 }), kit.rubber({ repeat: 2 }));
      grip.position.set(-0.53, -0.01, 0.08);
      cam.add(body, top, grip);
      // Lens: mount ring, barrel, knurled focus ring, coated front glass.
      const lens = new THREE.Group();
      const mount = new THREE.Mesh(kit.roundedCylinder(0.29, 0.05, { radial: 64, bevel: 0.01 }), kit.metal({ finish: 'polished', color: 'chrome' }));
      const barrel = new THREE.Mesh(kit.roundedCylinder(0.25, 0.42, { radial: 64, bevel: 0.02 }), kit.plastic({ finish: 'matte', color: 0x1b1c1e, repeat: [4, 1] }));
      const ring = new THREE.Mesh(kit.roundedCylinder(0.262, 0.14, { radial: 64, bevel: 0.015 }), kit.rubber({ pattern: 'knurl', repeat: [6, 1] }));
      const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.8, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 500] });
      const glassEl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 48, 16, 0, Math.PI * 2, 0, 0.6), glassMat);
      mount.position.y = 0.025; barrel.position.y = 0.26; ring.position.y = 0.28; glassEl.position.y = 0.36;
      lens.add(mount, barrel, ring, glassEl);
      const lensLabel = await kit.labelTexture({ width: 512, height: 64, background: 'transparent', padding: 8, lines: [{ text: '35mm  1:2  ∞ 0.3m', size: 40, weight: 400, color: '#e8e8e8', align: 'center' }] });
      const ll = kit.decal(lensLabel, { width: 0.5, height: 0.0625, curve: 0.2515, roughness: 0.4 });
      ll.position.y = 0.42; ll.rotation.y = 0; lens.add(ll);
      lens.rotation.x = Math.PI / 2; lens.position.set(0.12, -0.02, 0.225);
      cam.add(lens);
      cam.add(kit.bolts(kit.ringPoints({ center: [0.12, -0.02, 0.226], normal: [0, 0, 1], radius: 0.335, count: 4, phase: Math.PI / 4 }), { kind: 'pan', recess: 'phillips', radius: 0.014, color: 0x9a9a9a }));
      cam.add(kit.bolts(kit.rectPoints({ center: [0.15, -0.331, 0], normal: [0, -1, 0], up: [0, 0, -1], size: [0.56, 0.36], inset: 0 }), { kind: 'socket', radius: 0.013 }));
      cam.add(kit.bolts(kit.rectPoints({ center: [0.661, -0.06, 0.02], normal: [1, 0, 0], up: [0, 1, 0], size: [0.24, 0.2] }), { kind: 'pan', recess: 'torx', radius: 0.009, color: 0x3a3a3a }));
      // Top: shutter button, mode dial with knurled rim, hot shoe, mic grille, vent.
      const dial = new THREE.Mesh(kit.roundedCylinder(0.12, 0.07, { radial: 64, bevel: 0.012 }), kit.metal({ finish: 'radial', color: 'aluminium' }));
      dial.position.set(0.38, 0.555, 0.02);
      const dialRim = new THREE.Mesh(kit.roundedCylinder(0.123, 0.05, { radial: 64, bevel: 0.006, open: true }), kit.rubber({ pattern: 'ribs', repeat: [1, 3], color: 0x2a2a2a }));
      dialRim.material.map = null; dialRim.position.copy(dial.position);
      const btn = new THREE.Mesh(kit.roundedCylinder(0.045, 0.04, { radial: 48, bevel: 0.01 }), kit.metal({ finish: 'polished', color: 'chrome' }));
      btn.position.set(-0.5, 0.54, 0.12);
      const shoe = new THREE.Mesh(kit.roundedBox(0.2, 0.03, 0.18, { radius: 0.006, segments: 2 }), kit.metal({ finish: 'brushed', color: 'steel', repeat: 0.5 }));
      shoe.position.set(0.08, 0.535, -0.02);
      const mic = kit.grille(0.16, 0.05, { pattern: 'round', pitch: 0.009, cells: 8, radius: 0.012, frame: 0.004 });
      mic.rotation.x = -Math.PI / 2; mic.position.set(-0.2, 0.522, 0.12);
      const vent = kit.louvers(0.18, 0.12, { count: 6, angle: 0.6 });
      vent.rotation.y = -Math.PI / 2; vent.position.set(-0.661, 0.42, 0);
      cam.add(dial, dialRim, btn, shoe, mic, vent);
      const tag = await kit.labelTexture({ width: 512, height: 256, background: '#d9d9d4', radius: 18, lines: [{ text: 'USB-C · 5V 2A', size: 52 }, { text: '接口 / PORT', size: 34, weight: 400, color: '#444' }], fine: 3, barcode: true });
      const tagMesh = kit.decal(tag, { width: 0.2, roughness: 0.5 });
      tagMesh.rotation.y = Math.PI / 2; tagMesh.position.set(0.662, 0.17, 0.02);
      cam.add(tagMesh);
      // Cable out of the side port, sagging to the ground.
      const cbl = kit.cable({ from: [0.75, -0.06, 0.02], fromDir: [1, 0, 0], to: [1.5, -0.33 + 0.024, 0.8], toDir: [-0.5, 0, -1], sag: 0.35, floor: -0.33, radius: 0.022, boots: { plug: 0.08 }, seed: 3 });
      cam.add(cbl);
      cam.position.y = 0.33 + 0.01;
      turntable.add(cam);
      kit.shadowsOn(turntable);
      scene.add(kit.ground(renderer, { color: 0xaeb2b7, reflection: 0.15, radius: 5, glow: 0.08 }));
      turntable.add(kit.blobShadow({ radius: 0.85, scale: [1, 0.55], opacity: 0.55 }));
      fit(1.15, [0.2, 0.3, 0.1], 0.55, 0.28);
      return { subject: turntable, draw: (t) => { turntable.rotation.y = -0.15 + t * 0.12; } };`,
  },
  // Material presets as a grid of swatch spheres with labels, in front of a striped backdrop (glass needs something behind it).
  'materials-swatches': {
    bg: '#c9c6c0',
    code: `
      const list = [
        ['metal:brushed', kit.metal({ finish: 'brushed', repeat: [2, 1] })],
        ['metal:polished', kit.metal({ finish: 'polished', color: 'chrome' })],
        ['metal:anodised', kit.metal({ finish: 'anodised', color: 0x2f6fb0, repeat: [2, 1] })],
        ['metal:blasted', kit.metal({ finish: 'blasted', color: 'titanium', repeat: [2, 1] })],
        ['foil', kit.foil({ repeat: [2, 1] })],
        ['plastic:glossy', kit.plastic({ finish: 'glossy', color: 'red' })],
        ['plastic:matte', kit.plastic({ finish: 'matte', color: 'white', repeat: [2, 1] })],
        ['plastic:textured', kit.plastic({ finish: 'textured', color: 0x2a2b2e, repeat: [3, 1.5] })],
        ['glass:clear', kit.glass()],
        ['glass:frosted', kit.glass({ frosted: true })],
        ['fabric:twill', kit.fabric({ weave: 'twill', color: 0x2c4a7c, color2: 0xd8d8d0, repeat: [4, 2] })],
        ['fabric:ripstop', kit.fabric({ weave: 'ripstop', color: 0xd2652a, repeat: [4, 2] })],
        ['wood', kit.wood({ finish: 'lacquered', repeat: [1, 1] })],
        ['ceramic:crackle', kit.ceramic({ glaze: 'crackle', color: 0x9fc2b8, repeat: [2, 1] })],
        ['rubber:knurl', kit.rubber({ pattern: 'knurl', repeat: [3, 1.5] })],
      ];
      const cols = W > H ? 5 : 3, rows = Math.ceil(list.length / cols), gx = 0.62, gy = 0.78;
      const sphere = new THREE.SphereGeometry(0.25, 64, 32);
      const balls = [];
      for (let i = 0; i < list.length; i++) {
        const [name, mat] = list[i], c = i % cols, r = Math.floor(i / cols);
        const x = (c - (cols - 1) / 2) * gx, y = ((rows - 1) / 2 - r) * gy;
        const m = new THREE.Mesh(sphere, mat); m.position.set(x, y + 0.08, 0); scene.add(m); balls.push(m);
        const tex = await kit.labelTexture({ width: 512, height: 96, background: 'transparent', padding: 4, lines: [{ text: name, size: 64, weight: 700, color: '#2a2a2a', align: 'center' }] });
        const lab = kit.decal(tex, { width: 0.56, height: 0.105, roughness: 0.9 }); lab.position.set(x, y - 0.25, 0); scene.add(lab);
      }
      const bc = document.createElement('canvas'); bc.width = 512; bc.height = 512; const g = bc.getContext('2d');
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#d9d6d0' : '#b9b5ae'; g.fillRect(i * 32, 0, 32, 512); }
      g.fillStyle = '#2b2b2b'; for (let i = 0; i < 8; i++) g.fillRect(0, i * 64 + 30, 512, 4);
      const bt = kit.colorTexture(bc); bt.repeat.set(6, 6);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ map: bt, roughness: 0.9 }));
      back.position.z = -0.6; scene.add(back);
      const half = Math.max(cols * gx, (rows * gy) * (W / H)) / 2;
      camera.position.set(0, 0, 0); fit(Math.max(cols * gx / 2, rows * gy / 2) * 1.02, [0, 0, 0], 0, 0);
      return { subject: scene, draw: (t) => { for (const b of balls) b.rotation.y = 0.5 + t * 0.35; } };`,
  },
  // Fabric: a backpack with ripstop body, pocket, zippers (teeth along curves), webbing straps, buckle, stitching and a patch.
  'fabric-backpack': {
    bg: '#cbd0d3',
    env: '{ intensity: 0.75, key: 1.4, rim: 1.6 }',
    code: `
      const pack = new THREE.Group();
      const cloth = kit.fabric({ weave: 'ripstop', color: 0x2f5d50, threads: 32, repeat: 2.5 });
      const bodyGeo = kit.superEllipsoid([0.9, 1.25, 0.46], { power: 3.2, segments: 56, uvTile: 0.16 });
      kit.displace(bodyGeo, { seed: 3, amplitude: 0.011, scale: [3, 6, 3], octaves: 3, ridged: 0.7, warp: 0.4 });
      kit.vertexTint(bodyGeo, { cavity: { amount: 0.5 }, edge: { amount: 0.1 }, noise: { amount: 0.04 } }); cloth.vertexColors = true;
      const body = new THREE.Mesh(bodyGeo, cloth);
      const pocketGeo = kit.superEllipsoid([0.7, 0.56, 0.2], { power: 3.6, segments: 40, uvTile: 0.16 });
      kit.displace(pocketGeo, { seed: 5, amplitude: 0.006, scale: [3, 4, 3], octaves: 3, ridged: 0.5 });
      const pocketMat = kit.fabric({ weave: 'ripstop', color: 0x264c42, threads: 32, repeat: 2.5 });
      kit.vertexTint(pocketGeo, { cavity: { amount: 0.5 }, edge: { amount: 0.1 }, noise: { amount: 0.04 } }); pocketMat.vertexColors = true;
      const pocket = new THREE.Mesh(pocketGeo, pocketMat);
      pocket.position.set(0, -0.3, 0.19);
      pack.add(body, pocket);
      // Zippers: tape (strap) + alternating teeth along a curve, and a pull.
      const toothGeo = new THREE.BoxGeometry(0.009, 0.004, 0.014);
      const toothMat = kit.metal({ finish: 'polished', color: 'brass' });
      const zipPts = []; for (let i = 0; i <= 24; i++) { const a = 0.15 + (i / 24) * (Math.PI - 0.3); const c = Math.cos(a), s = Math.sin(a); const k = Math.pow(Math.pow(Math.abs(c), 3.2) + Math.pow(Math.abs(s), 3.2), -1 / 3.2) * 0.985; zipPts.push(new THREE.Vector3(c * 0.45 * k, 0.02 + s * 0.625 * k, 0.1)); }
      const zipCurve = new THREE.CatmullRomCurve3(zipPts);
      const outward = zipPts[0].clone().setZ(0).normalize().toArray();
      pack.add(kit.strap(zipCurve, { width: 0.05, thickness: 0.003, up: outward, color: 0x161616 }));
      pack.add(kit.alongCurve(zipCurve, toothGeo, toothMat, { spacing: 0.009, up: outward, alternate: 0.004, offset: [0.003, 0] }));
      const pTop = [[-0.33, -0.03, 0.29], [0, -0.012, 0.296], [0.33, -0.03, 0.29]];
      pack.add(kit.strap(pTop, { width: 0.04, thickness: 0.003, up: [0, 0.3, 1], color: 0x161616 }));
      pack.add(kit.alongCurve(pTop, toothGeo, toothMat, { spacing: 0.009, up: [0, 0.3, 1], alternate: 0.004, offset: [0.003, 0] }));
      const pull = new THREE.Mesh(kit.roundedBox(0.03, 0.07, 0.008, { radius: 0.003, segments: 2 }), toothMat);
      pull.position.set(0.12, -0.065, 0.305); pull.rotation.x = -0.2; pack.add(pull);
      // Stitching around the pocket.
      const stitch = new THREE.CapsuleGeometry(0.0016, 0.007, 2, 4).rotateZ(Math.PI / 2);
      const thread = new THREE.MeshStandardMaterial({ color: 0xc9c2a8, roughness: 0.8 });
      const sPts = []; for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; const c = Math.cos(a), s = Math.sin(a); const k = Math.pow(Math.pow(Math.abs(c), 3.6) + Math.pow(Math.abs(s), 3.6), -1 / 3.6) * 0.94; sPts.push(new THREE.Vector3(c * 0.35 * k, -0.3 + s * 0.28 * k, 0.272 + 0.02 * (1 - Math.abs(c)) * 0)); }
      pack.add(kit.alongCurve(new THREE.CatmullRomCurve3(sPts, true), stitch, thread, { spacing: 0.014, up: [0, 0, 1], offset: [0.002, 0] }));
      // Webbing: compression strap across the front, grab handle, buckle.
      const web = kit.fabric({ weave: 'twill', color: 0x1c1c1c, color2: 0x2a2a2a, threads: 48, repeat: [1, 1] });
      pack.add(kit.strap([[-0.36, 0.32, 0.19], [-0.2, 0.33, 0.224], [0, 0.335, 0.233], [0.2, 0.33, 0.224], [0.36, 0.32, 0.19]], { width: 0.05, thickness: 0.004, up: [0, 0, 1], material: web, uvTile: 0.05 }));
      pack.add(kit.strap([[-0.12, 0.6, -0.04], [-0.1, 0.7, -0.04], [0, 0.73, -0.04], [0.1, 0.7, -0.04], [0.12, 0.6, -0.04]], { width: 0.045, thickness: 0.006, up: [-1, 0, 0], material: web, uvTile: 0.05 }));
      const buckle = new THREE.Mesh(kit.roundedBox(0.09, 0.07, 0.016, { radius: 0.006, segments: 2 }), kit.plastic({ finish: 'matte', color: 0x111111 }));
      buckle.position.set(0.14, 0.333, 0.236); pack.add(buckle);
      const patch = await kit.labelTexture({ width: 512, height: 256, background: '#1d1d1d', radius: 40, border: { color: '#c9c2a8', width: 8 }, lines: [{ text: '25 L', size: 110, color: '#e8e2cc', align: 'center' }, { text: '防泼水 · WATER RESISTANT', size: 34, weight: 400, color: '#bdb6a0', align: 'center' }] });
      const pm = kit.decal(patch, { width: 0.26, roughness: 0.8 }); pm.position.set(0, -0.28, 0.297); pack.add(pm);
      pack.position.y = 0.625;
      turntable.add(pack);
      turntable.add(kit.contactShadow(renderer, pack, { opacity: 0.7 }));
      scene.add(kit.ground(renderer, { color: 0xcbd0d3, reflection: 0.12 }));
      fit(0.82, [0, 0.62, 0], 0.55, 0.18);
      return { subject: turntable, draw: (t) => { turntable.rotation.y = -0.15 + t * 0.12; } };`,
  },
};

function pageHtml(name: string, probe: boolean): string {
  const d = DEMOS[name]!;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${d.bg}}canvas{display:block;position:fixed;inset:0}
#probe{position:fixed;left:0;top:0;font:12px sans-serif;color:#fff;background:#000}</style>
<script type="importmap">{ "imports": { "three": "/vendor/three/build/three.module.js", "three/addons/": "/vendor/three/examples/jsm/" } }</script>
</head><body>${probe ? '<div id="probe"></div>' : ''}
<script type="module">
import * as THREE from 'three';
import * as kit from '/vendor/kit3d/index.js';
let draw;
window.sceneReady = (async () => {
  const W = innerWidth, H = innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 2, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('${d.bg}');
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 60);
  kit.exposeThree(renderer, scene, camera);
  kit.studioEnvironment(renderer, scene, ${d.env ?? '{}'});
  const turntable = new THREE.Group(); scene.add(turntable);
  // Frame a sphere of radius r around target in both orientations, from azimuth az / elevation el (radians).
  const fit = (r, target = [0, 0, 0], az = 0.5, el = 0.3) => {
    const v = THREE.MathUtils.degToRad(camera.fov), h = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
    const d = r / Math.sin(Math.min(v, h) / 2);
    camera.position.set(target[0] + d * Math.cos(el) * Math.sin(az), target[1] + d * Math.sin(el), target[2] + d * Math.cos(el) * Math.cos(az));
    camera.lookAt(...target);
  };
  const t0 = performance.now();
  const demo = await (async () => { ${d.code} })();
  const setupMs = performance.now() - t0;
  draw = (t) => { demo.draw(t); renderer.render(scene, camera); };
  await renderer.compileAsync(scene, camera);
  draw(0);
  ${probe ? `
  const gl = renderer.getContext(), px = new Uint8Array(4);
  const times = [];
  for (let i = 0; i < 8; i++) { const s = performance.now(); draw(i / 24); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  renderer.info.autoReset = true; draw(0);
  document.getElementById('probe').textContent = 'KITPROBE tris=' + kit.countTriangles(demo.subject) + ' drawTris=' + renderer.info.render.triangles + ' calls=' + renderer.info.render.calls + ' textures=' + renderer.info.memory.textures + ' setupMs=' + Math.round(setupMs) + ' renderMs=' + times[4].toFixed(1);` : ''}
})();
window.renderFrame = async (t) => { await window.sceneReady; draw(t); };
</script></body></html>`;
}

/** Gray thumbnails at 4 fps: min mean brightness and min standard deviation across samples. */
async function analyze(mp4: string, w: number, h: number) {
  const tw = 64, th = Math.round((64 * h) / w / 2) * 2;
  const raw = await run('ffmpeg', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', mp4, '-vf', `fps=4,scale=${tw}:${th},format=gray`, '-f', 'rawvideo', '-']);
  const n = tw * th, frames = Math.floor(raw.length / n);
  let minMean = 255, minStd = 255;
  for (let f = 0; f < frames; f++) {
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const v = raw[f * n + i]!; s += v; s2 += v * v; }
    minMean = Math.min(minMean, s / n);
    minStd = Math.min(minStd, Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)));
  }
  return { minMean, minStd, samples: frames };
}

const names = Object.keys(DEMOS).filter((n) => !filters.length || filters.some((f) => n.includes(f)));
mkdirSync(join(OUT, 'frames'), { recursive: true });
const rows: Record<string, unknown>[] = [];
const baseline: Partial<Record<Aspect, { perFrame: number; renderMs: number }>> = {};
let failed = false;
for (const name of names) {
  for (const aspect of ASPECTS) {
    const tag = `${name}_${aspect.replace(':', 'x')}`;
    const work = join(OUT, 'work', tag);
    mkdirSync(join(work, 'assets'), { recursive: true });
    const render = async (html: string, seconds: number, outPath: string) => {
      const t0 = performance.now();
      const r = await renderScene({ html, seconds, aspect, workspaceDir: work, scenePath: join(work, 'scene.html'), outPath, supersample: 2 });
      return { ms: performance.now() - t0, ...r };
    };
    try {
      // One-frame probe render: fixed cost, plus the page's own triangle count and in-page draw time.
      const one = await render(pageHtml(name, true), 1 / config.fps, join(work, 'one.mp4'));
      const probe = Object.fromEntries([...(one.text.match(/KITPROBE (.*)/)?.[1] ?? '').matchAll(/(\w+)=([\d.]+)/g)].map((m) => [m[1]!, Number(m[2])]));
      const mp4 = join(OUT, `${tag}.mp4`);
      const full = await render(pageHtml(name, false), SECONDS, mp4);
      const frames = Math.round(SECONDS * config.fps);
      const perFrame = (full.ms - one.ms) / (frames - 1);
      const { width, height } = FRAME_SIZE[aspect];
      const a = await analyze(mp4, width, height);
      const framePaths: string[] = [];
      for (const at of [0, SECONDS - 0.1]) {
        const p = join(OUT, 'frames', `${tag}_t${at.toFixed(1)}.png`);
        await run('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-ss', at.toFixed(2), '-i', mp4, '-frames:v', '1', p]);
        framePaths.push(p);
      }
      const errors = [...new Set([...one.consoleErrors, ...full.consoleErrors])];
      const problems: string[] = [];
      if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
      if (a.minStd < 4 || a.minMean < 3) problems.push(`blank-looking frame (mean ${a.minMean.toFixed(1)}, std ${a.minStd.toFixed(1)})`);
      if (!(probe.tris! > 0)) problems.push('probe missing (page did not finish setup?)');
      if (probe.tris! > TRI_BUDGET) problems.push(`triangles ${probe.tris} > ${TRI_BUDGET}`);
      if (perFrame > FRAME_HARD_MS) problems.push(`per-frame ${perFrame.toFixed(0)} ms > ${FRAME_HARD_MS}`);
      const warnings: string[] = [];
      if (name === 'baseline-plain') baseline[aspect] = { perFrame, renderMs: probe.renderMs! };
      if (probe.renderMs! > RENDER_TARGET_MS) warnings.push(`draw ${probe.renderMs} ms > target ${RENDER_TARGET_MS}`);
      const base = baseline[aspect];
      if (base && name !== 'baseline-plain' && perFrame > base.perFrame * FRAME_VS_BASELINE) warnings.push(`per-frame ${perFrame.toFixed(0)} ms > ${FRAME_VS_BASELINE}x baseline ${base.perFrame.toFixed(0)}`);
      const row = {
        demo: tag, tris: probe.tris, drawTris: full.complexity?.triangles ?? probe.drawTris, calls: probe.calls, textures: probe.textures,
        setupMs: probe.setupMs, renderMs: probe.renderMs, renderVsBase: base ? +(probe.renderMs! / base.renderMs).toFixed(2) : undefined,
        perFrameMs: Math.round(perFrame), fixedMs: Math.round(one.ms),
        minMean: +a.minMean.toFixed(1), minStd: +a.minStd.toFixed(1), ok: problems.length === 0, problems, warnings, frames: framePaths,
      };
      if (problems.length) failed = true;
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (e) {
      failed = true;
      rows.push({ demo: tag, ok: false, problems: [(e as Error).message] });
      console.log(`FAIL ${tag}: ${(e as Error).message}`);
    }
  }
}
await closeBrowser();
writeFileSync(join(OUT, 'kit-results.json'), JSON.stringify(rows, null, 2));
console.table(rows.map(({ frames: _f, problems, warnings, ...r }) => ({ ...r, problems: (problems as string[]).join('; ').slice(0, 60), warnings: ((warnings as string[] | undefined) ?? []).join('; ').slice(0, 60) })));
process.exit(failed ? 1 : 0);
