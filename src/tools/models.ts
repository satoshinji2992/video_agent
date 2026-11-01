// find_model and use_model: free 3D models from model libraries, checked for brands before use.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../core/config.ts';
import { fetchModel, modelFetch, modelTextures, searchModels, type ModelCandidate } from '../render/models.ts';
import { askStructured } from '../providers/llm.ts';
import { renderScene } from '../render/renderer.ts';
import { ledger, pricing } from '../core/ledger.ts';
import { ffmpeg } from '../core/ffmpeg.ts';
import { hashInputs } from '../media/project.ts';
import { join } from 'node:path';
import { type Ctx, fail, footageSheet, imageBlock, safe, text } from './shared.ts';

/**
 * A still of a downloaded model from four sides (front, side, back, above) under studio light, rendered by the
 * scene renderer itself, so the agent sees what it got and which way it faces before building a shot on it.
 */
async function modelPreview(projectDir: string, file: string, out: string): Promise<string | null> {
  if (existsSync(out)) return out;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#20242c;overflow:hidden}</style>
<script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}</script></head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio); renderer.setSize(W, H); renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#2a2f38');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight('#ffffff', 2); sun.position.set(3, 5, 4); scene.add(sun);
const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
window.__three = { renderer, scene };
window.sceneReady = loader.loadAsync('/assets/${file}').then((g) => { scene.add(g.scene); });
const views = [[0, 0.3, 2.6], [2.6, 0.3, 0], [0, 0.3, -2.6], [0.01, 2.8, 0.01]];
window.renderFrame = () => {
  views.forEach((p, i) => {
    const x = (i % 2) * W / 2, y = (1 - Math.floor(i / 2)) * H / 2;
    const cam = new THREE.PerspectiveCamera(35, (W / 2) / (H / 2), 0.01, 100);
    cam.position.set(...p); cam.lookAt(0, 0, 0);
    renderer.setViewport(x, y, W / 2, H / 2); renderer.setScissor(x, y, W / 2, H / 2); renderer.render(scene, cam);
  });
};
</script></body></html>`;
  try {
    const clip = `${out}.mp4`;
    await renderScene({ html, seconds: 1 / config.fps, aspect: '16:9', workspaceDir: projectDir, scenePath: `${out}.html`, outPath: clip, supersample: 1 });
    await ffmpeg(['-i', clip, '-frames:v', '1', out]);
    await rm(clip, { force: true });
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Brand lettering or logos printed on a downloaded model, read off its largest colour textures (scaled to
 * 1024 px) by Claude: the words seen, or '' when none is legible. Library metadata rarely says, and a lens
 * ring's lettering only shows on the texture itself. Returns the cost too.
 */
async function brandMarks(glb: string, tmpDir: string): Promise<{ marks: string; costUsd: number }> {
  const tex = await modelTextures(glb, 3).catch(() => []);
  const images: Array<{ mime: 'image/jpeg'; data: Buffer }> = [];
  for (const [i, t] of tex.entries()) {
    const src = join(tmpDir, `.brand-${i}.${t.mime === 'image/png' ? 'png' : 'jpg'}`);
    const small = join(tmpDir, `.brand-${i}.small.jpg`);
    try {
      await writeFile(src, t.data);
      await ffmpeg(['-i', src, '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', '-q:v', '3', small]);
      images.push({ mime: 'image/jpeg', data: await readFile(small) });
    } catch {
      // an unreadable texture is skipped
    } finally {
      await rm(src, { force: true });
      await rm(small, { force: true });
    }
  }
  if (!images.length) return { marks: '', costUsd: 0 };
  const { data, costUsd } = await askStructured<{ brand: boolean; marks: string }>({
    model: config.review.model,
    system: '你在检查一个三维模型的贴图（展开的平面图），看上面有没有印着真实品牌的字样、商标或标志（相机镜头圈上的字、铭牌、瓶身或包装上的牌子、logo 印记）。只算清楚可辨的；型号数字、刻度、无意义的花纹不算。只输出要求的 JSON。',
    text: '这些贴图上有可辨认的真实品牌字样或标志吗？有的话在 marks 里写出看到的字样（用顿号分隔），没有就留空。',
    images,
    schema: { type: 'object', properties: { brand: { type: 'boolean' }, marks: { type: 'string' } }, required: ['brand', 'marks'] },
  });
  return { marks: data.brand ? (data.marks.trim() || '品牌标志') : '', costUsd };
}

export function modelTools(ctx: Ctx) {
  /** Candidates from find_model in this conversation, under short handles (g1, g2, …). */
  const modelSeen = new Map<string, ModelCandidate>();
  let modelCount = 0;

  const findModel = tool(
    'find_model',
    'Search ready-made 3D models (glTF) for 3d shots, before building a real-world object procedurally: Poly Haven (CC0 everyday objects: furniture, tools, food, plants, props), NASA 3D Resources and NASA SVS (spacecraft, rovers, telescopes, planets and moons; a few are the measured shape of one real body). Returns numbered candidates (g1, g2, …) with what each depicts, whether it is a measured real shape, triangles and licence, plus a thumbnail sheet; fetch the ones you want with use_model.',
    {
      query: z.string().describe('What to find, in English, e.g. "office chair", "potted plant", "Perseverance rover", "space telescope".'),
      sources: z.array(z.enum(['polyhaven', 'nasa3d', 'svs'])).optional().describe('Default all.'),
    },
    safe(async ({ query, sources }) => {
      const found = await searchModels(query, { limit: 8, sources });
      if (!found.length) return { content: [text(`没有找到"${query}"的现成模型。换个说法（英文、更通用的名称）再搜，或者在 3d 镜头里用 kit 的细节手段自己建。`)] };
      const handles = found.map((c) => {
        const known = [...modelSeen].find(([, x]) => x.id === c.id)?.[0];
        const h = known ?? `g${++modelCount}`;
        modelSeen.set(h, c);
        return h;
      });
      const sheet = await footageSheet(found, ctx.store.path('shots', `models-${hashInputs(query, sources)}.png`), (url) => modelFetch(url, { signal: AbortSignal.timeout(15_000) }));
      const list = found.map((c, i) => `${i + 1}. ${handles[i]} ${c.title}：${c.depicts}${c.realShape ? '（实测形状）' : '（通用模型）'}${c.branded ? '（带品牌字样）' : ''}${c.triangles ? `，约 ${c.triangles} 面` : ''} — ${c.credit}，${c.license}`).join('\n');
      return { content: [text(`找到 ${found.length} 个模型（缩略图按编号排列）：\n${list}\n\n挑合适的，把编号（比如 g2）交给 use_model 取下来。通用模型只是"长得像"，成片里会标"三维示意"；只有标了实测形状的，才能说就是那个真实物体，而且只能当它本身用。标了带品牌字样的排在后面，做广告和通用展示时不要选。`), ...(sheet ? [await imageBlock(sheet)] : [])] };
    }),
  );

  const useModel = tool(
    'use_model',
    'Download 3D models found with find_model into assets/, made light enough for rendering without a GPU (simplified to at most max_triangles, textures at most 2048 px, centred and scaled to fit a unit sphere), each recorded with its source, licence and credit so 3d shots using it get a corner label and the credits card. Returns each file with its triangle count and real size, and a preview from four sides. Load it in a 3d shot page with GLTFLoader from /assets/<file>.',
    {
      ids: z.array(z.string()).min(1).max(4).describe('Handles from find_model results, like "g2".'),
      max_triangles: z.number().int().min(5_000).max(300_000).optional().describe('Triangle budget per model (default 150000).'),
    },
    safe(async ({ ids, max_triangles }) => {
      const unknown = ids.filter((h) => !modelSeen.has(h.trim()));
      if (unknown.length) return fail(`这些编号不是这次对话里 find_model 找到的：${unknown.join('、')}。先搜，再从结果里挑（填 g1 这样的编号）。`);
      await mkdir(ctx.store.path('assets'), { recursive: true });
      const got: string[] = [];
      const previews = [];
      for (const h of ids) {
        const c = modelSeen.get(h.trim())!;
        try {
          const r = await fetchModel(c.id, ctx.store.path('assets'), { maxTriangles: max_triangles ?? 150_000 });
          const size = r.sizeMetres ? `，原尺寸约 ${r.sizeMetres.map((x) => x.toFixed(2)).join(' × ')} 米` : '';
          got.push(`assets/${r.file}（${c.title}：${c.depicts}，${c.realShape ? '实测形状' : '通用模型，成片里标"三维示意"'}；${r.triangles} 面、${r.textures} 张贴图${size}；${c.credit}，${c.license}）`);
          const pv = await modelPreview(ctx.store.dir, r.file, ctx.store.path('shots', `${r.file}.preview.png`));
          if (pv) previews.push(await imageBlock(pv));
          // Someone else's brand on the model: not a stand-in for an ad or a generic product shot.
          const seen = await brandMarks(ctx.store.path('assets', r.file), ctx.store.path('shots')).catch(() => ({ marks: '', costUsd: 0 }));
          if (pricing.claudeBilled && seen.costUsd > 0) ledger.record({ session: ctx.sessionId, item: '模型品牌检查', model: config.review.model, usage: r.file, usd: seen.costUsd, basis: 'estimate' });
          if (seen.marks || c.branded) {
            got.push(`  注意：这个模型上有真实品牌的字样或标志${seen.marks ? `（${seen.marks}）` : ''}。做广告或通用展示时默认不要用它，先换一个 find_model 的结果；实在只有它能用，就把带字的部件转到背面、不给特写，或者在页面里把那块贴图换掉（traverse 找到对应材质，把 map 换成纯色或自己画的标签），并主动告诉用户。`);
          }
        } catch (e) {
          got.push(`${h} 没取到：${(e as Error).message}`);
        }
      }
      return { content: [text(`模型：\n${got.join('\n')}\n\n下面是每个模型前、侧、后、上四个方向的预览。在 3d 镜头的页面里这样加载：import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'，new GLTFLoader().loadAsync('/assets/文件名')，放进 window.sceneReady；模型已经居中、缩放到半径 1 以内，按需要再缩放、旋转摆正。用了模型的 3d 镜头角标和片尾署名会自动加上。现成模型可能带着真实品牌的字样或标志（镜头圈、铭牌、标签）：看预览，有的话做通用展示或用户自己的产品时，不要给带字样的部位特写，或者换一个模型，并跟用户说一声。`), ...previews.slice(0, 4)] };
    }),
  );
  return { findModel, useModel };
}
