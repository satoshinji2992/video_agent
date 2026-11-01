// Archive footage: find_footage, use_footage, preview_footage and render_footage_shot.
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config, FRAME_SIZE } from '../core/config.ts';
import { fetchFootage, recordManifest, searchFootage, type FootageCandidate } from '../media/footage.ts';
import { detectBars, scanFrames, type FrameIssue } from '../media/framecheck.ts';
import { pictureChange, stillness } from '../media/stillness.ts';
import { CJK_FONT_FILE, ffmpeg, normalizeClip, probeDuration } from '../core/ffmpeg.ts';
import { hashInputs, type Shot } from '../media/project.ts';
import { slowPush } from '../media/compose.ts';
import { leadingBlack } from '../media/selfcheck.ts';
import { join } from 'node:path';
import { type Notes } from './notes.ts';
import { attachClip, type Ctx, fail, ffmpegPreview, footageSheet, imageBlock, safe, setShot, shotFrameProblems, text } from './shared.ts';

/** Frame problems found in archive footage, as a note for the agent ('' when the picture is clean). */
function frameNote(issues: FrameIssue[]) {
  if (!issues.length) return '';
  const bars = issues.some((i) => i.kind !== 'flat-block');
  const broken = issues.some((i) => i.kind === 'flat-block' && !i.card);
  const card = issues.some((i) => i.card);
  return `画面检查：${issues.map((i) => i.detail).join('；')}${bars ? '（片源自带的黑边或胶片片框，做镜头时会自动裁掉）' : ''}${broken ? '（坏帧那几秒不要用，选起点时避开）' : ''}${card ? '（纯色字卡不是要讲的画面就避开）' : ''}`;
}

/**
 * Frames of a video from `from` to `to` (seconds), one every 2-3 s and at most 24, each stamped with its
 * time, tiled in one image: how the agent looks at footage without making a version.
 */
async function timecodeSheet(src: string, out: string, from: number, to: number): Promise<string> {
  if (existsSync(out)) return out;
  const span = Math.max(0.5, to - from);
  const n = Math.min(24, Math.max(2, Math.round(span / 2.5)));
  const dir = `${out}.parts`;
  await mkdir(dir, { recursive: true });
  try {
    for (let i = 0; i < n; i++) {
      const t = from + (span * (i + 0.5)) / n;
      const stamp = `${Math.floor(t / 60)}\\:${(t % 60).toFixed(1).padStart(4, '0')}`;
      await ffmpeg(['-ss', t.toFixed(2), '-i', src, '-frames:v', '1', '-vf', `scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x111111,drawtext=${CJK_FONT_FILE ? `fontfile='${CJK_FONT_FILE}':` : ''}text='${stamp}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`, join(dir, `${String(i).padStart(2, '0')}.png`)]);
    }
    await ffmpeg(['-i', join(dir, '%02d.png'), '-vf', `tile=4x${Math.ceil(n / 4)}:padding=4:color=white`, '-frames:v', '1', out]);
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function footageTools(ctx: Ctx, { hookNote, frozenNote }: Notes) {
  /**
   * Candidates from find_footage in this conversation, under short handles (f1, f2, …): provider ids carry
   * spaces and quotes that get mangled when copied. use_footage only fetches what a search returned.
   */
  const footageSeen = new Map<string, FootageCandidate>();
  let footageCount = 0;

  const findFootage = tool(
    'find_footage',
    'Search real archive images and video clips with clear reuse rights: the NASA Image and Video Library (public domain) and Wikimedia Commons (public domain, CC0, CC BY, CC BY-SA only; ESA material comes through here). Use it first for explainers, science, history and news, where real pictures beat generated ones. English queries work best. Returns numbered candidates with kind, license, credit and a contact sheet of thumbnails to look at; then fetch the ones you want with use_footage.',
    {
      query: z.string().describe('What to find, in English, e.g. "James Webb Space Telescope mirror" or "Perseverance rover Jezero crater".'),
      kind: z.enum(['image', 'video', 'any']).optional().describe('Default any.'),
      sources: z.array(z.enum(['nasa', 'commons'])).optional().describe('Default both.'),
    },
    safe(async ({ query, kind, sources }) => {
      const found = await searchFootage(query, { kind: kind ?? 'any', limit: 8, sources });
      if (!found.length) return { content: [text(`没有找到"${query}"的可用素材，换个说法（英文、更具体的名称）再搜，或者这部分用示意动画。`)] };
      const handles = found.map((c) => {
        const known = [...footageSeen].find(([, x]) => x.id === c.id)?.[0];
        const h = known ?? `f${++footageCount}`;
        footageSeen.set(h, c);
        return h;
      });
      const sheet = await footageSheet(found, ctx.store.path('shots', `footage-${hashInputs(query, kind, sources)}.png`));
      const list = found.map((c, i) => `${i + 1}. ${handles[i]} [${c.kind === 'video' ? '视频' : '图片'}] ${c.title}${c.duration ? `（${Math.round(c.duration)} 秒）` : ''} — ${c.credit}，${c.license}`).join('\n');
      const art = found.some((c) => c.artwork) ? '署名里标着"艺术想象图""示意图"的是画出来或模拟的，不是实拍：能用实拍就优先用实拍；用了的话，口播和字幕不要把它说成真实照片或真实画面。' : '';
      return { content: [text(`找到 ${found.length} 个可用素材（下面的缩略图按编号排列）：\n${list}\n\n挑合适的，把编号（比如 f2）交给 use_footage 取下来。画面要和片子讲的事实对得上（是哪个天体、哪次任务），看不准的不要用。${art}`), ...(sheet ? [await imageBlock(sheet)] : [])] };
    }),
  );

  const useFootage = tool(
    'use_footage',
    'Download archive footage found with find_footage into assets/ (videos are converted and cut to at most max_seconds). Each file is recorded with its source, license and credit in assets_manifest.json; shots using it get a source label and the video gets a credits card automatically. Use images in image shots (render_image_shot) and videos in footage shots (render_footage_shot).',
    {
      ids: z.array(z.string()).min(1).max(6).describe('Handles from find_footage results, like "f3".'),
      max_seconds: z.number().int().min(2).max(120).optional().describe('Longest video length to keep (default 60).'),
    },
    safe(async ({ ids, max_seconds }) => {
      const unknown = ids.filter((h) => !footageSeen.has(h.trim()));
      if (unknown.length) return fail(`这些编号不是这次对话里 find_footage 找到的：${unknown.join('、')}。先搜，再从结果里挑（填 f1 这样的编号）。`);
      await mkdir(ctx.store.path('assets'), { recursive: true });
      const got: string[] = [];
      const previews = [];
      let anyArt = false;
      for (const h of ids) {
        const id = footageSeen.get(h.trim())!.id;
        try {
          const r = await fetchFootage(id, ctx.store.path('assets'), { maxSeconds: max_seconds ?? 60 });
          recordManifest(ctx.store.dir, r.entry);
          // Archive clips often open on black (a countdown, a slate): where the picture starts is worth knowing.
          const lead = r.kind === "video" ? await leadingBlack(ctx.store.path("assets", r.file)) : 0;
          // Baked-in bars and broken frames (a half-transmitted image that is one solid colour) are named here,
          // so the in point avoids them.
          const issues = await scanFrames(ctx.store.path('assets', r.file)).catch(() => [] as FrameIssue[]);
          if (r.entry.artwork) anyArt = true;
          got.push(`assets/${r.file}（${r.kind === 'video' ? `视频 ${Math.round(r.duration ?? 0)} 秒${lead >= 0.3 ? `，开头 ${lead.toFixed(1)} 秒是黑场（做镜头时会自动跳过）` : ''}` : '图片'}，${r.width}x${r.height}，${r.entry.credit}，${r.entry.license}）${issues.length ? `。${frameNote(issues)}` : ''}`);
          // A video comes with frames across its length, stamped with their time, to choose the in point from.
          const pv = ctx.store.path('shots', `${r.file}.${r.kind === 'video' ? 'frames' : 'preview'}.png`);
          if (r.kind === 'video') await timecodeSheet(ctx.store.path('assets', r.file), pv, 0, r.duration ?? 0).catch(() => {});
          else await ffmpegPreview(ctx.store.path('assets', r.file), pv).catch(() => {});
          if (existsSync(pv)) previews.push(await imageBlock(pv));
        } catch (e) {
          got.push(`${h} 没取到：${(e as Error).message}`);
        }
      }
      return { content: [text(`素材：\n${got.join('\n')}\n\n图片用 kind image 的镜头（image 填文件名，render_image_shot），视频用 kind footage 的镜头（footage 填文件名，from 填从第几秒开始，render_footage_shot）。片子里会自动标来源、片尾自动加署名。${anyArt ? '标着"艺术想象图""示意"的不是实拍，角标会照实写；口播和字幕也不要把它说成真实照片或真实画面。' : ''}`), ...previews.slice(0, 4)] };
    }),
  );

  const previewFootage = tool(
    'preview_footage',
    'Look at a stretch of an archive video in assets/ (from use_footage): frames every 2-3 s, each stamped with its time, to choose where a footage shot starts. Makes no version and the user sees nothing; never use assemble_video to look at footage.',
    { footage: z.string().describe('The video file in assets/.'), from: z.number().min(0).optional(), to: z.number().min(0).optional() },
    safe(async ({ footage, from, to }) => {
      const file = basename(footage);
      const src = ctx.store.path('assets', file);
      if (!file || !existsSync(src)) return fail(`找不到视频 assets/${file}`);
      const length = probeDuration(src);
      const a = Math.min(from ?? 0, Math.max(0, length - 0.5));
      const b = Math.max(a + 0.5, Math.min(to ?? length, length));
      const sheet = await timecodeSheet(src, ctx.store.path('shots', `${file}.${a.toFixed(1)}-${b.toFixed(1)}.frames.png`), a, b);
      const issues = await scanFrames(src, { from: a, to: b }).catch(() => [] as FrameIssue[]);
      return { content: [text(`assets/${file}（共 ${length.toFixed(1)} 秒）${a.toFixed(1)}–${b.toFixed(1)} 秒的画面，左上角是时间。${frameNote(issues)}`), await imageBlock(sheet)] };
    }),
  );

  const renderFootageShot = tool(
    'render_footage_shot',
    'Turn a footage shot (kind footage) into a clip: the archive video from assets/, from the given second, for the shot\'s length (its own sound is dropped; the voiceover and music carry the audio). Takes a few seconds.',
    { shot_id: z.string(), footage: z.string().optional().describe('Override the plan\'s video (file in assets/).'), from: z.number().min(0).optional().describe('Second of the source to start at.'), keep_black: z.boolean().optional().describe('Keep a black opening of the source (skipped automatically otherwise).') },
    safe(async ({ shot_id, footage, from, keep_black }) => {
      let s: Shot;
      try { s = ctx.store.shot(shot_id); } catch (e) { return fail((e as Error).message); }
      if (s.kind !== 'footage') return fail(`镜头 ${shot_id} 的类型是 ${s.kind}，不是 footage。`);
      const file = basename(footage ?? s.footage ?? '');
      const src = ctx.store.path('assets', file);
      if (!file || !existsSync(src)) return fail(`找不到视频 assets/${file}`);
      const p = ctx.store.project;
      const length = probeDuration(src);
      // Archive clips often open on black (a slate, a countdown): that is skipped unless asked for, so a shot
      // never opens dark. Kept inside the source; a source shorter than the shot holds its last frame.
      const lead = keep_black ? 0 : await leadingBlack(src);
      const wanted = Math.max(from ?? s.from ?? 0, lead < length - 1 ? lead : 0);
      const start = Math.max(0, Math.min(wanted, Math.max(0, length - s.seconds)));
      // 'bars+push': clips made before baked-in bars were cut and frozen stretches pushed in are made again.
      const inputHash = hashInputs('footage', file, statSync(src).size, start, s.seconds, p.aspect, 'bars+push');
      const clip = ctx.store.path(`clips/${inputHash}.mp4`);
      const done: string[] = [];
      if (!existsSync(clip)) {
        setShot(ctx, s, { status: 'working', error: undefined });
        const cut = ctx.store.path(`clips/${inputHash}.cut.mp4`);
        const norm = ctx.store.path(`clips/${inputHash}.norm.mp4`);
        const hold = Math.max(0, s.seconds - (length - start)) + 0.5;
        try {
          await ffmpeg(['-ss', start.toFixed(3), '-i', src, '-t', String(s.seconds), '-an', '-vf', `tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', cut]);
          // Bars baked into the source (a 4:3 frame pillarboxed in 16:9) are cut away before the frame is filled.
          const bars = await detectBars(cut).catch(() => null);
          await normalizeClip(cut, norm, s.seconds, p.aspect, bars ? `crop=${bars.w}:${bars.h}:${bars.x}:${bars.y}` : undefined);
          if (bars) done.push('片源自带的黑边或片框已裁掉');
          // An archive still shown as video sits frozen on screen: it gets a slow push-in.
          const still = await stillness(norm, { skipStart: 0 }).catch(() => null);
          const change = await pictureChange(norm).catch(() => null);
          if ((still && (still.stillShare > 0.5 || still.longestStill >= 2.5)) || (change && change.frozenShare > 0.5)) {
            await slowPush(norm, clip, s.seconds, { ...FRAME_SIZE[p.aspect], fps: config.fps });
            done.push('这段片源基本不动，加了缓慢推近');
          } else {
            await rename(norm, clip);
          }
        } catch (e) {
          setShot(ctx, s, { status: 'failed', error: '渲染失败' });
          await ctx.store.save();
          return fail(`渲染失败：${(e as Error).message}`);
        } finally {
          await rm(cut, { force: true });
          await rm(norm, { force: true });
        }
      }
      s.footage = file;
      s.from = start;
      await attachClip(ctx, s, inputHash);
      // Bars that only start later in the shot are not cut (cutting them would crop the clean part too).
      const issues = await scanFrames(clip).catch(() => [] as FrameIssue[]);
      const problems = shotFrameProblems(issues);
      const cards = issues.filter((i) => i.card);
      const hook = await hookNote(s, clip);
      const frozen = await frozenNote(clip, '这段素材');
      return { content: [text(`镜头 ${shot_id} 已用 assets/${file} 从第 ${start.toFixed(1)} 秒起做成 ${s.seconds} 秒的镜头${done.length ? `（${done.join('，')}）` : ''}。` + frozen +
        (problems.length ? `注意，镜头里${problems.join('；')}（时间从镜头开头算）。换个起点（from）、缩短镜头或者换一段素材避开它，重新渲染。` : '') +
        (cards.length ? `镜头里有纯色字卡：${cards.map((i) => i.detail).join('；')}，不是要讲的画面就换个起点。` : '') + hook)] };
    }),
  );
  return { findFootage, useFootage, previewFootage, renderFootageShot };
}
