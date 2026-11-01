// render_code_shot: HTML/canvas/three.js shots rendered frame by frame.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { pictureChange, stillness } from '../media/stillness.ts';
import { renderScene } from '../render/renderer.ts';
import { contactSheet, edgeFlash } from '../core/ffmpeg.ts';
import { hashInputs, isCodeKind, type Shot } from '../media/project.ts';
import { createLimiter } from '../core/limiter.ts';
import { type Notes } from './notes.ts';
import { attachClip, type Ctx, fail, imageBlock, safe, setShot, text } from './shared.ts';

/** 3D (WebGL) shots at once; they share one SwiftShader GPU process and slow each other down. */
const threeLimit = createLimiter(Number(process.env.RENDER_3D_CONCURRENCY ?? 1));

export function codeShotTools(ctx: Ctx, { hookNote, detailNote }: Notes) {
  const renderCodeShot = tool(
    'render_code_shot',
    'Render one code-animation shot from a complete HTML document. Work shot by shot: design and write only this shot, call this tool, and think about the next shot while it renders; never design every shot\'s HTML before calling it for the first one. The page must define window.renderFrame(t), a deterministic function that draws the frame at t seconds (0 <= t < shot length); it is called once per frame at 24 fps, so drive every animation from t (no timers, requestAnimationFrame or CSS animations). Returns a contact sheet of frames so you can check the result.',
    {
      shot_id: z.string(),
      html: z.string().describe('Full HTML document sized exactly to the frame; inline CSS/JS only; no network resources; uploaded files are at assets/<name>; the user\'s uploaded pictures (a logo, a menu, a photo) by media id at /media/<id>, e.g. <img src="/media/m18"> — always use the real logo this way, never redraw it. A logo with its own background colour (not transparent) shows as a box on a different card: make the card that same colour, or on a light card blend it with mix-blend-mode: multiply. Exception for 3d shots: three.js r186 is served locally, import it through an importmap {"three": "/vendor/three/build/three.module.js", "three/addons/": "/vendor/three/examples/jsm/"} (see the video-3d skill templates). A page may set window.sceneReady to a Promise (fonts, compileAsync) that is awaited before the first frame.'),
    },
    safe(async ({ shot_id, html }) => {
      let s: Shot;
      try { s = ctx.store.shot(shot_id); } catch (e) { return fail((e as Error).message); }
      if (!isCodeKind(s.kind)) return fail(`镜头 ${shot_id} 的类型是 ${s.kind}，不是 code 或 3d。要换类型先用 save_plan 改计划。`);
      const p = ctx.store.project;
      const inputHash = hashInputs('code', html, s.seconds, p.aspect);
      const clip = ctx.store.path(`clips/${inputHash}.mp4`);
      let consoleErrors: string[] = [];
      if (!existsSync(clip)) {
        setShot(ctx, s, { status: 'working', error: undefined });
        try {
          // WebGL pages share one software GPU process, so 3D shots are rendered a few at a time.
          const render = () => renderScene({
            html, seconds: s.seconds, aspect: p.aspect, workspaceDir: ctx.store.dir,
            scenePath: ctx.store.path(`shots/${inputHash}.html`), outPath: clip,
            ...(s.kind === '3d' ? { supersample: 2 } : {}),
          });
          const r = await (s.kind === '3d' ? threeLimit(render) : render());
          consoleErrors = r.consoleErrors;
          // What the shot writes on screen, so subtitles do not repeat it (see buildAss).
          await writeFile(ctx.store.path(`clips/${inputHash}.text.txt`), r.text);
          if (s.kind === '3d') await writeFile(ctx.store.path(`clips/${inputHash}.complexity.json`), JSON.stringify({ complexity: r.complexity ?? null, supersample: r.supersample ?? 1 }));
        } catch (e) {
          setShot(ctx, s, { status: 'failed', error: '渲染失败' });
          await ctx.store.save();
          return fail(`渲染失败：${(e as Error).message}`);
        }
      }
      await attachClip(ctx, s, inputHash);
      const sheet = ctx.store.path(`clips/${inputHash}.sheet.png`);
      if (!existsSync(sheet)) await contactSheet(clip, sheet);
      // A colour wipe painted into the shot's own first or last frames flashes for a frame when cut in.
      const flash = edgeFlash(clip);
      const ends = [flash.start ? '第一帧' : '', flash.end ? '最后一帧' : ''].filter(Boolean).join('和');
      const flashNote = ends
        ? `注意：这个镜头的${ends}几乎是一整屏纯色，两帧之内就变成画面，切进切出时会闪一下。把画面从第 0 帧起就画出来（最后一帧也是画面），不要在镜头里自己画擦屏或色块转场；${s.role === 'broll' || s.role === 'pip' ? '进出效果用 save_plan 里这个镜头的 enter / exit' : '镜头之间的切换用 save_plan 里的 transition'}，改好后重新渲染。`
        : '';
      // A card that animates in and then holds reads as a slide, not a film: frozen stretches are flagged. So
      // is a shot where only thin lines and small dots move on a dark ground: the picture as a whole barely
      // changes, and on a phone that is a still image.
      const still = await stillness(clip).catch(() => null);
      const change = await pictureChange(clip).catch(() => null);
      const stillNote = still && (still.stillShare > 0.5 || still.longestStill >= 2.5)
        ? `这个镜头入场之后基本定住了（约 ${Math.round(still.stillShare * 100)}% 的时间画面不动，最长连续 ${still.longestStill.toFixed(1)} 秒），看起来像一页 PPT。让画面一直有轻微的运动：整体缓慢推近或平移、背景和光效漂移、元素轻轻浮动或呼吸，数字和图表可以持续增长；落版也一样。改好后重新渲染。用户明确要的定格画面不用改。`
        : change && change.frozenShare > 0.5
          ? `这个镜头里动的只是细线、小点或小字，整个画面看上去几乎不动（约 ${Math.round(change.frozenShare * 100)}% 的时间整帧没有明显变化），在手机上就像一张静止的图。让大面积的东西动起来：主体和文字放大到占画面三分之一以上，把所有元素放进一个容器整体持续推近或平移（每秒约 2%），背景用有亮度和纹理的东西（真实影像、星空、光斑）并让它缓慢漂移；改好后重新渲染。用户明确要的定格画面不用改。`
          : '';
      const hook = await hookNote(s, clip);
      const detail = s.kind === '3d' ? detailNote(inputHash) : '';
      return {
        content: [
          text(`镜头 ${shot_id} 渲染完成（${s.seconds} 秒）。下面是按时间顺序抽的 6 帧，检查有没有文字被裁切、重叠、空白帧或看不清的地方。用户界面已经自动显示了这个镜头和整体进度，不要发消息汇报进度，直接继续。` +
            flashNote + stillNote + hook + detail + (consoleErrors.length ? `页面报错：${consoleErrors.slice(0, 3).join(' | ')}` : '')),
          await imageBlock(sheet),
        ],
      };
    }),
  );
  return { renderCodeShot };
}
