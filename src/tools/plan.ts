// Planning tools: save_plan (the shot list), present_script (the script card) and ask_user (question and brief cards).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { FRAME_SIZE, seedanceMocked } from '../core/config.ts';
import { readIndex } from '../media/ingest.ts';
import { forDisplay, hasVoiceMarks, type Script, type Shot } from '../media/project.ts';
import { MOTION_TYPES, type MotionType } from '../media/compose.ts';
import { DEFAULT_VO_SPEED, VOICE_CATALOG } from '../core/config.ts';
import { settings, seedanceModel } from '../core/settings.ts';
import { randomUUID } from 'node:crypto';
import { type Ctx, emitPlan, fail, safe, text } from './shared.ts';
import { type Voiceover } from './voiceover.ts';

/** Latin acronyms in voiceover lines that have no spoken form given (vo_tts), e.g. "NASA" or "JWST" in a Chinese line. */
function acronymHints(shots: Array<{ id: string; vo?: string; vo_tts?: string }>) {
  const out: string[] = [];
  for (const n of shots) {
    if (!n.vo || n.vo_tts?.trim() || !/[㐀-鿿]/.test(n.vo)) continue;
    for (const m of n.vo.match(/\b[A-Z]{2,6}\b/g) ?? []) out.push(`${n.id} 的 ${m}`);
  }
  return [...new Set(out)];
}

/** Plan limits: up to 40 shots of up to 30 s, so long videos are possible without one shot carrying too much. */
const MAX_SHOTS = 40;
const MAX_SHOT_SECONDS = 30;

export function planTools(ctx: Ctx, voiceover: Voiceover) {
  const savePlan = tool(
    'save_plan',
    'Create or revise the video plan: the ordered shot list. Call this before making any shot, and again whenever the user changes requirements, deletes/reorders shots, edits captions, or toggles subtitles. Keep the id of every shot that should stay the same so its finished clip is reused; give new or reworked shots new ids or change them. Returns which shots already have usable clips and which still need making.',
    {
      title: z.string().describe('Short working title naming the subject, e.g. "小雨的恐龙生日祝福" or "光合作用动画讲解"'),
      aspect: z.enum(['9:16', '16:9', '1:1']).describe('Frame shape. Default 9:16 for short-video feeds.'),
      subtitles: z.boolean().optional().describe('Burn the per-shot captions into the video. Default true.'),
      target_seconds: z.number().int().min(3).max(1200).optional().describe('The length the user asked for, in seconds ("一分钟多点" = 70, "30 秒左右" = 30, "不用太长" for a short-video ad = 30); without a request, the length you planned. A version more than 15% longer is sent back for cutting.'),
      source_labels: z.boolean().optional().describe('A small source label in a corner of every shot: the credit of real footage ("NASA/JHU-APL"), "AI 生成画面" for AI-generated pictures, "示意动画" for animations. Default: on when the video uses real footage. Turn it on for explainers and news even without footage; off for ads and personal videos.'),
      voice: z.enum(Object.keys(VOICE_CATALOG) as [string, ...string[]]).optional().describe(`The voiceover voice for this video, chosen for its tone (kept until changed; unset = the user's default voice). Chinese: ${Object.entries(VOICE_CATALOG).filter(([, v]) => v.lang === 'zh').map(([k, v]) => `${k}: ${v.label}（${v.fits}）`).join('; ')}. English lines use ${Object.entries(VOICE_CATALOG).filter(([, v]) => v.lang === 'en').map(([k]) => k).join(' / ')}.`),
      style: z.string().max(300).optional().describe('One line fixing the shared look for every shot: palette (hex), fonts, background, motion feel. Decide it quickly here so each shot can then be written on its own without designing all of them first.'),
      shots: z.array(z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).describe('Stable id of letters, digits, _ or -, like "s1", "hook", "cta". Reuse ids to keep finished clips.'),
        seconds: z.number().int().min(1).max(MAX_SHOT_SECONDS).describe(`Shot length in whole seconds, 1-${MAX_SHOT_SECONDS}. Seedance shots must be 4-${seedanceModel().maxSeconds}. Shots with a voiceover are lengthened automatically to fit it.`),
        kind: z.enum(['code', '3d', 'seedance', 'image', 'footage', 'clip']).describe('clip = a piece of the user\'s own uploaded video (media id + in point), cut, reframed and graded with render_clip_shot; use these first when the user gave footage. footage = a real archive video clip from assets/ (found with find_footage, fetched with use_footage), rendered with render_footage_shot; prefer it (and image shots of real photos) for explainers, science, history and news. code = HTML animation rendered exactly (text, prices, logos, product cards, UI, CTA). 3d = a three.js scene in the same HTML way (product turntables, terrain, 3D charts). seedance = AI-generated realistic footage (people, places, product in use, atmosphere), no text inside. image = a still from assets/ (e.g. made with generate_image) with a slow push/pull/pan, rendered with render_image_shot.'),
        brief: z.string().describe('One line on what this shot shows, in the user\'s language.'),
        caption: z.string().max(80).optional().describe('Subtitle line shown during this shot: short and spoken-style, at most 12 Chinese characters. It adds to what the picture shows and must not repeat text already drawn in the frame; omit it when the on-screen text says it all. With a voiceover, omit it to subtitle the voiceover itself.'),
        segment: z.string().optional().describe('Id of the script segment this shot belongs to (keep it when splitting a segment into several shots).'),
        vo: z.string().max(400).optional().describe('Voiceover spoken during this shot, exactly as in the script, in its language. It is synthesized with TTS and the shot is lengthened to fit it. It is also the subtitle, so write it as the subtitle should read (numbers as digits, like the on-screen labels); a different spoken form goes in vo_tts.'),
        vo_tts: z.string().max(400).optional().describe('How the voice should read the vo line, when that differs from how it is written: an acronym read as a word goes in sounds ("NASA" -> "纳萨" in a Chinese line), numbers or symbols spelled out, and pauses marked as <#0.5#> (seconds) where a beat helps ("早上六点，<#0.6#>第一炉面包出炉了"). The subtitle keeps vo as written.'),
        vo_speed: z.number().min(0.9).max(1.25).optional().describe(`How fast this line is read. Default ${DEFAULT_VO_SPEED} (brisk, never a drawl); ~1.15 for a punchy hook or a quick list; below 1 only for one weighty line now and then, never lower than 0.9. The voice reads at that pace (no audio stretching).`),
        audio: z.boolean().optional().describe('Seedance only: generate the shot with its own synced sound (a person speaking on camera, ambience). Put the spoken line, if any, into the shot prompt.'),
        role: z.enum(['main', 'broll', 'pip', 'source']).optional().describe('main (default): plays in sequence. broll: full-frame cutaway laid over a main shot while that shot keeps playing underneath with its sound (A-roll/B-roll: a presenter keeps talking while B-roll pictures cut in). pip: small picture-in-picture window over a main shot. source: only used as the other half of a split screen. Non-main shots add no time.'),
        over: z.string().optional().describe('broll/pip: id of the main shot it sits on.'),
        at: z.number().min(0).optional().describe('broll/pip: seconds into that main shot where it starts (default 0).'),
        rect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.1).max(1) }).optional().describe('pip window: left, top and width as fractions of the frame (default right side, upper middle, 38% wide). The top 15% (caption line) and bottom 24% (subtitles) are kept clear; a window placed there is moved.'),
        enter: z.object({ type: z.enum(MOTION_TYPES as [MotionType, ...MotionType[]]), duration: z.number().min(0.15).max(0.8) }).optional().describe('broll/pip: how the layer comes in over the main shot: fade, wipeleft/wiperight/wipeup/wipedown (a soft edge sweeps across, revealing it) or slideleft/slideright/slideup/slidedown (it moves in from the frame edge), 0.2-0.4 s for a snappy cut-in. Default: pip fades in, broll cuts. Do the entrance here, never by painting a wipe or a solid colour into the shot\'s own first frames.'),
        exit: z.object({ type: z.enum(MOTION_TYPES as [MotionType, ...MotionType[]]), duration: z.number().min(0.15).max(0.8) }).optional().describe('broll/pip: how the layer leaves, same types (a wipe hides it as the edge sweeps on; a slide moves it out past the edge in that direction). Default: pip fades out, broll cuts.'),
        radius: z.number().int().min(0).max(60).optional().describe('pip corner radius in px (default 16).'),
        border: z.boolean().optional().describe('pip white border (default true).'),
        transition: z.object({ type: z.enum(['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'zoomin', 'whip']), duration: z.number().min(0.2).max(1.5) }).optional().describe('main shots: transition from the previous main shot into this one (works for every kind, realistic shots included). Shot timing does not move.'),
        split: z.object({ with: z.string(), layout: z.enum(['lr', 'tb']) }).optional().describe('main shots: show side by side (lr) or stacked (tb) with another shot (usually role source).'),
        image: z.string().optional().describe('image shots: file in assets/.'),
        move: z.enum(['in', 'out', 'left', 'right', 'up', 'down']).optional().describe('image shots: camera move (default in).'),
        fit: z.enum(['cover', 'contain']).optional().describe('image shots: cover = fill the frame, cropping what sticks out (photos); contain = the whole picture on a matching background, nothing cut (logos, menus, posters, anything with text). Default: contain for the user\'s PNG/GIF graphics, cover otherwise.'),
        footage: z.string().optional().describe('footage shots: the video file in assets/ (from use_footage).'),
        media: z.string().optional().describe('clip shots: the user\'s media id (m1, m2 … from list_media).'),
        in: z.number().min(0).optional().describe('clip shots: second of the source where the shot starts (pick a usable segment).'),
        speed: z.number().min(0.25).max(4).optional().describe('clip shots: playback speed (0.5 = slow motion, 2 = fast). The shot uses seconds × speed of the source.'),
        reverse: z.boolean().optional().describe('clip shots: play backwards.'),
        reframe: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }).optional().describe('clip shots: where to crop when the source shape differs from the video (e.g. landscape source in a 9:16 video): -1 = left/top edge, 0 = centre, 1 = right/bottom edge. Keep the subject in frame.'),
        grade: z.enum(['none', 'bright', 'warm', 'cool', 'vivid', 'film', 'tame_highlights', 'lift_shadows']).optional().describe('clip shots: colour preset (default none). Use the same preset across a sequence for a consistent look.'),
        keep_audio: z.number().min(0).max(1).optional().describe('clip shots: volume of the clip\'s own sound. Unset: on-location ambience is kept low under the voiceover and rises between lines, speech is muted; 0 mutes it; 0.9 when someone speaks on camera.'),
        stabilize: z.boolean().optional().describe('clip shots: steady shaky footage (on by default exactly when the stretch used was flagged 手抖; false to keep the original framing).'),
        from: z.number().min(0).optional().describe('footage shots: second of the source video the shot starts at (default 0).'),
      })).min(1).max(MAX_SHOTS),
    },
    safe(async (args) => {
      // Voice directions written into vo (pause marks, interjections) belong to the spoken form: subtitles and
      // cards show vo, so they move to vo_tts and vo keeps the words alone.
      for (const n of args.shots) {
        if (!n.vo || !hasVoiceMarks(n.vo)) continue;
        if (!n.vo_tts?.trim()) n.vo_tts = n.vo;
        n.vo = forDisplay(n.vo);
      }
      const p = ctx.store.project;
      const old = new Map(p.shots.map((s) => [s.id, s]));
      const aspectChanged = p.aspect !== args.aspect;
      const ids = new Set<string>();
      const shots: Shot[] = [];
      const maxSeedance = seedanceModel().maxSeconds;
      // Voiceover first: its length decides how long each shot runs (0.2 s lead-in, 0.4 s tail).
      // Every script line with a voiceover must be read by some shot: a plan that forgets them gives a silent
      // video. Missing lines are filled in from the script (by segment, else by order when the counts match);
      // what cannot be matched is sent back.
      const filled: string[] = [];
      const unread: string[] = [];
      // Only a plan that builds on the script is held to it (shots name its segments, now or before), and only
      // while voiceover is on: a new, unrelated video in the same conversation is not.
      const mainShots = args.shots.filter((n) => !n.role || n.role === 'main');
      const sameVideo = args.title === p.title;
      // The first plan for the script, shot for segment: filled by order when it names no segments itself.
      const byOrder = !p.shots.length && !p.versions.length && !args.shots.some((n) => n.vo?.trim() || n.segment) && mainShots.length === (p.script?.segments.length ?? -1);
      const builtOnScript = args.shots.some((n) => n.segment) || (sameVideo && args.shots.some((n) => old.get(n.id)?.segment)) || byOrder;
      const segs = settings.get().voiceover && builtOnScript && p.script?.vo_language !== 'none' ? (p.script?.segments ?? []).filter((g) => g.vo?.trim()) : [];
      if (segs.length) {
        // A shot that speaks on camera (realistic, with its own sound) reads its line itself: no TTS on top.
        const ownVoice = (n: (typeof args.shots)[number]) => n.kind === 'seedance' && Boolean(n.audio ?? old.get(n.id)?.audio);
        // Lines already carried: by a shot naming the segment, or by the same text on any shot.
        const read = new Set(args.shots.filter((n) => n.segment && n.vo?.trim()).map((n) => n.segment!));
        for (const g of segs) if (args.shots.some((n) => n.vo?.trim() === g.vo!.trim())) read.add(g.id);
        mainShots.forEach((n, i) => {
          if (n.vo?.trim() || ownVoice(n)) return;
          const segId = n.segment ?? (sameVideo ? old.get(n.id)?.segment : undefined);
          const seg = segId ? segs.find((g) => g.id === segId) : byOrder ? p.script!.segments[i] : undefined;
          if (!seg?.vo?.trim() || read.has(seg.id)) return;
          n.vo = seg.vo;
          if (seg.vo_tts && !n.vo_tts?.trim()) n.vo_tts = seg.vo_tts;
          n.segment = seg.id;
          read.add(seg.id);
          filled.push(`${n.id}←${seg.id}`);
        });
        const missing = segs.filter((g) => !read.has(g.id) && !args.shots.some((n) => n.vo?.trim() && n.vo.trim() === g.vo!.trim()));
        // Nothing voiced at all while the script has lines: that is the silent-video mistake, so it is sent back.
        // Single lines left out may be on purpose (a shot dropped, the user cut a sentence) and are only noted.
        if (missing.length && !args.shots.some((n) => n.vo?.trim() || ownVoice(n))) {
          return fail(`剧本里的口播一句都没有镜头念：${missing.map((g) => `${g.id}「${g.vo!.slice(0, 20)}…」`).join('、')}。给对应的镜头加上 segment（段 id）和 vo（口播原文）；如果用户不要口播了，先用 present_script 改剧本（vo_language 设为 none）。`);
        }
        unread.push(...missing.map((g) => `${g.id}「${g.vo!.slice(0, 16)}…」`));
      }
      // The video's voice is set before the lines are spoken: they are spoken in it.
      if (args.voice !== undefined) p.voice = args.voice;
      const vo = await voiceover(args.shots, p.script?.vo_language);
      const voNotes: string[] = [];
      for (const n of args.shots) {
        if (ids.has(n.id)) return fail(`镜头 id 重复：${n.id}`);
        ids.add(n.id);
        const line = vo.get(n.id);
        if (line) {
          const need = Math.ceil(line.seconds + 0.6);
          if (need > n.seconds) {
            voNotes.push(`${n.id} 口播 ${line.seconds.toFixed(1)} 秒，镜头从 ${n.seconds} 秒延长到 ${Math.min(need, MAX_SHOT_SECONDS)} 秒`);
            n.seconds = Math.min(need, MAX_SHOT_SECONDS);
          } else voNotes.push(`${n.id} 口播 ${line.seconds.toFixed(1)} 秒`);
        }
        if (n.kind === 'seedance' && n.seconds < 4) return fail(`镜头 ${n.id} 用 seedance 至少要 4 秒（现在是 ${n.seconds} 秒），或者改成 code。`);
        if (n.kind === 'seedance' && n.seconds > maxSeedance) return fail(`镜头 ${n.id} 用 seedance 最长 ${maxSeedance} 秒（现在是 ${n.seconds} 秒${line ? '，口播较长' : ''}），拆成两个镜头、缩短口播，或者改成 code。`);
        const prev = old.get(n.id);
        const keep = prev && prev.kind === n.kind && prev.seconds === n.seconds
          && (n.kind !== 'seedance' || Boolean(prev.audio) === Boolean(n.audio ?? prev.audio))
          && (n.kind !== 'image' || (prev.image === n.image && (prev.move ?? 'in') === (n.move ?? 'in') && prev.fit === n.fit))
          && (n.kind !== 'footage' || (prev.footage === n.footage && (prev.from ?? 0) === (n.from ?? 0)))
          && (n.kind !== 'clip' || (JSON.stringify([prev.media, prev.in ?? 0, prev.speed ?? 1, !!prev.reverse, prev.reframe ?? null, prev.grade ?? 'none']) === JSON.stringify([n.media, n.in ?? 0, n.speed ?? 1, !!n.reverse, n.reframe ?? null, n.grade ?? 'none'])
            && (n.stabilize === undefined || n.stabilize === prev.stabilize)));
        // Placement and editing fields change how the clip is used, not the clip itself.
        const layout = { segment: n.segment, vo: n.vo, voTts: n.vo_tts, voFile: line?.file, voSeconds: line?.seconds, role: n.role, over: n.over, at: n.at, rect: n.rect, enter: n.enter, exit: n.exit, radius: n.radius, border: n.border, transition: n.transition, split: n.split, image: n.image, move: n.move, fit: n.fit, footage: n.footage, from: n.from, media: n.media, in: n.in, speed: n.speed, reverse: n.reverse, reframe: n.reframe, grade: n.grade, keepAudio: n.keep_audio, voSpeed: n.vo_speed,
          // A stabilisation choice made for this footage survives plan edits that do not restate it.
          stabilize: n.stabilize ?? (prev?.kind === 'clip' && prev.media === n.media ? prev.stabilize : undefined) };
        // A paid shot reworked for another reason than its shape or length (say its sound was switched) still
        // counts as generated, so making it again shows the approval card in generate_seedance_shot.
        const paidBefore = prev?.generatedOnce && prev.kind === 'seedance' && n.kind === 'seedance' && !aspectChanged && prev.seconds === n.seconds;
        shots.push(keep ? { ...prev, brief: n.brief, caption: n.caption, ...layout } : { ...n, ...layout, status: 'planned', ...(paidBefore ? { generatedOnce: true } : {}) });
      }
      // Cutaways and windows must sit on a main shot and fit inside it; splits must name a real shot.
      const mains = new Map(args.shots.filter((n) => !n.role || n.role === 'main').map((n) => [n.id, n]));
      for (const n of args.shots) {
        if (n.role === 'broll' || n.role === 'pip') {
          const base = n.over ? mains.get(n.over) : undefined;
          if (!base) return fail(`镜头 ${n.id} 是 ${n.role}，需要用 over 指定它叠在哪个主镜头上。`);
          if ((n.at ?? 0) + n.seconds > base.seconds + 0.01) return fail(`镜头 ${n.id}（${n.seconds} 秒，从第 ${n.at ?? 0} 秒开始）超出了主镜头 ${base.id} 的 ${base.seconds} 秒，缩短它或调整 at。`);
        }
        else if (n.enter || n.exit) return fail(`镜头 ${n.id} 不是 broll 或 pip，不能用 enter/exit；主镜头之间的切换用 transition。`);
        if (n.split && !ids.has(n.split.with)) return fail(`镜头 ${n.id} 的分屏对象 ${n.split.with} 不在计划里。`);
        if (n.kind === 'image' && !n.image) return fail(`image 镜头 ${n.id} 需要用 image 指定 assets/ 里的图片。`);
        if (n.kind === 'footage' && !n.footage) return fail(`footage 镜头 ${n.id} 需要用 footage 指定 assets/ 里的视频（先用 use_footage 取素材）。`);
        if (n.kind === 'clip') {
          const m = readIndex(ctx.store.dir).find((x) => x.id === n.media);
          if (!m) return fail(`clip 镜头 ${n.id} 需要用 media 指定用户素材的编号（list_media 里的 m1、m2…）。`);
          if (m.kind !== 'video') return fail(`素材 ${m.id} 是${m.kind === 'image' ? '图片，用 kind image 的镜头（image 填 ' + m.file.split('/').pop() + '）' : m.kind}，不是视频。`);
          if (m.status !== 'ready') return fail(`素材 ${m.id} 还在入库，入库完系统会通知你。`);
          const span = n.seconds * (n.speed ?? 1);
          if ((n.in ?? 0) + span > (m.duration ?? 0) + 0.05) return fail(`clip 镜头 ${n.id} 从第 ${n.in ?? 0} 秒起要用 ${span.toFixed(1)} 秒素材，可 ${m.id} 只有 ${(m.duration ?? 0).toFixed(1)} 秒。缩短镜头、提前入点，或者用 speed 加快。`);
        }
      }
      if (!mains.size) return fail('计划里至少要有一个主镜头（role 为 main）。');
      // Paid shots that this plan forces to be generated again: same id kept as seedance, but the
      // frame shape or length changed, so the existing clip can't be reused.
      const redo = args.shots.filter((n) => {
        const prev = old.get(n.id);
        return prev?.generatedOnce && n.kind === 'seedance' && (aspectChanged || prev.seconds !== n.seconds);
      });
      if (redo.length && !seedanceMocked()) {
        const why = aspectChanged ? `画幅改为 ${args.aspect}` : '镜头时长已修改';
        const ok = await ctx.requestApproval(
          `${why}，需要重新生成 ${redo.length} 个写实镜头`,
          '已生成的写实镜头无法沿用，需按新要求重新生成。',
        );
        if (!ok) return fail(`用户没有同意重新生成，计划没有改动。简短地告诉用户保持原样了，不要再问一遍。`);
      }
      p.title = args.title;
      p.aspect = args.aspect;
      p.subtitles = args.subtitles ?? true;
      if (args.style !== undefined) p.style = args.style;
      if (args.source_labels !== undefined) p.sourceLabels = args.source_labels;
      if (args.target_seconds !== undefined) p.targetSeconds = args.target_seconds;
      // Shots of the last version that this plan drops: fine when asked for, a loss when not.
      const lastShots = p.versions.at(-1)?.shots ?? [];
      const dropped = lastShots.filter((x) => !args.shots.some((n) => n.id === x.id)).map((x) => x.id);
      // A new frame shape makes every clip unusable; the plan itself (layout, voiceover, editing) stays.
      p.shots = aspectChanged
        ? shots.map(({ clipFile: _c, thumbFile: _t, inputHash: _h, error: _e, generatedOnce: _g, ...rest }) => ({ ...rest, status: 'planned' as const }))
        : shots;
      await ctx.store.save();
      emitPlan(ctx);
      const ready = p.shots.filter((s) => s.status === 'ready').map((s) => s.id);
      const todo = p.shots.filter((s) => s.status !== 'ready').map((s) => `${s.id}(${s.kind})`);
      const { width, height } = FRAME_SIZE[p.aspect];
      return {
        content: [text(
          `计划已保存：${p.shots.length} 个镜头，共 ${ctx.store.totalSeconds()} 秒，画面 ${width}x${height}。` +
          (ready.length ? `可直接复用的镜头：${ready.join(', ')}。` : '') +
          (todo.length ? `还需要制作：${todo.join(', ')}。` : '所有镜头都已就绪，可以直接合成。') +
          (p.style ? `统一风格：${p.style}。` : '') +
          (voNotes.length ? `口播已合成：${voNotes.join('；')}。` : '') +
          (filled.length ? `这些镜头没写口播，已按剧本补上：${filled.join('、')}。` : '') +
          (dropped.length ? `这次计划去掉了上一版里的镜头：${dropped.join('、')}。用户没要求改的内容（讲对了的段落、背景音乐、店名和落版）要保留，不是用户要删的就加回来。` : '') +
          (unread.length ? `剧本里这些段的口播没有镜头念：${unread.join('、')}；如果是真人出镜自己说的、或者是有意删掉的可以不管，否则给对应镜头补上 segment 和 vo 再提交一次。` : '') +
          (acronymHints(args.shots).length ? `这些口播里有拉丁字母缩写，配音可能会一个字母一个字母地念：${acronymHints(args.shots).join('、')}。要读成一个词的，给那个镜头加上 vo_tts 写出读法（比如 "NASA" 写成 "纳萨"），再提交一次计划。` : '') +
          (todo.length ? '现在只构思第一个要做的镜头，写好就调用工具；渲染期间再想下一个，不要先把所有镜头的 HTML 都想完。' : '') +
          (seedanceMocked() ? '（写实镜头的生成服务还没接通，暂时用示意画面代替；跟用户提一次就行。）' : ''),
        )],
      };
    }),
  );

  const presentScript = tool(
    'present_script',
    'Show the user the script for a new video as a card, before any shot is made. Each segment: time range, role, what is on screen, the voiceover line and the subtitle. Then call ask_user to ask whether to make it or change something, and end the turn. To revise, call it again with the full script: keep the ids of unchanged segments; the card highlights what changed.',
    {
      title: z.string(),
      aspect: z.enum(['9:16', '16:9', '1:1']),
      total_seconds: z.number().int().min(3).max(1200),
      vo_language: z.string().describe('Language of the voiceover, e.g. "en" or "zh"; "none" when there is no voiceover.'),
      style: z.string().describe('One sentence on the look and tone.'),
      insight: z.string().describe('One sentence on why the script is written this way: the audience, the channel, the angle. Shows judgment.'),
      segments: z.array(z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
        start: z.number().min(0),
        end: z.number().min(0),
        role: z.string().describe('钩子 / 痛点 / 产品 / 利益点 / 行动号召 / 讲解要点 / 开场 / 结尾 …'),
        visual: z.string(),
        vo: z.string().optional().describe('Voiceover line, in vo_language, exactly as it will be spoken.'),
        caption: z.string().optional(),
        kind_hint: z.enum(['动画', '写实', '3D', '图片']).optional(),
      })).min(1).max(40),
      sources: z.array(z.object({ title: z.string(), url: z.string() })).optional().describe('Pages from research that facts in the script come from.'),
    },
    safe(async (args) => {
      const p = ctx.store.project;
      const prev = p.script;
      // Voice directions written into a line (pause marks, interjections) are spoken, never shown: the card
      // shows the line without them, and the line as spoken is kept for the voice.
      args.segments = args.segments.map((g) => (g.vo && hasVoiceMarks(g.vo) ? { ...g, vo: forDisplay(g.vo), vo_tts: g.vo } : g));
      const same = (a: Script['segments'][number], b: Script['segments'][number]) =>
        a.start === b.start && a.end === b.end && a.role === b.role && a.visual === b.visual && (a.vo ?? '') === (b.vo ?? '') && (a.caption ?? '') === (b.caption ?? '') && (a.kind_hint ?? '') === (b.kind_hint ?? '');
      const changed = prev ? args.segments.filter((g) => { const o = prev.segments.find((x) => x.id === g.id); return !o || !same(o, g); }).map((g) => g.id) : [];
      const script: Script = {
        version: (prev?.version ?? 0) + 1,
        title: args.title, aspect: args.aspect, total_seconds: args.total_seconds, vo_language: args.vo_language,
        style: args.style, insight: args.insight, segments: args.segments,
        sources: (args.sources ?? []).filter((x) => /^https?:\/\//.test(x.url)).slice(0, 8),
        changed,
      };
      p.script = script;
      if (!p.title) p.title = args.title;
      await ctx.store.save();
      ctx.emit({ type: 'script', ...script });
      return { content: [text(
        `剧本卡第 ${script.version} 版已经显示给用户${changed.length ? `（改动的段：${changed.join('、')}）` : ''}。接下来简短地说明${script.version > 1 ? '改了什么' : '这版的思路'}（可以省略）。用户说过"直接做""你看着办"这类话的，不问，紧接着开工（save_plan）；否则调用 ask_user 问用户按这版出片还是再改，再结束本轮，等用户回复。不要在文字里复述剧本。`,
      )] };
    }),
  );

  const askUser = tool(
    'ask_user',
    'Show a question card the user answers with a tap (or by typing). Two shapes: one question with 2-4 short options, to confirm a script ("按这版出片" / "改成更紧迫的钩子" / ...) or, after a video, to offer next steps (mode "suggest"); or a brief card: `questions`, up to 3 short questions about the brief (platform and shape, length, tone, voiceover, what to feature), each with 2-4 options and the recommended one first; the user picks per question or taps "就按推荐来", and one message comes back like "平台：抖音竖版；时长：30 秒左右". It returns at once: after calling it, end your turn and wait for the reply. Never list the options in your own text.',
    {
      question: z.string().describe('The card\'s question, or for a brief card a short heading about this particular video in your own words, e.g. a question or the name of the video; no stock formula such as 先定这几样 or 先确认几件事.'),
      options: z.array(z.string().max(40)).min(2).max(4).optional().describe('One question\'s options (not with questions).'),
      recommended_index: z.number().int().min(0).max(3).optional(),
      questions: z.array(z.object({
        label: z.string().max(8).describe('Short name of what is asked: "平台", "时长", "风格", "口播", "主推", "店名".'),
        options: z.array(z.string().max(16)).max(4).optional().describe('2-4 short options, the recommended one first.'),
        input: z.string().max(20).optional().describe('Instead of options, a fill-in field for an open answer (a shop name, the product to feature); the text is its placeholder, e.g. "比如：麦穗面包".'),
      })).min(1).max(3).optional().describe('A brief card: up to 3 questions answered together. Open questions (which shop, which product) go here as fill-in fields, so everything is asked once.'),
      mode: z.enum(['confirm', 'suggest']).optional().describe('confirm (default): a decision the user should make now. suggest: optional next steps after a video.'),
    },
    safe(async ({ question, options, recommended_index, questions, mode }) => {
      const id = randomUUID();
      if (questions?.length) {
        if (questions.some((q) => !q.input && (q.options?.length ?? 0) < 2)) return fail('需求卡的每个问题要么有 2 到 4 个选项，要么是填空（input）。');
        ctx.emit({ type: 'ask', id, question, questions: questions.map((q) => (q.input && !(q.options?.length) ? { label: q.label, input: q.input } : { label: q.label, options: q.options })), mode: 'form' });
        return { content: [text('需求卡已显示。现在结束本轮，不要再写字，等用户选好。')] };
      }
      if (!options || options.length < 2) return fail('问题卡要有 2 到 4 个选项（options），或者用 questions 出需求卡。');
      ctx.emit({ type: 'ask', id, question, options, recommended: recommended_index ?? null, mode: mode ?? 'confirm' });
      return { content: [text(mode === 'suggest' ? '建议卡已显示。现在结束本轮。' : '问题卡已显示。现在结束本轮，不要再写字，等用户选择或回复。')] };
    }),
  );
  return { savePlan, presentScript, askUser };
}
