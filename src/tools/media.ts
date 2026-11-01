// The user's own media: list_media, inspect_media, read_document and render_clip_shot.
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config, FRAME_SIZE } from '../core/config.ts';
import { readIndex } from '../media/ingest.ts';
import { colourStats, correctionFilter, projectTarget, type ColourStats } from '../media/colormatch.ts';
import { SHAKE_LIMIT, stabilize } from '../media/stabilize.ts';
import { ffmpeg } from '../core/ffmpeg.ts';
import { hashInputs, type Shot } from '../media/project.ts';
import { type Notes } from './notes.ts';
import { attachClip, type Ctx, fail, safe, setShot, text } from './shared.ts';

/** Colour statistics of a stretch of a user's clip, once per stretch. */
const colourCache = new Map<string, Promise<ColourStats | null>>();
const colourOf = (file: string, from: number, to: number) => {
  const key = `${file}:${from.toFixed(2)}:${to.toFixed(2)}`;
  if (!colourCache.has(key)) colourCache.set(key, colourStats(file, { from, to }).catch(() => null));
  return colourCache.get(key)!;
};

/** Colour presets for the user's footage, as ffmpeg filters. */
const GRADES: Record<string, string[]> = {
  none: [],
  bright: ['eq=brightness=0.04:contrast=1.05:saturation=1.06'],
  warm: ['colorbalance=rs=0.06:gs=0.02:bs=-0.06:rm=0.04:bm=-0.04', 'eq=saturation=1.06'],
  cool: ['colorbalance=rs=-0.05:bs=0.06:rm=-0.03:bm=0.04'],
  vivid: ['eq=contrast=1.08:saturation=1.3'],
  film: ['eq=contrast=1.06:saturation=0.88', 'colorbalance=rh=0.03:bh=-0.03:bs=0.03'],
  tame_highlights: ["curves=all='0/0 0.6/0.58 0.85/0.78 1/0.9'", 'eq=saturation=1.05'],
  lift_shadows: ["curves=all='0/0.04 0.25/0.32 0.6/0.64 1/1'"],
};

export function mediaTools(ctx: Ctx, { hookNote }: Notes) {
  const listMedia = tool(
    'list_media',
    'The user\'s uploaded files (media_index): each video with its shots (time range, description, tags, quality flags such as 手抖/过曝/太暗/模糊/重复/误拍, usable or not), audio, images and documents. Pick usable shots for clip shots; leave flagged ones out unless nothing else shows that moment.',
    {
      media: z.string().optional().describe('Only this item (m1 …); with it, its contact sheet image is included.'),
      usable_only: z.boolean().optional().describe('List only usable shots.'),
    },
    safe(async ({ media, usable_only }) => {
      const items = readIndex(ctx.store.dir).filter((m) => !media || m.id === media);
      if (!items.length) return { content: [text(media ? `没有素材 ${media}。` : '用户还没有上传素材。')] };
      const kindName = { video: '视频', audio: '音频', image: '图片', pdf: '文档', text: '文档' } as const;
      const lines: string[] = [];
      for (const m of items) {
        const head = `${m.id}「${m.name}」${kindName[m.kind]}${m.duration ? ` ${m.duration.toFixed(1)} 秒` : ''}${m.width ? ` ${m.width}x${m.height}` : ''}${m.status !== 'ready' ? `（${m.status === 'failed' ? `入库失败：${m.error ?? ''}` : '入库中'}）` : ''}${m.summary ? `：${m.summary}` : ''}`;
        lines.push(head);
        if (m.kind === 'video') {
          m.segments.forEach((sg, i) => {
            if (usable_only && !sg.usable) return;
            lines.push(`  ${m.id} 段${i + 1} ${sg.start.toFixed(1)}–${sg.end.toFixed(1)} 秒${sg.desc ? ` ${sg.desc}` : ''}${sg.tags?.length ? ` [${sg.tags.join('、')}]` : ''}${sg.flags.length ? ` ⚠${sg.flags.join('、')}` : ''}${sg.usable ? '' : '（不建议用）'}${sg.dupOf ? `（和 ${sg.dupOf} ${sg.flags.includes('重复') ? '重复' : '相似'}）` : ''}`);
          });
        }
        if (m.transcript?.length) lines.push(`  说的话：${m.transcript.map((t) => `[${t.start.toFixed(1)}] ${t.text}`).join(' ').slice(0, 400)}`);
        if (m.text) lines.push(`  文档 ${m.text.length} 字，用 read_document 读全文`);
      }
      const one = items.length === 1 ? items[0] : undefined;
      const sheet = one?.sheet && existsSync(ctx.store.path(one.sheet)) ? [{ type: 'image' as const, data: (await readFile(ctx.store.path(one.sheet))).toString('base64'), mimeType: 'image/jpeg' }] : [];
      return { content: [text(lines.join('\n').slice(0, 12000) + '\n\n图片素材做 image 镜头时 image 直接填素材编号（比如 m4）；动画镜头里要放用户的 logo 或照片，用 <img src="/media/m4">（原图，透明背景保留），不要自己重画；视频素材做 clip 镜头（media 填编号，in 填入点秒数）。'), ...sheet] };
    }),
  );

  const inspectMedia = tool(
    'inspect_media',
    'Look closely at the user\'s footage: frames of one video at the given seconds (or across one shot), to check framing, faces, text, focus before choosing an in point or a reframe.',
    {
      media: z.string(),
      times: z.array(z.number().min(0)).max(6).optional().describe('Seconds to look at.'),
      segment: z.number().int().min(1).optional().describe('Or: a shot number from list_media; four frames across it.'),
    },
    safe(async ({ media, times, segment }) => {
      const m = readIndex(ctx.store.dir).find((x) => x.id === media);
      if (!m || m.kind !== 'video' || !m.proxy) return fail(`${media} 不是已入库的视频。`);
      const sg = segment ? m.segments[segment - 1] : undefined;
      if (segment && !sg) return fail(`${media} 没有第 ${segment} 段。`);
      const at = (times?.length ? times : sg ? [0.1, 0.37, 0.63, 0.9].map((k) => sg.start + (sg.end - sg.start) * k) : [0.5, 0.25, 0.75].map((k) => (m.duration ?? 1) * k))
        .map((t) => Math.min(Math.max(0, t), Math.max(0, (m.duration ?? 0) - 0.05)));
      const blocks = [];
      for (const t of at) {
        const out = ctx.store.path('shots', `inspect-${m.id}-${t.toFixed(2)}.jpg`);
        if (!existsSync(out)) await ffmpeg(['-ss', t.toFixed(2), '-i', ctx.store.path(m.proxy), '-frames:v', '1', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-q:v', '4', out]);
        blocks.push({ type: 'image' as const, data: (await readFile(out)).toString('base64'), mimeType: 'image/jpeg' });
      }
      return { content: [text(`${m.id} 在 ${at.map((t) => t.toFixed(1)).join('、')} 秒的画面：`), ...blocks] };
    }),
  );

  const readDocument = tool(
    'read_document',
    'Read a document the user uploaded (shop information, a menu, a brief, as PDF or text), to use its facts in the video. Long documents come in pages of 8000 characters.',
    { media: z.string(), page: z.number().int().min(1).optional() },
    safe(async ({ media, page }) => {
      const m = readIndex(ctx.store.dir).find((x) => x.id === media);
      if (!m || (m.kind !== 'pdf' && m.kind !== 'text')) return fail(`${media} 不是文档。图片里的文字用 inspect_media 或 list_media 看不了的话，用 read_document 也读不了。`);
      if (!m.text) return fail(`${media} 没有读出文字（可能是扫描件）。`);
      const p = page ?? 1, size = 8000, pages = Math.ceil(m.text.length / size);
      return { content: [text(`「${m.name}」第 ${p}/${pages} 页：\n${m.text.slice((p - 1) * size, p * size)}`)] };
    }),
  );

  const renderClipShot = tool(
    'render_clip_shot',
    'Turn a clip shot (kind clip) into its clip: the user\'s footage from the in point, for the shot\'s length (times speed), reversed if asked, cropped to the video\'s frame shape at the reframe offset, exposure and white balance evened out across the user\'s clips, colour preset applied. A stretch flagged 手抖 is stabilised automatically. Its own sound is kept separately and mixed at keep_audio. Takes a few seconds (longer when stabilising).',
    { shot_id: z.string(), stabilize: z.boolean().optional().describe('Force stabilisation on or off; by default it is on exactly when the stretch used was flagged 手抖.') },
    safe(async ({ shot_id, stabilize: wantStab }) => {
      let s: Shot;
      try { s = ctx.store.shot(shot_id); } catch (e) { return fail((e as Error).message); }
      if (s.kind !== 'clip') return fail(`镜头 ${shot_id} 的类型是 ${s.kind}，不是 clip。`);
      const m = readIndex(ctx.store.dir).find((x) => x.id === s.media);
      if (!m || m.kind !== 'video' || m.status !== 'ready' || !m.proxy) return fail(`镜头 ${shot_id} 的素材 ${s.media ?? ''} 不是已入库的视频。`);
      const p = ctx.store.project;
      const speed = s.speed ?? 1, start = s.in ?? 0, span = s.seconds * speed;
      const proxy = ctx.store.path(m.proxy);
      // Shaky stretches are steadied when that is the only take of the moment (the agent picked it anyway).
      const shaky = m.segments.some((g) => g.flags.includes('手抖') && g.start < start + span && g.end > start);
      if (wantStab !== undefined) s.stabilize = wantStab;
      const steady = Boolean(s.stabilize ?? shaky);
      // Exposure and white balance are evened out toward what the project's user clips share, before the preset.
      const others = ctx.store.project.shots.filter((x) => x.kind === 'clip' && x.media);
      const index = readIndex(ctx.store.dir);
      const all = await Promise.all(others.map((x) => {
        const mm = index.find((y) => y.id === x.media && y.proxy);
        const a = x.in ?? 0;
        return mm ? colourOf(ctx.store.path(mm.proxy!), a, a + x.seconds * (x.speed ?? 1)) : Promise.resolve(null);
      }));
      const own = await colourOf(proxy, start, start + span);
      // The shared target is rounded, so adding or dropping a shot does not shift every clip's correction.
      const target = projectTarget(all.filter((x): x is ColourStats => Boolean(x)));
      const even = own ? correctionFilter(own, { luma: Math.round(target.luma * 50) / 50 }) : '';
      const inputHash = hashInputs('clip', m.file, m.proxy, start, s.seconds, speed, !!s.reverse, s.reframe ?? null, s.grade ?? 'none', p.aspect, even, steady);
      const notes: string[] = [];
      const clip = ctx.store.path(`clips/${inputHash}.mp4`);
      const audio = ctx.store.path(`clips/${inputHash}.audio.m4a`);
      // A clip made after stabilising failed (an error, a timeout under load) is tried again next time.
      const unsteady = ctx.store.path(`clips/${inputHash}.unsteady`);
      if (!existsSync(clip) || existsSync(unsteady)) {
        setShot(ctx, s, { status: 'working', error: undefined });
        const { width: W, height: H } = FRAME_SIZE[p.aspect];
        const rx = s.reframe?.x ?? 0, ry = s.reframe?.y ?? 0;
        // Speed, frame rate and size first: reverse buffers every frame it gets, so it gets as few and as
        // small ones as possible (a 30 s shot at 4x would otherwise hold thousands of 720p frames).
        const vf = [
          `setpts=PTS/${speed}`, `fps=${config.fps}`,
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}:(iw-${W})*${(0.5 + rx / 2).toFixed(3)}:(ih-${H})*${(0.5 + ry / 2).toFixed(3)}`,
          ...(s.reverse ? ['reverse'] : []),
          ...(even ? [even] : []),
          ...GRADES[s.grade ?? 'none'],
          `tpad=stop_mode=clone:stop_duration=${s.seconds}`, 'setsar=1',
        ].join(',');
        let source = proxy, from = start;
        const steadied = ctx.store.path(`clips/${inputHash}.steady.mp4`);
        if (steady) {
          try {
            const r = await stabilize(proxy, steadied, { from: start, seconds: span, audio: 'drop' });
            // Only a steadier result is used: otherwise the original keeps its full frame.
            if (r.residual < r.before) {
              source = steadied;
              from = 0;
              notes.push(`已防抖（抖动 ${r.before.toFixed(2)} → ${r.residual.toFixed(2)}${r.residual > SHAKE_LIMIT ? '，还是有点晃' : ''}，画面放大了 ${Math.round((r.zoom - 1) * 100)}%）`);
            } else if (r.before < SHAKE_LIMIT) {
              notes.push('这段本来就够稳，用的是原片');
            } else {
              notes.push('防抖没起作用，用的是原片，这段还是晃，能换就换一段');
            }
            await rm(unsteady, { force: true });
          } catch (e) {
            notes.push(`防抖失败（${(e as Error).message}），这次用的是原片，下次渲染会再试`);
            await writeFile(unsteady, '');
          }
        }
        try {
          await ffmpeg(['-ss', from.toFixed(3), '-t', span.toFixed(3), '-i', source, '-vf', vf, '-t', String(s.seconds), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', clip]);
        } finally {
          await rm(steadied, { force: true });
        }
        if (even) notes.push('曝光和白平衡已经和其他素材统一');
        if (m.hasAudio) {
          // atempo takes 0.5-2 per stage, so larger factors are chained.
          const tempo: string[] = [];
          for (let k = speed; Math.abs(k - 1) > 1e-3;) { const step = Math.min(2, Math.max(0.5, k)); tempo.push(`atempo=${step.toFixed(4)}`); k /= step; }
          const af = [...(s.reverse ? ['areverse'] : []), ...tempo, 'aresample=44100'].join(',');
          await ffmpeg(['-ss', start.toFixed(3), '-t', span.toFixed(3), '-i', ctx.store.path(m.proxy), '-vn', '-af', af, '-t', String(s.seconds), '-c:a', 'aac', '-b:a', '160k', audio]).catch(() => {});
        }
      }
      await attachClip(ctx, s, inputHash);
      const hook = await hookNote(s, ctx.store.path(s.clipFile!));
      return { content: [text(`镜头 ${shot_id} 已用 ${m.id} 从第 ${start.toFixed(1)} 秒起做成 ${s.seconds} 秒的镜头${speed !== 1 ? `（${speed} 倍速）` : ''}${s.reverse ? '（倒放）' : ''}${s.grade && s.grade !== 'none' ? `，调色 ${s.grade}` : ''}${notes.length ? `；${notes.join('，')}` : ''}。${hook}`)] };
    }),
  );
  return { listMedia, inspectMedia, readDocument, renderClipShot };
}
