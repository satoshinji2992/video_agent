// Notes the studio adds to a finished shot's result: a dark opening hook, a toy-like 3D scene, a frozen picture.
import { existsSync, readFileSync } from 'node:fs';
import { pictureChange } from '../media/stillness.ts';
import { type SceneComplexity } from '../render/renderer.ts';
import { isMain, type Shot } from '../media/project.ts';
import { openingLight } from '../media/selfcheck.ts';
import { type Ctx } from './shared.ts';



export function createNotes(ctx: Ctx) {
  /**
   * The opening shot is the hook: a dark picture, or a subject that is a speck in the dark, loses the viewer
   * before the first word. Measured on the rendered clip; '' when the shot is not the opening one or is lit.
   */
  const hookNote = async (s: Shot, clip: string) => {
    if (ctx.store.project.shots.find(isMain)?.id !== s.id) return '';
    const light = await openingLight(clip);
    if (!light || light.lit >= 0.05 || light.mean >= 45) return '';
    return `这是开头的钩子镜头，可画面很暗（平均亮度 ${Math.round(light.mean)}/255，亮的部分只占 ${Math.round(light.lit * 100)}%），手机上一划就过去了。把主体提亮、放大：推近主体、换一段主体更大更亮的画面，或者在画面上加醒目的大字；背景可以暗，主体要亮。`;
  };
  /**
   * How detailed a 3D shot's scene is, from the counts the renderer read off window.__three: a subject of a
   * few thousand plain-coloured triangles reads as a toy. Pages that do not expose the scene are told so.
   */
  const detailNote = (hash: string) => {
    const f = ctx.store.path(`clips/${hash}.complexity.json`);
    if (!existsSync(f)) return '';
    let info: { complexity: SceneComplexity | null; supersample: number };
    try { info = JSON.parse(readFileSync(f, 'utf8')); } catch { return ''; }
    const c = info.complexity;
    if (!c) return '这个 3D 页面没有挂 window.__three = { renderer, scene }，无法统计面数和贴图，看不出主体够不够精细。在 sceneReady 里加上这一句再渲染。';
    // The environment map and render targets alone count as a few textures.
    const plain = c.meshes > 0 && c.plainMeshes / c.meshes > 0.6;
    const thin = c.triangles < 20_000 || c.maxMeshTriangles < 5_000;
    const sum = `场景约 ${c.triangles} 个三角面、${c.meshes} 个网格（最大的 ${c.maxMeshTriangles} 面），${c.textures} 张贴图，${c.plainMeshes} 个网格是没有贴图的纯色材质`;
    const slow = info.supersample < 2 ? '这一镜头太重，没有用 2 倍超采样，边缘会粗一些；能减的面和贴图减一减。' : '';
    return thin || plain
      ? `${sum}，主体太简单，看起来像玩具。现实里有的东西先用 find_model 找现成模型（use_model 下载后用 GLTFLoader 加载）；找不到就用 /vendor/kit3d/ 的细节手段给主体加细节：表面位移和法线贴图、倒角、接缝、螺栓、线缆、材质预设。${slow}`
      : `${sum}。${slow}`;
  };
  /** The downloaded model a 3D shot's page loads (assets/md-….glb), for its corner label and the credits. */
  const modelIn = (s: Shot) => {
    const page = s.inputHash ? ctx.store.path(`shots/${s.inputHash}.html`) : '';
    if (!page || !existsSync(page)) return undefined;
    return /md-[A-Za-z0-9_-]+\.glb/.exec(readFileSync(page, 'utf8'))?.[0];
  };
  /** A footage or image shot whose picture barely changes even with its camera move: too dark or too empty. */
  const frozenNote = async (clip: string, what: string) => {
    const change = await pictureChange(clip).catch(() => null);
    return change && change.frozenShare > 0.5
      ? `${what}做成镜头后画面几乎看不出在动（约 ${Math.round(change.frozenShare * 100)}% 的时间整帧没有明显变化），多半是太暗或太空。换一段更亮、主体更大的，或者把这个镜头缩短。`
      : '';
  };
  return { hookNote, detailNote, modelIn, frozenNote };
}
export type Notes = ReturnType<typeof createNotes>;
