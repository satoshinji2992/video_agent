// assemble_video (cutting, music, voice, subtitles, self-checks) and save_release_notes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config, FRAME_SIZE, seedanceMocked } from '../core/config.ts';
import { readManifest, recordManifest, refreshManifestArtwork } from '../media/footage.ts';
import { scanFrames, type FrameIssue } from '../media/framecheck.ts';
import { pictureChange } from '../media/stillness.ts';
import { beatGrid, snapCuts, type BeatGrid } from '../media/beats.ts';
import { ambienceProfile, ambienceVolume, type AmbienceProfile } from '../media/ambience.ts';
import { ledger } from '../core/ledger.ts';
import { concatClips, contactSheetAt, normalizeLoudness, finalize, hasAudio, normalizeClip, posterFrame, probeDuration, type AudioItem } from '../core/ffmpeg.ts';
import { buildAss, hashInputs, isCodeKind, isMain, type Shot } from '../media/project.ts';
import { addOverlays, creditsCard, joinClips, splitScreen, type Motion, type Overlay, type Transition, type TransitionType } from '../media/compose.ts';
import { settings } from '../core/settings.ts';
import { transcribe, TRANSCRIBE_USD_PER_MIN, type SpeechLine } from '../providers/transcribe.ts';
import { blackSegments, listenToVoiceovers, measureLoudness } from '../media/selfcheck.ts';
import { SKILLS_DIR, skillsRealRoot } from '../core/skills.ts';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { type Notes } from './notes.ts';
import { pendingSeedance, seedanceKey } from './seedance.ts';
import { type Ctx, fail, fileUrl, imageBlock, safe, shotFrameProblems, text } from './shared.ts';

/** Beat grids of the installed music tracks, worked out once per file and process. */
const beatCache = new Map<string, Promise<BeatGrid | null>>();
const beatsOf = (file: string) => {
  if (!beatCache.has(file)) beatCache.set(file, beatGrid(file).catch(() => null));
  return beatCache.get(file)!;
};
/** What a clip's own sound is (ambience, speech, nothing), once per file. */
const ambienceCache = new Map<string, Promise<AmbienceProfile | null>>();
const ambienceOf = (file: string) => {
  if (!ambienceCache.has(file)) ambienceCache.set(file, ambienceProfile(file).catch(() => null));
  return ambienceCache.get(file)!;
};
/**
 * A picture-in-picture window kept between the top caption band and the bottom subtitles (a window the
 * same shape as the frame is as tall, in fractions, as it is wide). Default: right side, upper middle.
 */
function pipRect(r?: { x: number; y: number; w: number }) {
  const w = Math.min(0.6, r?.w ?? 0.38);
  const x = Math.min(Math.max(r?.x ?? 0.58, 0.03), 0.97 - w);
  const y = Math.min(Math.max(r?.y ?? 0.2, 0.15), 0.76 - w);
  return { x, y, w };
}

/** Background music files bundled with installed skills, as "<skill>/<path>". */
function bgmChoices() {
  const out: string[] = [];
  try {
    for (const skill of readdirSync(SKILLS_DIR)) {
      const dir = join(SKILLS_DIR, skill, 'assets/audio/bgm');
      if (existsSync(dir)) for (const f of readdirSync(dir)) if (/\.(mp3|m4a|aac|wav|ogg)$/i.test(f)) out.push(`${skill}/assets/audio/bgm/${f}`);
    }
  } catch { /* no skills */ }
  return out.slice(0, 20);
}

/** How long assemble_video waits for realistic shots before handing back (they report when done). */
const ASSEMBLE_WAIT_MS = 20_000;

export function assembleTools(ctx: Ctx, { modelIn }: Notes) {
  let assembling: Promise<unknown> = Promise.resolve();
  /** The turn in which the self-check last refused a version (it refuses at most once per turn). */
  let lastListenRefusal = '';
  let lastVoiceRefusal = '';
  let lastLengthRefusal = '';
  const assembleVideo = tool(
    'assemble_video',
    'Only for a version meant for the user (never to look at footage: use preview_footage or inspect_media for that). Join all shots in plan order into a new numbered version, burning in captions if subtitles are on. If realistic shots are still generating it waits briefly, then reports which are pending (the system calls you again when they are done). Returns a contact sheet of the finished video for a final check; the user sees the video in the chat automatically.',
    {
      silent_ok: z.boolean().optional().describe('Only when the user asked for a video without sound; otherwise a version with (almost) no sound is not delivered.'),
      bgm: z.string().optional().describe(`Background music from an installed skill, as "<skill>/<path>". Explainers and ads get light music by default (it is lowered automatically under the voiceover); leave it out only when the user does not want music. Available: ${bgmChoices().join(', ') || 'none installed'}.`),
    },
    safe(async ({ bgm, silent_ok }) => {
      let bgmFile: string | undefined;
      if (bgm) {
        const root = skillsRealRoot();
        try {
          bgmFile = realpathSync(join(SKILLS_DIR, bgm));
        } catch {
          return fail(`找不到背景音乐 ${bgm}`);
        }
        if (!bgmFile.startsWith(root + sep) || !/\.(mp3|m4a|aac|wav|ogg)$/i.test(bgmFile)) return fail('背景音乐只能用已安装技能里的音频文件。');
      }
      // One assembly at a time per session, so version numbers never collide.
      // A plan of nothing but archive footage, with no voiceover and no music, is someone looking at footage,
      // not a video for the user.
      const mainShots = ctx.store.project.shots.filter(isMain);
      if (mainShots.length && mainShots.every((x) => x.kind === 'footage') && !bgmFile && !mainShots.some((x) => x.vo?.trim()) && !silent_ok) {
        return fail('这个计划全是档案素材，没有口播也没有音乐，看起来是在看素材，不是要给用户看的成片。看素材用 preview_footage（或 use_footage 返回的抽帧）；要出片就先把口播、音乐和其他镜头加进计划。');
      }
      const run = assembling.then(() => assemble(bgmFile, Boolean(silent_ok)));
      assembling = run.catch(() => {});
      return run;
    }),
  );

  async function assemble(bgmFile?: string, silentOk = false) {
      // Where the time goes, per step, in the server log (a long video's assembly is otherwise a black box).
      const t0 = Date.now();
      const took: string[] = [];
      const lap = (what: string) => took.push(`${what} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const p = ctx.store.project;
      if (!p.shots.length) return fail('还没有计划，先调用 save_plan。');
      const waiting = p.shots.filter((s) => s.inputHash && pendingSeedance.has(seedanceKey(ctx.sessionId, s.id, s.inputHash)));
      if (waiting.length) {
        ctx.emit({ type: 'note', text: '正在等待写实镜头生成完成' });
        const done = Promise.all(waiting.map((s) => pendingSeedance.get(seedanceKey(ctx.sessionId, s.id, s.inputHash!))));
        const timedOut = await Promise.race([done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ASSEMBLE_WAIT_MS).unref())]);
        if (timedOut) {
          const names = waiting.map((s) => s.brief).join('、');
          return fail(`这些写实镜头还在生成：${names}。不用等，它们好了系统会叫你，那时再合成。用一句话告诉用户还在拍、好一个发一个，然后结束这一轮。`);
        }
      }
      const notReady = p.shots.filter((s) => s.status !== 'ready' || !s.clipFile);
      if (notReady.length) {
        return fail('这些镜头还没有可用的片段：' + notReady.map((s) => `${s.id}(${s.kind}, ${s.status}${s.error ? '：' + s.error : ''})`).join('；') +
          '。code 镜头可以直接重新渲染；seedance 镜头失败的话用一句话告诉用户你打算怎么办（重做或改成动画），重做就直接调用工具，需要确认时界面会弹出确认卡。');
      }
      const { width, height } = FRAME_SIZE[p.aspect];
      const size = { width, height, fps: config.fps };
      const byId = new Map(p.shots.map((x) => [x.id, x]));
      const mains = p.shots.filter(isMain);
      // Cuts on the beat: with music that has a clear pulse, each main shot may grow or shrink by up to
      // 0.35 s (never under its voiceover, never more than 0.4 s past its clip, held on its last frame) so
      // the cuts land on beats, and the music starts where that lines up best. Split screens keep their length.
      const lengthOf = new Map(mains.map((s) => [s.id, s.seconds]));
      let bgmOffset = 0;
      let onBeat = '';
      if (bgmFile && mains.length > 1) {
        const grid = await beatsOf(bgmFile);
        if (grid && grid.confidence >= 0.4 && grid.beats.length >= 8) {
          const fixed = (s: Shot) => Boolean(s.split) || mains.some((x) => x.split?.with === s.id);
          // A cutaway or picture-in-picture on a shot must still fit inside it.
          const overlaid = (s: Shot) => Math.max(0, ...p.shots.filter((x) => (x.role === 'broll' || x.role === 'pip') && x.over === s.id).map((x) => (x.at ?? 0) + x.seconds));
          const r = snapCuts(mains.map((s) => fixed(s)
            ? { seconds: s.seconds, min: s.seconds, max: s.seconds }
            : { seconds: s.seconds, min: Math.max(1, (s.voSeconds ?? 0) + 0.4, overlaid(s)), max: s.seconds + 0.4 }), grid.beats, { downbeats: grid.downbeats });
          // Cuts on the frame grid, rounded from the running total: each clip is encoded to whole frames, and
          // lengths rounded one by one would add up to a drift against the music and the subtitles.
          let total = 0, prev = 0;
          mains.forEach((s, i) => {
            total += r.seconds[i]!;
            const cut = Math.round(total * config.fps) / config.fps;
            lengthOf.set(s.id, Math.round((cut - prev) * 1000) / 1000);
            prev = cut;
          });
          bgmOffset = r.offset;
          onBeat = `${r.snapped}/${mains.length - 1} 个切点卡在音乐节拍上`;
        }
      }
      const len = (sh: Shot) => lengthOf.get(sh.id) ?? sh.seconds;
      const norm = async (sh: Shot) => {
        const out = ctx.store.path(`clips/${sh.inputHash}.${p.aspect.replace(':', 'x')}.${len(sh)}s.norm.mp4`);
        if (!existsSync(out)) await normalizeClip(ctx.store.path(sh.clipFile!), out, len(sh), p.aspect);
        return out;
      };
      const n = (p.versions.at(-1)?.n ?? 0) + 1;
      // 1. Main shots in order (a split screen is built first), with sound placed on the main timeline:
      //    each voiceover line just after its shot starts, and realistic shots' own sound.
      const seq: Array<{ file: string; seconds: number }> = [];
      const startOf = new Map<string, number>();
      const voices: AudioItem[] = [];
      const owns: Array<{ s: Shot; file: string; start: number; seconds: number }> = [];
      /** When someone speaks on the timeline (voiceover lines as long as they really are, people on camera). */
      const spoken: Array<[number, number]> = [];
      let at = 0;
      for (const s of mains) {
        let file = await norm(s);
        const other = s.split ? byId.get(s.split.with) : undefined;
        if (s.split && other) {
          const out = ctx.store.path(`clips/${hashInputs('split', s.inputHash, other.inputHash, s.split.layout, s.seconds, p.aspect)}.mp4`);
          if (!existsSync(out)) await splitScreen(file, await norm(other), s.split.layout, out, s.seconds, size);
          file = out;
        }
        const secs = len(s);
        seq.push({ file, seconds: secs });
        startOf.set(s.id, at);
        if (s.voFile && existsSync(ctx.store.path(s.voFile))) {
          voices.push({ file: ctx.store.path(s.voFile), start: at + 0.2, duration: secs - 0.2, vo: true });
          spoken.push([at + 0.2, at + 0.2 + Math.min(secs - 0.2, s.voSeconds ?? secs)]);
        }
        if (s.kind === 'seedance' && s.audio && hasAudio(ctx.store.path(s.clipFile!))) {
          voices.push({ file: ctx.store.path(s.clipFile!), start: at, duration: secs, volume: s.voFile ? 0.5 : 0.9 });
          spoken.push([at, at + secs]);
        }
        const own = s.kind === 'clip' && s.inputHash ? ctx.store.path(`clips/${s.inputHash}.audio.m4a`) : '';
        if (own && existsSync(own)) owns.push({ s, file: own, start: at, seconds: secs });
        at += secs;
      }
      // Real footage is credited: a small label on every shot while it plays, and a closing credits card.
      // Files fetched before artwork was told apart are looked up again, so an artist's concept is labelled one.
      await refreshManifestArtwork(ctx.store.dir);
      const manifest = readManifest(ctx.store.dir);
      const creditOf = (s: Shot) => {
        const f = s.kind === 'footage' ? s.footage : s.kind === 'image' ? s.image : isCodeKind(s.kind) ? modelIn(s) : undefined;
        const m = f ? manifest.find((x) => x.file === f) : undefined;
        if (m) return m;
        return null;
      };
      // A model is a generic stand-in unless it is the measured shape of that very object.
      const isModel = (m: { kind?: string }) => m.kind === 'model';
      const realShape = (m: object) => Boolean((m as { realShape?: boolean }).realShape);
      const usesFootage = p.shots.some((s) => creditOf(s));
      // The corner label stays short: who made the picture, not where it was found (the credits say that).
      // The user's own footage and photos carry no label: they know where those came from.
      const ownMedia = (s: Shot) => s.kind === 'clip' || (s.kind === 'image' && /^m\d+$/.test(s.image ?? ''));
      const labelOf = (s: Shot) => {
        if (ownMedia(s)) return '';
        const m = creditOf(s);
        if (m && isModel(m)) return realShape(m) ? m.credit : '三维示意';
        return m?.credit.replace(/\s*\/\s*Wikimedia Commons$/i, '') ?? (s.kind === 'seedance' || s.kind === 'image' ? 'AI 生成画面' : '示意动画');
      };
      const badges: Array<{ start: number; end: number; text: string }> = [];
      if (p.sourceLabels ?? usesFootage) {
        // A cutaway's label replaces its main shot's label while it is on screen.
        const cuts = p.shots.filter((x) => x.role === 'broll' && x.over && startOf.has(x.over)).map((x) => ({ start: startOf.get(x.over!)! + (x.at ?? 0), end: startOf.get(x.over!)! + (x.at ?? 0) + x.seconds, text: labelOf(x) }));
        for (const s of mains) {
          let from = startOf.get(s.id)!;
          const to = from + len(s);
          for (const c of cuts.filter((c) => c.start < to && c.end > from).sort((a, b) => a.start - b.start)) {
            if (c.start > from) badges.push({ start: from, end: c.start, text: labelOf(s) });
            from = Math.max(from, c.end);
          }
          if (to > from) badges.push({ start: from, end: to, text: labelOf(s) });
        }
        badges.push(...cuts);
      }
      for (let i = badges.length - 1; i >= 0; i--) if (!badges[i]!.text) badges.splice(i, 1);
      const used = manifest.filter((m) => p.shots.some((s) => creditOf(s)?.file === m.file));
      for (const m of used) recordManifest(ctx.store.dir, { ...m, usedFor: p.shots.filter((s) => creditOf(s)?.file === m.file).map((s) => s.id) });
      if (used.length) {
        const creditsFile = ctx.store.path(`versions/v${n}.credits.mp4`);
        // One line per source (the licence where attribution is required), then where they were found.
        const lines = [...new Set(used.map((m) => isModel(m)
          ? `${m.credit}（${realShape(m) ? '实测形状模型' : '三维示意模型'}）`
          : `${m.credit.replace(/\s*\/\s*Wikimedia Commons$/i, '')}${m.needsAttribution ? `（${m.license}）` : ''}`))];
        const LIBRARIES: Record<string, string> = { nasa: 'NASA Image and Video Library', commons: 'Wikimedia Commons', polyhaven: 'Poly Haven', nasa3d: 'NASA 3D Resources', svs: 'NASA Scientific Visualization Studio' };
        const found = [...new Set(used.map((m) => LIBRARIES[m.source as string] ?? String(m.source)))];
        lines.push(`素材取自 ${found.join('、')}`);
        if (p.shots.some((s) => s.kind === 'seedance' || (s.kind === 'image' && !creditOf(s)))) lines.push('部分画面为 AI 生成示意');
        const creditSeconds = await creditsCard(creditsFile, lines, size);
        seq.push({ file: creditsFile, seconds: creditSeconds });
        at += creditSeconds;
      }
      lap('clips');
      // 2. Join, with transitions where asked (shot start times do not move).
      let joined = ctx.store.path(`versions/v${n}.joined.mp4`);
      const transitions = mains.slice(1).map((s) => (s.transition ? { type: s.transition.type as TransitionType, duration: s.transition.duration } as Transition : null));
      // The closing credits card fades in.
      if (seq.length > mains.length) transitions.push({ type: 'fade', duration: 0.5 });
      if (transitions.some(Boolean)) await joinClips(seq, transitions, joined, size);
      else await concatClips(seq.map((x) => x.file), ctx.store.path(`versions/v${n}.txt`), joined);
      // 3. Cutaways (B-roll over a talking A-roll) and picture-in-picture windows on top.
      const overlays: Overlay[] = [];
      for (const s of p.shots.filter((x) => x.role === 'broll' || x.role === 'pip')) {
        const base = s.over ? startOf.get(s.over) : undefined;
        if (base === undefined) continue;
        const start = base + (s.at ?? 0);
        const file = s.kind === 'image' || s.role === 'broll' ? await norm(s) : ctx.store.path(s.clipFile!);
        const motion = { enter: s.enter as Motion | undefined, exit: s.exit as Motion | undefined };
        overlays.push(s.role === 'broll'
          ? { file, kind: 'video', start, end: start + s.seconds, ...motion }
          : { file, kind: 'video', start, end: start + s.seconds, rect: pipRect(s.rect), radius: s.radius ?? 16, border: s.border === false ? undefined : { px: 3, color: 'white' }, shadow: true, fadeIn: s.enter ? 0 : 0.2, fadeOut: s.exit ? 0 : 0.2, ...motion });
        if (s.voFile && existsSync(ctx.store.path(s.voFile))) {
          voices.push({ file: ctx.store.path(s.voFile), start: start + 0.2, duration: s.seconds - 0.2, vo: true });
          spoken.push([start + 0.2, start + 0.2 + Math.min(s.seconds - 0.2, s.voSeconds ?? s.seconds)]);
        }
      }
      // The user's own footage keeps its sound. Someone talking to the camera (keep_audio 0.7 and up) plays at
      // that level throughout; on-location sound (a grinder, milk steaming, the room) sits under the voiceover
      // and comes up between lines. Left unset, ambience is kept at a low level and speech or silence is not.
      for (const o of owns) {
        const profile = await ambienceOf(o.file);
        let keep = o.s.keepAudio;
        if (keep === undefined) keep = profile?.character === 'ambience' ? 0.3 : 0;
        if (keep <= 0) continue;
        // The bed levels suit ambience around -24 to -34 LUFS; a louder bed (a wok, music in a gym) is turned
        // down by its excess, or it would mask the voice.
        const hot = profile?.loudness != null && profile.loudness > -24 ? 10 ** ((-24 - profile.loudness) / 20) : 1;
        voices.push(keep >= 0.7
          ? { file: o.file, start: o.start, duration: o.seconds, volume: keep }
          : { file: o.file, start: o.start, duration: o.seconds, bed: true, filter: ambienceVolume({ clipStart: o.start, clipSeconds: o.seconds, voice: spoken, under: keep * hot, gap: Math.min(1, Math.max(0.7, keep * 2.5)) * hot }) });
      }
      lap('join');
      if (overlays.length) {
        const layered = ctx.store.path(`versions/v${n}.layered.mp4`);
        await addOverlays(joined, overlays, layered, size);
        joined = layered;
      }
      // On-camera speech is subtitled from the clip itself, so the words and timing match what is said.
      const speech = new Map<string, SpeechLine[]>();
      if (p.subtitles) {
        // Only shots where someone was asked to say something: an ambience-only clip would get whisper's
        // inventions ("Thank you for watching.") as subtitles.
        const speaks = (x: Shot) => {
          const hint = ctx.store.path(`clips/${x.inputHash}.prompt.txt`);
          return existsSync(hint) && /says|said|speaks|talks|asks|shouts|台词|说|讲|喊|["“「‘]/i.test(readFileSync(hint, 'utf8'));
        };
        for (const s of mains.filter((x) => x.kind === 'seedance' && x.audio && x.clipFile && speaks(x))) {
          try {
            const r = await transcribe(ctx.store.path(s.clipFile!));
            if (r.lines.length) speech.set(s.id, r.lines);
            if (r.fresh) ledger.record({ session: ctx.sessionId, item: `听写 / ${s.id}`, model: 'whisper-1', usage: `${Math.round(r.seconds)} s`, usd: (r.seconds / 60) * TRANSCRIBE_USD_PER_MIN, basis: 'estimate' });
          } catch (e) {
            // Without a transcript the shot keeps the caption-only subtitle.
            console.warn(`transcribe ${s.id}: ${(e as Error).message}`);
          }
        }
      }
      // Much longer than asked: sent back once with what to cut, before anything is rendered into a version.
      const total = mains.reduce((a, x) => a + x.seconds, 0);
      const target = p.targetSeconds;
      if (target && total > target * 1.15 && lastLengthRefusal !== ctx.turnId()) {
        lastLengthRefusal = ctx.turnId();
        const over = Math.ceil(total - target);
        const options = mains.slice(1, -1).map((x) => `${x.id}「${x.brief}」${x.seconds} 秒（删掉后全片 ${total - x.seconds} 秒）`).join('；');
        return fail(`这一版 ${total} 秒，比要的 ${target} 秒长了 ${over} 秒（超过 15%），没有合成。要删掉至少 ${over} 秒：去掉讲得重复或最弱的段落，或者把几个镜头各缩短一点；不要删用户没要求改、又讲得对的内容，开头的钩子和结尾的落版保留。各镜头：${options}。改好后用 save_plan 提交再合成；如果用户明确要这么长，先把 target_seconds 改掉。`);
      }
      // Every voiceover line must actually be in the mix: a shot that lost its audio file (or a plan that
      // never synthesized it) is caught here, before anything is delivered.
      const voiced = settings.get().voiceover ? p.shots.filter((s) => s.vo?.trim() && s.role !== 'source') : [];
      const unvoiced = voiced.filter((s) => !s.voFile || !voices.some((v) => v.file === ctx.store.path(s.voFile!)));
      if (unvoiced.length && lastVoiceRefusal !== ctx.turnId()) {
        lastVoiceRefusal = ctx.turnId();
        return fail(`这些镜头有口播，但没有配音文件进到混音里：${unvoiced.map((s) => `${s.id}「${s.brief}」`).join('、')}。用 save_plan 重新提交计划（保留这些镜头的 vo），配音会重新合成，然后再合成视频。`);
      }
      const onScreen = new Map<string, string>();
      for (const s of mains) {
        const f = s.inputHash ? ctx.store.path(`clips/${s.inputHash}.text.txt`) : '';
        if (isCodeKind(s.kind) && f && existsSync(f)) onScreen.set(s.id, readFileSync(f, 'utf8'));
      }
      // Subtitles follow the shots' lengths as cut (on the beat), not as planned.
      const timed = { ...p, shots: p.shots.map((x) => (lengthOf.has(x.id) ? { ...x, seconds: lengthOf.get(x.id)! } : x)) };
      const ass = buildAss(timed, width, height, speech, badges, onScreen);
      const assFile = ass ? ctx.store.path(`versions/v${n}.ass`) : null;
      if (ass && assFile) await writeFile(assFile, ass);
      const file = `versions/v${n}.mp4`;
      lap('overlays');
      // On-camera speech of the user's own clips ducks the music too.
      const talking = voices.filter((v) => !v.bed && !v.vo && v.volume !== undefined && v.volume >= 0.7).map((v) => [v.start, v.start + (v.duration ?? 0)] as [number, number]);
      await finalize(joined, ctx.store.path(file), assFile, bgmFile, voices, bgmOffset, [...spoken, ...talking]);
      lap('finalize');
      // Listening before delivering: sound at all, and every line read as written. Problems go back to the
      // agent to fix; a second attempt in the same turn is delivered with them noted, so it never loops.
      const problems: string[] = unvoiced.length ? [`这些镜头的口播没有进混音：${unvoiced.map((s) => s.brief).join('、')}`] : [];
      const lufs = await measureLoudness(ctx.store.path(file));
      // Placeholder clips (no video service connected) are silent, so only real ones are expected to have sound.
      const expectSound = voiced.length > 0 || (!seedanceMocked() && p.shots.some((s) => s.kind === 'seedance' && s.audio && isMain(s)));
      if (expectSound && (lufs === null || lufs < -40)) problems.push(`整条片子几乎没有声音（响度 ${lufs === null ? '测不出' : `${Math.round(lufs)} LUFS`}），可是镜头里有口播或同期声`);
      const heard = await listenToVoiceovers(voiced, (rel) => ctx.store.path(rel), (secs) => {
        ledger.record({ session: ctx.sessionId, item: '听写口播', model: 'whisper-1', usage: `${Math.round(secs)} s`, usd: (secs / 60) * TRANSCRIBE_USD_PER_MIN, basis: 'estimate' });
      });
      lap('listen');
      // Broken frames in archive footage (a half-transmitted picture that is one solid colour) look like an
      // error on screen; checked on the shot as it is cut, so only frames that are really in the video count.
      for (const s of p.shots.filter((x) => creditOf(x) && x.clipFile && existsSync(ctx.store.path(x.clipFile)))) {
        const bad = shotFrameProblems(await scanFrames(ctx.store.path(s.clipFile!)).catch(() => [] as FrameIssue[]));
        if (bad.length) problems.push(`「${s.brief}」（${s.id}）里${bad.join('；')}（时间从镜头开头算），换个起点、缩短镜头或换一段素材`);
      }
      // The whole version barely moving for most of its length reads as a slideshow, whatever each shot does.
      const change = await pictureChange(ctx.store.path(file)).catch(() => null);
      if (change && change.frozenShare > 0.6) {
        const still: string[] = [];
        for (const s of mains.filter((x) => x.clipFile && existsSync(ctx.store.path(x.clipFile)))) {
          const c = await pictureChange(ctx.store.path(s.clipFile!)).catch(() => null);
          if (c && c.frozenShare > 0.5) still.push(`${s.id}「${s.brief}」${Math.round(c.frozenShare * 100)}%`);
        }
        problems.push(`整条片子约 ${Math.round(change.frozenShare * 100)}% 的时间画面几乎不动，像幻灯片${still.length ? `；最静的镜头：${still.slice(0, 6).join('、')}` : ''}。让这些镜头里大面积的东西动起来（主体放大、整体推近或平移、背景漂移），或者换成更有动感的素材，重新渲染后再合成`);
      }
      lap('motion');
      for (const h of heard) {
        problems.push(h.kind === 'spelled'
          ? `「${h.brief}」（${h.shotId}）的配音把 ${h.expected} 一个字母一个字母地念了；要读成一个词就给这个镜头加 vo_tts 写出读法`
          : `「${h.brief}」（${h.shotId}）的配音听起来是“${h.heard.slice(0, 60)}”，应该是“${h.expected.slice(0, 60)}”，可能漏读或读错了；改一下 vo（或 vo_tts）重新提交计划`);
      }
      // Whatever the plan, a version with (almost) no sound is not delivered unless the user wants a silent one.
      if (!silentOk && (lufs === null || lufs < -50)) {
        return fail(`第 ${n} 版几乎没有声音（${lufs === null ? '测不出响度' : `${Math.round(lufs)} LUFS`}），没有给用户看。加上口播或背景音乐（assemble_video 的 bgm）再合成；用户明确要无声片时才传 silent_ok。`);
      }
      if (problems.length && lastListenRefusal !== ctx.turnId()) {
        lastListenRefusal = ctx.turnId();
        return fail(`第 ${n} 版合成后自检没通过，还没有给用户看：${problems.join('；')}。修好后再调用 assemble_video。`);
      }
      await normalizeLoudness(ctx.store.path(file), lufs);
      // Black stretches are only reported: some are on purpose (a "signal lost" card).
      // The closing credits card is dark on purpose and not a black stretch.
      const creditsFrom = seq.length > mains.length ? at - seq.at(-1)!.seconds : Infinity;
      const blacks = (await blackSegments(ctx.store.path(file))).filter(([a]) => a < creditsFrom - 0.2);
      // What the checks confirmed, for the introduction: it may only claim these.
      const misread = new Set(heard.map((h) => h.shotId));
      const checked = [
        voiced.length ? `口播 ${voiced.length} 段（${voiced.length - misread.size} 段听写核对一致）` : '没有配音口播',
        speech.size ? `${speech.size} 个真人镜头有同期声台词，字幕按听写逐句出` : '',
        p.subtitles ? '画面带字幕' : '没有字幕',
        bgmFile ? `有背景音乐${onBeat ? `，${onBeat}` : ''}` : '没有背景音乐',
        voices.some((v) => v.bed && v.filter?.includes('eval=frame')) ? '素材的现场声垫在口播下面、口播之间抬起来' : voices.some((v) => v.bed) ? '素材的现场声垫在口播下面' : '',
        lufs === null || lufs < -40 ? '几乎没有声音' : '响度已统一到约 -16 LUFS',
      ].filter(Boolean).join('，');
      const poster = `versions/v${n}.jpg`;
      await posterFrame(ctx.store.path(file), ctx.store.path(poster), 1);
      const seconds = Math.round(probeDuration(ctx.store.path(file)) * 10) / 10;
      p.versions.push({
        n, file, seconds, createdAt: new Date().toISOString(),
        shots: p.shots.map(({ id, kind, seconds, caption, inputHash }) => ({ id, kind, seconds, caption, inputHash })),
      });
      await ctx.store.save();
      await writeFile(ctx.store.path(`versions/v${n}.project.json`), JSON.stringify(p, null, 2));
      ctx.emit({ type: 'video', version: n, url: fileUrl(ctx, file), poster: fileUrl(ctx, poster), seconds, title: p.title, aspect: p.aspect });
      // Evenly spread frames, plus the middle of every picture-in-picture window, which an even spread
      // easily misses, so the check sees each one.
      const sheet = ctx.store.path(`versions/v${n}.sheet.png`);
      const times = Array.from({ length: 9 }, (_, i) => ((i + 0.5) * seconds) / 9);
      for (const o of overlays.filter((x) => x.rect).slice(0, 6)) {
        const mid = (o.start + o.end) / 2;
        if (times.every((t) => Math.abs(t - mid) > 0.6)) times.push(mid);
      }
      await contactSheetAt(ctx.store.path(file), sheet, times.sort((a, b) => a - b));
      lap('sheet');
      console.log(`assemble ${ctx.sessionId.slice(0, 8)} v${n} ${seconds}s: ${took.join(', ')}`);
      return {
        content: [
          text(`第 ${n} 版已合成，${seconds} 秒，用户已经在对话里看到视频了。自检确认：${checked}。介绍时声音和字幕只说这里确认过的，用用户的语言说。` +
            (problems.length ? `自检还有没解决的问题，介绍时照实跟用户说：${problems.join('；')}。` : '') +
            (blacks.length ? `片中有黑屏：${blacks.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} 秒`).join('、')}；如果不是故意的黑场，找到对应镜头修掉再合成。` : '') +
            `下面是全片抽帧，快速看一眼有没有明显问题。接下来先用两三句话具体介绍这一版（开头、中段、结尾各是什么画面，口播语言，画面上的关键文字），只说这张抽帧里确实看得到的内容，画面上的文字和字幕照原样引用；抽帧里看不到的情节、文字或细节，哪怕你原本打算做，也不要说成已经做了；占位或示意的内容点明让用户补。说完再用 ask_user（mode suggest）给下一步建议。`),
          await imageBlock(sheet),
        ],
      };
  }

  const saveReleaseNotes = tool(
    'save_release_notes',
    'Write the release notes for the latest version, to post with the video: title, description and tags; the source credits (archive footage, AI-generated pictures) are appended automatically. The user gets a downloadable file. Do this for videos meant for a platform (B 站, YouTube, 抖音) once the user is happy, or when they ask.',
    {
      title: z.string().max(80),
      description: z.string().max(1500).describe('In the user\'s language; facts only from the research.'),
      tags: z.array(z.string().max(20)).max(12),
    },
    safe(async ({ title, description, tags }) => {
      const p = ctx.store.project;
      const v = p.versions.at(-1);
      if (!v) return fail('还没有成片，先合成。');
      await refreshManifestArtwork(ctx.store.dir);
      const used = readManifest(ctx.store.dir).filter((m) => m.usedFor?.length);
      const credits = [
        ...used.map((m) => `- ${m.title}：${m.credit}，${m.license}，${m.pageUrl}`),
        ...(p.shots.some((s) => s.kind === 'seedance' || (s.kind === 'image' && !used.some((m) => m.file === s.image))) ? ['- 部分画面为 AI 生成示意，非真实影像'] : []),
      ];
      const body = `# ${title}\n\n${description}\n\n标签：${tags.map((t) => `#${t.replace(/^#/, '')}`).join(' ')}\n${credits.length ? `\n画面来源：\n${credits.join('\n')}\n` : ''}`;
      const file = `versions/v${v.n}.release.md`;
      await writeFile(ctx.store.path(file), body);
      ctx.emit({ type: 'file', name: `第${v.n}版-发布文案.md`, url: fileUrl(ctx, file), label: '发布文案' });
      return { content: [text(`发布文案已保存，用户可以下载（${file}）。署名已经附在文末。用一句话告诉用户就行。`)] };
    }),
  );
  return { assembleVideo, saveReleaseNotes };
}
