// generate_image and render_image_shot.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config, FRAME_SIZE } from '../core/config.ts';
import { readIndex } from '../media/ingest.ts';
import { readManifest } from '../media/footage.ts';
import { detectBars, scanFrames, type FrameIssue } from '../media/framecheck.ts';
import { ledger } from '../core/ledger.ts';
import { ffmpeg } from '../core/ffmpeg.ts';
import { hashInputs, type Shot } from '../media/project.ts';
import { kenBurns, type KenBurnsMove } from '../media/compose.ts';
import { generateImages, type ImageModel, type ImageRef, type ImageShape } from '../providers/images.ts';
import { type Notes } from './notes.ts';
import { attachClip, type Ctx, fail, ffmpegPreview, fileUrl, imageBlock, safe, setShot, text } from './shared.ts';

/**
 * A picture placed whole in a frame-sized canvas: graphics (a logo) on their own corner colour (white when
 * transparent), photos on a blurred, darkened copy of themselves. Then the camera move runs on that.
 */
async function containStill(src: string, out: string, size: { width: number; height: number }, graphic: boolean): Promise<string> {
  if (existsSync(out)) return out;
  const { width: W, height: H } = size;
  const fg = `scale=${Math.round(W * 0.82)}:${Math.round(H * 0.82)}:force_original_aspect_ratio=decrease`;
  if (graphic) {
    // The colour at the top-left corner, composited over white (a transparent corner reads as white).
    const corner = cornerColour(src);
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', src, '-f', 'lavfi', '-i', `color=c=${await corner}:s=${W}x${H}`, '-filter_complex', `[0:v]${fg}[f];[1:v][f]overlay=(W-w)/2:(H-h)/2:format=auto`, '-frames:v', '1', out]);
  } else {
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', src, '-filter_complex', `[0:v]split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.12[bg];[b]${fg}[f];[bg][f]overlay=(W-w)/2:(H-h)/2`, '-frames:v', '1', out]);
  }
  return out;
}

/** The top-left pixel of an image flattened onto white, as 0xRRGGBB. */
async function cornerColour(src: string): Promise<string> {
  const tmp = `${src}.corner.rgb`;
  try {
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', src, '-f', 'lavfi', '-i', 'color=c=white:s=8x8', '-filter_complex', '[0:v]crop=8:8:0:0[c];[1:v][c]overlay=format=auto,scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', tmp]);
    const b = readFileSync(tmp);
    return `0x${[b[0], b[1], b[2]].map((x) => (x ?? 255).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return 'white';
  } finally {
    await rm(tmp, { force: true });
  }
}

export function imageTools(ctx: Ctx, { hookNote, frozenNote }: Notes) {
  const renderImageShot = tool(
    'render_image_shot',
    'Turn an image shot (kind image) into a clip: the still from assets/ with a smooth camera move. Takes a few seconds.',
    { shot_id: z.string(), image: z.string().optional().describe('Override the plan\'s image (file in assets/).'), move: z.enum(['in', 'out', 'left', 'right', 'up', 'down']).optional() },
    safe(async ({ shot_id, image, move }) => {
      let s: Shot;
      try { s = ctx.store.shot(shot_id); } catch (e) { return fail((e as Error).message); }
      if (s.kind !== 'image') return fail(`镜头 ${shot_id} 的类型是 ${s.kind}，不是 image。`);
      const name = image ?? s.image ?? '';
      // A photo the user uploaded is named by its media id; its ingest proxy is the still.
      const media = /^m\d+$/.test(name) ? readIndex(ctx.store.dir).find((m) => m.id === name && m.kind === 'image' && m.proxy) : undefined;
      const file = media ? media.id : basename(name);
      const src = media ? ctx.store.path(media.proxy!) : ctx.store.path('assets', file);
      if (!file || !existsSync(src)) return fail(`找不到图片 ${media ? name : `assets/${file}`}`);
      const p = ctx.store.project;
      const mv = (move ?? s.move ?? 'in') as KenBurnsMove;
      // Graphics (a logo, a menu) are shown whole; photos fill the frame.
      const graphic = /\.(png|gif)$/i.test(media ? media.file : file);
      const fit = s.fit ?? (media && graphic ? 'contain' : 'cover');
      // Archive stills sometimes come padded with black (a square frame on a 16:9 canvas): that is cut away.
      // Only archive files: a logo on black is a picture, not bars.
      const archive = !media && readManifest(ctx.store.dir).some((m) => m.file === file);
      const inputHash = hashInputs('image', readFileSync(src).length, file, mv, s.seconds, p.aspect, fit, ...(archive ? ['bars'] : []));
      const clip = ctx.store.path(`clips/${inputHash}.mp4`);
      let cropped = false;
      if (!existsSync(clip)) {
        setShot(ctx, s, { status: 'working', error: undefined });
        const bars = archive ? await detectBars(src).catch(() => null) : null;
        let base = src;
        if (bars) {
          base = ctx.store.path(`clips/${inputHash}.crop.png`);
          await ffmpeg(['-i', src, '-vf', `crop=${bars.w}:${bars.h}:${bars.x}:${bars.y}`, '-frames:v', '1', base]);
          cropped = true;
        }
        const still = fit === 'contain' ? await containStill(media ? ctx.store.path(media.file) : base, ctx.store.path(`clips/${inputHash}.still.png`), FRAME_SIZE[p.aspect], graphic) : base;
        await kenBurns(still, clip, s.seconds, { ...FRAME_SIZE[p.aspect], fps: config.fps }, mv);
        if (bars) await rm(base, { force: true });
      }
      s.image = file;
      s.move = mv;
      await attachClip(ctx, s, inputHash);
      const broken = archive ? (await scanFrames(clip).catch(() => [] as FrameIssue[])).filter((i) => i.kind === 'flat-block' && !i.card) : [];
      const hook = await hookNote(s, clip);
      // The user's own pictures (a logo, a menu) are theirs to choose; only archive and generated stills are judged.
      const frozen = media ? '' : await frozenNote(clip, '这张图');
      return { content: [text(`镜头 ${shot_id} 已用 assets/${file} 做成 ${s.seconds} 秒的镜头（${mv}${cropped ? '，图上自带的黑边已裁掉' : ''}）。` + frozen +
        (broken.length ? `注意，这张图像是坏画面：${broken.map((i) => i.detail).join('；')}，换一张图。` : '') + hook)] };
    }),
  );

  const generateImage = tool(
    'generate_image',
    'Make still images: ad images, posters, video covers, a presenter or product look image to pass to realistic shots as reference_assets (keeps them consistent), or pictures to use as image shots. Takes ~20-30 s. The user sees the images in the chat right away (downloadable). Files land in assets/ and are listed in the result. gpt-image-2 (default) is best for ads and posters and renders Chinese headlines accurately; seedream is more photographic.',
    {
      prompt: z.string().describe('What the image shows; for posters include the exact headline text in quotes and its placement.'),
      shape: z.enum(['portrait', 'landscape', 'square']).describe('portrait for 9:16 videos and phone posters, landscape for 16:9, square for 1:1 feeds.'),
      count: z.number().int().min(1).max(4).optional().describe('How many variations, default 1.'),
      model: z.enum(['gpt-image-2', 'seedream']).optional(),
      reference_images: z.array(z.string()).max(4).optional().describe('Image files in assets/ (uploads, earlier generate_image results), or "shot:<id>" for a frame from a finished shot, that the new image must follow: the same presenter\'s face and clothes, the same product. Use it whenever a poster or cover shows a person or product that already appears in the video; describe in the prompt what to keep and what changes.'),
    },
    safe(async ({ prompt, shape, count, model, reference_images }) => {
      const stem = `img-${Date.now().toString(36)}`;
      await mkdir(ctx.store.path('assets'), { recursive: true });
      const refs: ImageRef[] = [];
      for (const name of reference_images ?? []) {
        let f = ctx.store.path('assets', basename(name));
        if (name.startsWith('shot:')) {
          const s = ctx.store.project.shots.find((x) => x.id === name.slice(5));
          if (!s?.clipFile || !existsSync(ctx.store.path(s.clipFile))) return fail(`镜头 ${name.slice(5)} 还没有成片，不能当参考图`);
          f = ctx.store.path('assets', `frame-${s.inputHash ?? s.id}.jpg`);
          if (!existsSync(f)) await ffmpeg(['-ss', String(Math.min(1, s.seconds / 2)), '-i', ctx.store.path(s.clipFile), '-frames:v', '1', '-q:v', '2', f]);
        }
        if (!existsSync(f)) return fail(`找不到参考图 ${name}`);
        const ext = extname(f).slice(1).toLowerCase();
        const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : '';
        if (!type) return fail(`参考图只支持 png、jpg、webp：${name}`);
        if (statSync(f).size > 10 * 1024 * 1024) return fail(`参考图超过 10 MB：${name}`);
        refs.push({ bytes: await readFile(f), type });
      }
      const r = await generateImages({ prompt, shape: shape as ImageShape, model: model as ImageModel | undefined, n: count ?? 1, refs }, ctx.store.path('assets'), stem);
      if (!r.mock && r.usd > 0) {
        const warning = ledger.record({ session: ctx.sessionId, item: `出图 × ${r.files.length}`, model: r.model, usage: r.usage, usd: r.usd, basis: r.basis });
        if (warning) ctx.emit({ type: 'toast', level: 'warn', text: warning });
      }
      const names = r.files.map((f) => basename(f.path));
      ctx.emit({ type: 'images', files: names.map((n, i) => ({ url: fileUrl(ctx, `assets/${n}`), name: n, width: r.files[i]!.width, height: r.files[i]!.height })), prompt, model: r.model });
      // Small previews are enough for the model to judge them, and much cheaper than the originals.
      const previews = [];
      for (const f of r.files) {
        const prev = ctx.store.path(`assets/.preview-${basename(f.path)}.png`);
        await ffmpegPreview(f.path, prev);
        previews.push(await imageBlock(prev));
      }
      return { content: [text(`已生成 ${names.length} 张图（${r.model}${r.mock ? '，示意图片' : ''}），用户已经在对话里看到并可以下载：${names.map((n) => `assets/${n}`).join('、')}。可以把它们放进写实镜头的 reference_assets 保持人物或产品一致（某个镜头需要特定开头画面时才当 first_frame），当 image 镜头（render_image_shot），或者当封面。下面是缩略图，看看有没有问题。`), ...previews] };
    }),
  );
  return { renderImageShot, generateImage };
}
