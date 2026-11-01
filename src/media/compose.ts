// Compositing on top of the plain clip join: transitions that keep shot timing, picture-in-picture and B-roll
// cutaways, split screen, and Ken Burns moves for stills. Every function normalizes its inputs to the project
// frame (cover-scale, crop, fps) inside the filtergraph, so sources of any size or rate can be mixed.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicOutput, ffmpeg, hasAudio } from '../core/ffmpeg.ts';

export interface FrameSpec { width: number; height: number; fps: number }

export type TransitionType = 'fade' | 'dissolve' | 'wipeleft' | 'wiperight' | 'slideleft' | 'slideright' | 'zoomin' | 'whip';
export interface Transition { type: TransitionType; duration: number /* 0.2-1.5 s */ }

export interface Overlay {
  file: string;
  kind: 'video' | 'image';
  start: number;
  end: number;
  /** Fractions of the frame; h follows the source's aspect unless given. No rect = full-frame cutaway. */
  rect?: { x: number; y: number; w: number; h?: number };
  radius?: number;
  border?: { px: number; color: string };
  shadow?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  /** How the layer comes in and goes out (a fade here is the same as fadeIn / fadeOut). */
  enter?: Motion;
  exit?: Motion;
}

/**
 * Entrances and exits for B-roll and picture-in-picture layers. wipe*: a soft edge sweeps across the layer
 * in that direction, revealing it (enter) or hiding it (exit); slide*: the layer moves in that direction,
 * into place from the frame edge (enter) or out past the opposite edge (exit), eased.
 */
export type MotionType = 'fade' | 'wipeleft' | 'wiperight' | 'wipeup' | 'wipedown' | 'slideleft' | 'slideright' | 'slideup' | 'slidedown';
export interface Motion { type: MotionType; duration: number }
export const MOTION_TYPES: MotionType[] = ['fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown'];

/**
 * The alpha factor of the wipes as a geq expression over the layer's own clock T (0 at its first frame), or
 * '' when neither end wipes. The edge is feathered over 4% of the layer and travels a feather past both
 * sides, so the first frame of a wipe-in is fully hidden and its last fully shown.
 */
function wipeAlpha(enter: Motion | undefined, din: number, exit: Motion | undefined, dout: number, dur: number): string {
  const F = '(W*0.04+2)';
  const soft = (v: string) => `clip((${v})/${F}+0.5,0,1)`;
  // Edge position at progress r: falling moves from the far side to the near one, rising the other way.
  const falling = (L: string, r: string) => `((${L}+${F})*(1-${r})-${F}/2)`;
  const rising = (L: string, r: string) => `((${L}+${F})*${r}-${F}/2)`;
  const visible = (type: MotionType, r: string, entering: boolean) => {
    const [C, L] = type === 'wipeleft' || type === 'wiperight' ? ['X', 'W'] : ['Y', 'H'];
    const towardsStart = type === 'wipeleft' || type === 'wipeup';
    if (towardsStart) return entering ? `${C}-${falling(L, r)}` : `${falling(L, r)}-${C}`;
    return entering ? `${rising(L, r)}-${C}` : `${C}-${rising(L, r)}`;
  };
  const parts: string[] = [];
  if (enter?.type.startsWith('wipe') && din > 0) parts.push(`if(lt(T,${num(din)}),${soft(visible(enter.type, `(T/${num(din)})`, true))},1)`);
  if (exit?.type.startsWith('wipe') && dout > 0) {
    const from = num(dur - dout);
    parts.push(`if(gt(T,${from}),${soft(visible(exit.type, `((T-${from})/${num(dout)})`, false))},1)`);
  }
  return parts.join('*');
}

/**
 * Overlay x and y as expressions of the base clock t for slides, given the resting position (x0, y0) and the
 * window [t0, t1) the layer is shown in; plain numbers when nothing slides.
 */
function slidePosition(x0: number, y0: number, enter: Motion | undefined, din: number, exit: Motion | undefined, dout: number, t0: number, t1: number) {
  const dx: string[] = [];
  const dy: string[] = [];
  if (enter?.type.startsWith('slide') && din > 0) {
    // Eased out: fast in, settling into place.
    const k = `pow(1-clip((t-${num(t0)})/${num(din)},0,1),3)`;
    if (enter.type === 'slideleft') dx.push(`+(W-${x0})*${k}`);
    if (enter.type === 'slideright') dx.push(`-(${x0}+w)*${k}`);
    if (enter.type === 'slideup') dy.push(`+(H-${y0})*${k}`);
    if (enter.type === 'slidedown') dy.push(`-(${y0}+h)*${k}`);
  }
  if (exit?.type.startsWith('slide') && dout > 0) {
    // Eased in: leaving slowly, then fast.
    const k = `pow(clip((t-${num(t1 - dout)})/${num(dout)},0,1),3)`;
    if (exit.type === 'slideleft') dx.push(`-(${x0}+w)*${k}`);
    if (exit.type === 'slideright') dx.push(`+(W-${x0})*${k}`);
    if (exit.type === 'slideup') dy.push(`-(${y0}+h)*${k}`);
    if (exit.type === 'slidedown') dy.push(`+(H-${y0})*${k}`);
  }
  // Each term carries its own sign: ffmpeg's parser refuses "0+-(…)".
  return {
    x: dx.length ? `'${x0}${dx.join('')}'` : String(x0),
    y: dy.length ? `'${y0}${dy.join('')}'` : String(y0),
  };
}

export type KenBurnsMove = 'in' | 'out' | 'left' | 'right' | 'up' | 'down';

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
const num = (n: number) => Number(n.toFixed(6)).toString();

/** Retimes to the project rate and fills a w x h box (crop, never letterbox). */
const fit = (w: number, h: number, fps: number) =>
  `setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

/** Exactly `frames` frames: short sources hold their last frame rather than ending early. */
const exactFrames = (frames: number) => `tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames},setpts=PTS-STARTPTS`;

// ---------------------------------------------------------------------------------------------------------------
// Transitions

/** xfade transition per type; zoomin and whip add their own motion on top (pushIn, whipBlur). */
const XFADE: Record<TransitionType, string> = {
  // xfade's own 'dissolve' is a random-pixel dissolve that reads as noise on screen; a crossfade is what is meant.
  fade: 'fade', dissolve: 'fade', wipeleft: 'wipeleft', wiperight: 'wiperight',
  slideleft: 'slideleft', slideright: 'slideright', zoomin: 'fade', whip: 'slideleft',
};

/**
 * Joins clips so clip i still starts at the sum of the previous clips' seconds and the result lasts exactly the
 * sum: the outgoing clip's last frame is held for the transition and the xfade starts where the incoming clip
 * starts, so subtitle and voiceover offsets computed from cumulative seconds stay right.
 */
export async function joinClips(
  clips: Array<{ file: string; seconds: number }>, transitions: Array<Transition | null>, out: string, size: FrameSpec,
): Promise<{ duration: number }> {
  if (!clips.length) throw new Error('没有可拼接的片段');
  if (transitions.length !== clips.length - 1) throw new Error(`转场数量应为 ${clips.length - 1} 个，实际是 ${transitions.length} 个`);
  const { width: W, height: H, fps } = size;
  // Shot boundaries on the frame grid, rounded from cumulative time so rounding never accumulates.
  const starts: number[] = [0];
  let t = 0;
  for (const c of clips) {
    if (!(c.seconds > 0)) throw new Error('片段时长必须大于 0');
    t += c.seconds;
    starts.push(Math.round(t * fps));
  }
  const frames = clips.map((_, i) => starts[i + 1]! - starts[i]!);
  if (frames.some((n) => n < 1)) throw new Error('有片段短于一帧，无法拼接');
  // Transition length in frames; it may not outlast the incoming clip, or it would overlap the next transition.
  const hold = transitions.map((tr, i) => {
    if (!tr) return 0;
    const d = Math.round(Math.min(1.5, Math.max(0.2, tr.duration)) * fps);
    const n = Math.min(d, frames[i + 1]! - 1);
    return n >= 2 ? n : 0;
  });

  const graph: string[] = [];
  clips.forEach((_, i) => {
    let pad = hold[i] ? `,tpad=stop_mode=clone:stop=${hold[i]}` : '';
    if (hold[i] && transitions[i]!.type === 'zoomin') pad += pushIn(frames[i]!, hold[i]!);
    graph.push(`[${i}:v]${fit(W, H, fps)},format=yuv420p,${exactFrames(frames[i]!)}${pad}[c${i}]`);
  });
  let acc = '[c0]';
  for (let i = 1; i < clips.length; i++) {
    const tr = transitions[i - 1];
    const d = hold[i - 1]!;
    const label = `[j${i}]`;
    if (!tr || !d) {
      // concat runs on a microsecond timebase; xfade insists both inputs share the frame timebase.
      graph.push(`${acc}[c${i}]concat=n=2:v=1:a=0,settb=1/${fps}${label}`);
    } else {
      const at = starts[i]! / fps;
      const dur = d / fps;
      const blur = tr.type === 'whip' ? whipBlur(at, dur, fps, W) : '';
      graph.push(`${acc}[c${i}]xfade=transition=${XFADE[tr.type]}:duration=${num(dur)}:offset=${num(at)}${blur}${label}`);
    }
    acc = label;
  }
  await atomicOutput(out, (tmp) => ffmpeg([
    ...clips.flatMap((c) => ['-i', c.file]),
    '-filter_complex', graph.join(';'), '-map', acc, ...ENCODE, '-an', tmp,
  ]));
  return { duration: starts[clips.length]! / fps };
}

/**
 * Zoom-in transition: the held last frame of the outgoing clip pushes in (1x -> 1.8x, fastest at the start so the
 * move shows before the cross-fade takes over). xfade's own zoomin enlarges with nearest-neighbour sampling down to
 * the single centre pixel, so mid-transition it shows a flat blocky frame; perspective samples sub-pixel instead.
 * `in` is perspective's 1-based count of every frame on the link, so only the held tail (frame >= start) moves.
 */
function pushIn(start: number, frames: number) {
  const q = `((in-1-${start})/${frames})`;
  const z = `(1+0.8*${q}*(2-${q}))`;
  const [x0, y0, x1, y1] = [`(W-W/${z})/2`, `(H-H/${z})/2`, `(W+W/${z})/2`, `(H+H/${z})/2`];
  return `,perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y1}':x3='${x1}':y3='${y1}'` +
    `:interpolation=cubic:eval=frame:enable='gte(n,${start})'`;
}

/**
 * A whip pan is a slide whose middle smears sideways: two directional blurs stacked over the transition window
 * (light across most of it, heavy in the middle third) give a blur that ramps up and back down with the speed.
 */
function whipBlur(at: number, dur: number, fps: number, width: number) {
  const half = 0.5 / fps;
  const win = (a: number, b: number) => `between(t,${num(a)},${num(b)})`;
  return [
    `,dblur=angle=0:radius=${Math.round(width * 0.025)}:enable='${win(at + half, at + dur - half)}'`,
    `,dblur=angle=0:radius=${Math.round(width * 0.05)}:enable='${win(at + dur * 0.25, at + dur * 0.75)}'`,
  ].join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays: picture-in-picture and B-roll cutaways

/** Display size of a picture or video, with phone rotation applied. */
function probeSize(file: string): { w: number; h: number } {
  try {
    const j = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', file,
    ]).toString()) as { streams?: Array<{ width?: number; height?: number; side_data_list?: Array<{ rotation?: number }> }> };
    const s = j.streams?.[0];
    if (!s?.width || !s.height) throw new Error('no size');
    const turned = Math.abs(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
    return turned ? { w: s.height, h: s.width } : { w: s.width, h: s.height };
  } catch {
    throw new Error(`读不出素材的画面尺寸：${file}`);
  }
}

/**
 * geq alpha for an anti-aliased rounded rectangle at (x, y) sized w x h with corner radius r, as 0..1.
 * Signed distance to the edge (negative inside), so the interior is fully opaque for any radius, 0 included.
 */
function roundedRect(x: number, y: number, w: number, h: number, r: number) {
  const qx = `(abs(X+0.5-${x + w / 2})-${w / 2 - r})`;
  const qy = `(abs(Y+0.5-${y + h / 2})-${h / 2 - r})`;
  const d = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${r})`;
  return `clip(0.5-${d},0,1)`;
}

const COLOR = /^(#|0x)?[0-9a-fA-F]{6}$|^[a-zA-Z]+$/;

interface PipPlan { ow: number; oh: number; x: number; y: number; r: number; b: number; m: number; mask: string; card?: string }

/**
 * The static parts of a PiP are drawn once into PNGs: the rounded alpha mask for the picture, and a "card" with
 * the soft shadow and the border plate behind it. Per frame only the picture itself is masked and laid on top.
 */
async function planPip(o: Overlay, i: number, tmp: string, size: FrameSpec): Promise<PipPlan> {
  const { width: W, height: H } = size;
  const rect = o.rect!;
  const src = probeSize(o.file);
  const ow = Math.min(even(rect.w * W), W);
  const oh = Math.min(rect.h ? even(rect.h * H) : even((ow * src.h) / src.w), H);
  const r = Math.max(0, Math.min(Math.round(o.radius ?? Math.min(ow, oh) * 0.08), Math.floor(Math.min(ow, oh) / 2)));
  const b = Math.max(0, Math.round(o.border?.px ?? 0));
  if (b && !COLOR.test(o.border!.color)) throw new Error(`边框颜色看不懂：${o.border!.color}（用 #RRGGBB 或颜色英文名）`);
  const sigma = Math.max(4, Math.round(Math.min(W, H) * 0.025));
  const drop = Math.round(sigma * 0.6);
  const m = o.shadow ? sigma * 3 + drop : 0;
  const plan: PipPlan = { ow, oh, x: Math.round(rect.x * W), y: Math.round(rect.y * H), r, b, m, mask: join(tmp, `mask${i}.png`) };

  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=black:s=${ow}x${oh}:d=1`,
    '-vf', `format=gray,geq=lum='255*${roundedRect(0, 0, ow, oh, r)}'`, '-frames:v', '1', '-update', '1', plan.mask,
  ]);
  if (!b && !m) return plan;

  const cw = ow + 2 * b + 2 * m;
  const ch = oh + 2 * b + 2 * m;
  const keep = `lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)'`;
  const layers: string[] = [];
  let top = '';
  if (m) {
    layers.push(`color=c=black:s=${cw}x${ch}:d=1,format=yuva444p,geq=${keep}:a='140*${roundedRect(m, m + drop, ow + 2 * b, oh + 2 * b, r + b)}',gblur=sigma=${sigma}:planes=8[sh]`);
    top = '[sh]';
  }
  if (b) {
    layers.push(`color=c=${o.border!.color}:s=${cw}x${ch}:d=1,format=yuva444p,geq=${keep}:a='255*${roundedRect(m, m, ow + 2 * b, oh + 2 * b, r + b)}'[bd]`);
    if (top) {
      layers.push(`${top}[bd]overlay=format=yuv444[card]`);
      top = '[card]';
    } else top = '[bd]';
  }
  plan.card = join(tmp, `card${i}.png`);
  await ffmpeg(['-filter_complex', layers.join(';'), '-map', top, '-frames:v', '1', '-update', '1', '-pix_fmt', 'rgba', plan.card]);
  return plan;
}

/** start_time of the first video and first audio stream, in seconds (0 when the container gives none). */
function streamStarts(file: string): { video: number; audio: number } {
  try {
    const j = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', file,
    ]).toString()) as { streams?: Array<{ codec_type?: string; start_time?: string }> };
    const at = (type: string) => Number(j.streams?.find((s) => s.codec_type === type)?.start_time) || 0;
    return { video: at('video'), audio: at('audio') };
  } catch {
    throw new Error(`读不出素材的时间信息：${file}`);
  }
}

/**
 * The base audio, moved by the same amount fit() moves the picture: fit() rebases the video to t=0, so audio that
 * began earlier than the video loses that lead and audio that began later is delayed by its gap. Without this an
 * A-roll whose streams start at different times (edit lists, phone recordings) would drift out of lip sync.
 */
function baseAudio(base: string) {
  const { video, audio } = streamStarts(base);
  const lead = video - audio;
  const shift = lead > 0.0005 ? `,atrim=start=${num(lead)},asetpts=PTS-STARTPTS`
    : lead < -0.0005 ? `,adelay=${Math.round(-lead * 1000)}:all=1` : '';
  return `[0:a]asetpts=PTS-STARTPTS${shift}[aout]`;
}

/** Repeats one decoded picture `frames` times on the project frame grid (time base 1/fps, one tick per frame). */
const repeat = (frames: number, fps: number) => `settb=1/${fps},loop=loop=${frames - 1}:size=1,setpts=N`;

/**
 * Lays videos or pictures over a base video between their start and end (the base keeps playing and keeps its
 * sound). Without a rect the overlay fills the frame as a cutaway; with one it is a rounded picture-in-picture
 * with an optional border and soft shadow. An overlay video plays from its own beginning on the first base frame
 * at or after `start`, and covers every base frame with start <= t < end.
 */
export async function addOverlays(base: string, overlays: Overlay[], out: string, size: FrameSpec): Promise<void> {
  const { width: W, height: H, fps } = size;
  for (const o of overlays) if (!(o.end > o.start) || o.start < 0) throw new Error(`叠加时间不对：${o.start}–${o.end} 秒`);
  const tmp = await mkdtemp(join(dirname(out), '.overlay-'));
  try {
    const inputs = ['-i', base];
    const graph = [`[0:v]${fit(W, H, fps)},format=yuv420p[b0]`];
    let acc = '[b0]';
    for (const [i, o] of overlays.entries()) {
      // The window is counted on the base's frame grid, so a start or end between two frames neither drops nor
      // adds a frame; the tolerance keeps times like 1.0 that are on the grid from rounding up a whole frame.
      const first = Math.ceil(o.start * fps - 1e-6);
      const last = Math.ceil(o.end * fps - 1e-6) - 1;
      const n = last - first + 1;
      if (n < 1) continue; // shorter than a frame and between two frames: nothing to show
      const dur = n / fps;
      const src = inputs.length / 2;
      inputs.push('-i', o.file);
      // A still is one decoded frame repeated after scaling, so a huge photo is never queued 24 times a second.
      const still = o.kind === 'image' ? `${repeat(n, fps)},` : '';
      // Entrance and exit each get at most half the layer's time, so they never overlap.
      const din = Math.min(o.enter?.duration ?? 0, dur / 2);
      const dout = Math.min(o.exit?.duration ?? 0, dur / 2);
      const fadeIn = Math.min(o.enter?.type === 'fade' ? o.enter.duration : o.fadeIn ?? 0, dur / 2);
      const fadeOut = Math.min(o.exit?.type === 'fade' ? o.exit.duration : o.fadeOut ?? 0, dur / 2);
      const wipe = wipeAlpha(o.enter, din, o.exit, dout, dur);
      // The per-pixel geq only runs while a wipe is under way; every other frame passes through untouched.
      const wipeWindows = [
        o.enter?.type.startsWith('wipe') && din > 0 ? `lt(t,${num(din)})` : '',
        o.exit?.type.startsWith('wipe') && dout > 0 ? `gt(t,${num(dur - dout)})` : '',
      ].filter(Boolean).join('+');
      const fades = [
        fadeIn > 0 ? `fade=t=in:st=0:d=${num(fadeIn)}:alpha=1` : '',
        fadeOut > 0 ? `fade=t=out:st=${num(dur - fadeOut)}:d=${num(fadeOut)}:alpha=1` : '',
      ].filter(Boolean);
      let layer: string;
      let x = 0;
      let y = 0;
      if (!o.rect) {
        const wiped = wipe ? `,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${wipe}':enable='${wipeWindows}'` : '';
        graph.push(`[${src}:v]${fit(W, H, fps)},${still}${exactFrames(n)},format=yuva420p${wiped}${fades.map((f) => `,${f}`).join('')}[o${i}]`);
        layer = `[o${i}]`;
      } else {
        const p = await planPip(o, i, tmp, size);
        const maskIn = inputs.length / 2;
        inputs.push('-i', p.mask);
        graph.push(`[${maskIn}:v]format=gray,${repeat(n, fps)}[m${i}]`);
        graph.push(`[${src}:v]${fit(p.ow, p.oh, fps)},${still}${exactFrames(n)},format=rgba[v${i}]`);
        graph.push(`[v${i}][m${i}]alphamerge[p${i}]`);
        layer = `[p${i}]`;
        x = p.x;
        y = p.y;
        if (p.card) {
          const cardIn = inputs.length / 2;
          inputs.push('-i', p.card);
          graph.push(`[${cardIn}:v]format=rgba,${repeat(n, fps)}[k${i}]`);
          graph.push(`[k${i}][p${i}]overlay=x=${p.m + p.b}:y=${p.m + p.b}:format=rgb[q${i}]`);
          layer = `[q${i}]`;
          x -= p.m + p.b;
          y -= p.m + p.b;
        }
        const effects = [...(wipe ? [`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${wipe}':enable='${wipeWindows}'`] : []), ...fades];
        if (effects.length) {
          graph.push(`${layer}${effects.join(',')}[f${i}]`);
          layer = `[f${i}]`;
        }
      }
      // Overlay frame k lands exactly on base frame first+k; the gate sits half a frame outside the window on
      // both sides so float error in t can never flip a frame at its edge.
      graph.push(`${layer}settb=1/${fps},setpts=PTS+${first}[s${i}]`);
      const gate = `between(t,${num((first - 0.5) / fps)},${num((last + 0.5) / fps)})`;
      const pos = slidePosition(x, y, o.enter, din, o.exit, dout, first / fps, (last + 1) / fps);
      graph.push(`${acc}[s${i}]overlay=x=${pos.x}:y=${pos.y}:eof_action=pass:enable='${gate}'[a${i}]`);
      acc = `[a${i}]`;
    }
    graph.push(`${acc}format=yuv420p[vout]`);
    const audio = hasAudio(base);
    if (audio) graph.push(baseAudio(base));
    await atomicOutput(out, (file) => ffmpeg([
      ...inputs, '-filter_complex', graph.join(';'), '-map', '[vout]',
      ...(audio ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '160k'] : []), ...ENCODE, file,
    ]));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Split screen

/** Two shots side by side ('lr') or stacked ('tb'), each cropped to fill its half, with a thin white divider. */
export async function splitScreen(
  a: string, b: string, layout: 'lr' | 'tb', out: string, seconds: number, size: FrameSpec, gap = 4,
): Promise<void> {
  const { width: W, height: H, fps } = size;
  if (!(seconds > 0)) throw new Error('分屏时长必须大于 0');
  const n = Math.max(1, Math.round(seconds * fps));
  const g = Math.max(0, Math.round(gap));
  // Halves stay even-sized for 4:2:0; any odd pixel goes to the divider.
  const lr = layout === 'lr';
  const hw = lr ? 2 * Math.floor((W - g) / 4) : W;
  const hh = lr ? H : 2 * Math.floor((H - g) / 4);
  const graph = [
    `color=c=white:s=${W}x${H}:r=${fps},trim=end_frame=${n}[bg]`,
    `[0:v]${fit(hw, hh, fps)},${exactFrames(n)}[a]`,
    `[1:v]${fit(hw, hh, fps)},${exactFrames(n)}[b]`,
    `[bg][a]overlay=0:0[t]`,
    `[t][b]overlay=${lr ? W - hw : 0}:${lr ? 0 : H - hh},format=yuv420p[vout]`,
  ];
  await atomicOutput(out, (tmp) => ffmpeg(['-i', a, '-i', b, '-filter_complex', graph.join(';'), '-map', '[vout]', ...ENCODE, '-an', tmp]));
}

// ---------------------------------------------------------------------------------------------------------------
// Ken Burns

/** How far each move zooms: zooms travel 1 -> 1.25, pans hold 1.18 and travel across the spare edge. */
const KB_ZOOM = 1.25;
const KB_PAN_ZOOM = 1.18;
/** The still is prepared at twice the frame size so the zoomed-in view is still sampled from real detail. */
const KB_SUPERSAMPLE = 2;

/**
 * A slow camera move over a still: 'in'/'out' zoom on the centre, 'left'/'right'/'up'/'down' pan the camera that
 * way. Any image aspect covers the frame (centre crop first); motion eases in and out.
 * zoompan crops on whole pixels, which shows as a wobble on slow moves; `perspective` samples the view rectangle
 * at sub-pixel positions, so each frame lands exactly where the easing curve says.
 */
export async function kenBurns(image: string, out: string, seconds: number, size: FrameSpec, move: KenBurnsMove): Promise<void> {
  const { width: W, height: H, fps } = size;
  if (!(seconds > 0)) throw new Error('运镜时长必须大于 0');
  const n = Math.max(1, Math.round(seconds * fps));
  const k = KB_SUPERSAMPLE;
  // Eased progress 0..1 over the clip's frames, and the zoom at that point.
  const e = n > 1 ? `(1-cos(PI*in/${n - 1}))/2` : '0';
  const z = move === 'in' ? `(1+${KB_ZOOM - 1}*${e})` : move === 'out' ? `(${KB_ZOOM}-${KB_ZOOM - 1}*${e})` : `${KB_PAN_ZOOM}`;
  // Top-left of the view rectangle (W/H here are perspective's input size, i.e. the supersampled still).
  const cx = `(W-W/${z})/2`;
  const cy = `(H-H/${z})/2`;
  const pos: Record<KenBurnsMove, [string, string]> = {
    in: [cx, cy],
    out: [cx, cy],
    left: [`(W-W/${z})*(1-${e})`, cy],
    right: [`(W-W/${z})*${e}`, cy],
    up: [cx, `(H-H/${z})*(1-${e})`],
    down: [cx, `(H-H/${z})*${e}`],
  };
  const [x, y] = pos[move];
  const r = `(${x}+W/${z})`;
  const b = `(${y}+H/${z})`;
  const vf = [
    `scale=${W * k}:${H * k}:force_original_aspect_ratio=increase:flags=bicubic`,
    `crop=${W * k}:${H * k}`,
    'setsar=1,format=yuv444p',
    // One decoded still, repeated after scaling; perspective then moves the view per frame.
    `loop=loop=${n - 1}:size=1,setpts=N/(${fps}*TB)`,
    `perspective=x0='${x}':y0='${y}':x1='${r}':y1='${y}':x2='${x}':y2='${b}':x3='${r}':y3='${b}':interpolation=cubic:eval=frame`,
    `scale=${W}:${H}:flags=bicubic,format=yuv420p`,
  ].join(',');
  await atomicOutput(out, (tmp) => ffmpeg(['-i', image, '-vf', vf, '-frames:v', String(n), '-r', String(fps), ...ENCODE, '-an', tmp]));
}

/**
 * A slow push-in over a clip that barely moves (an archive still shown as video, a locked-off view): zooms on
 * the centre from 1 to `zoom` with the same easing and sub-pixel sampling as kenBurns, at the clip's own size.
 */
export async function slowPush(input: string, out: string, seconds: number, size: FrameSpec, zoom = 1.12): Promise<void> {
  const { width: W, height: H, fps } = size;
  const n = Math.max(1, Math.round(seconds * fps));
  const k = KB_SUPERSAMPLE;
  const e = n > 1 ? `(1-cos(PI*in/${n - 1}))/2` : '0';
  const z = `(1+${zoom - 1}*${e})`;
  const x = `(W-W/${z})/2`, y = `(H-H/${z})/2`, r = `(${x}+W/${z})`, b = `(${y}+H/${z})`;
  const vf = [
    `scale=${W * k}:${H * k}:flags=bicubic,setsar=1,format=yuv444p`,
    `perspective=x0='${x}':y0='${y}':x1='${r}':y1='${y}':x2='${x}':y2='${b}':x3='${r}':y3='${b}':interpolation=cubic:eval=frame`,
    `scale=${W}:${H}:flags=bicubic,format=yuv420p`,
  ].join(',');
  await atomicOutput(out, (tmp) => ffmpeg(['-i', input, '-vf', vf, '-frames:v', String(n), '-r', String(fps), ...ENCODE, '-an', tmp]));
}

/**
 * A closing credits card: "画面来源" and one entry per source, centred on a dark background. Nothing is cut:
 * long entries wrap (at " / ", ", " or spaces), the type shrinks when there are many lines, and the card
 * stays up longer for more text. Returns its length in seconds. Footage under CC BY / BY-SA must be
 * attributed in the video itself, not only in the description.
 */
export async function creditsCard(out: string, entries: string[], size: FrameSpec): Promise<number> {
  const { width: W, height: H, fps } = size;
  const esc = (t: string) => t.replace(/\\/g, '＼').replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝'));
  // Width of a line in font-size units: CJK characters are about 1, Latin about 0.55.
  const units = (t: string) => [...t].reduce((a, c) => a + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 1 : 0.55), 0);
  const wrap = (t: string, max: number) => {
    const out: string[] = [];
    let line = '';
    for (const piece of t.split(/(?<=\s\/\s|,\s|，|\s)/)) {
      if (line && units(line + piece) > max) { out.push(line.trim()); line = ''; }
      // A single piece longer than the line is split by characters.
      let p = piece;
      while (units(p) > max) {
        let k = p.length;
        while (k > 1 && units(p.slice(0, k)) > max) k--;
        out.push(p.slice(0, k));
        p = p.slice(k);
      }
      line += p;
    }
    if (line.trim()) out.push(line.trim());
    return out;
  };
  let fs = Math.round(Math.min(W, H) * 0.045);
  let lines: string[] = [];
  for (; fs >= 12; fs -= 2) {
    const max = (W - 80) / fs;
    // A licence in brackets stays in one piece: on the last line if it fits, else on its own.
    lines = entries.flatMap((t) => {
      const m = /^(.*?)\s*(（[^）]*）)$/.exec(t);
      if (!m) return wrap(t, max);
      const body = wrap(m[1]!, max);
      const last = body.at(-1) ?? '';
      if (units(last + m[2]) <= max) return [...body.slice(0, -1), last + m[2]];
      return [...body, ...wrap(m[2]!, max)];
    });
    if (lines.length * fs * 1.6 + fs * 3 <= H * 0.8) break;
  }
  const seconds = Math.min(8, 4 + Math.max(0, Math.ceil((lines.length - 4) / 3)));
  const top = Math.round((H - (fs * 1.3 * 2 + lines.length * fs * 1.6)) / 2);
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Head,Noto Sans CJK SC,${Math.round(fs * 1.3)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,8,40,40,0,1`,
    `Style: Line,Noto Sans CJK SC,${fs},&H00D8DCE4,&H00D8DCE4,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,40,40,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.20,9:00:00.00,Head,,0,0,0,,{\\pos(${W / 2},${top})\\fad(300,0)}画面来源`,
    ...lines.map((l, i) => `Dialogue: 0,0:00:00.40,9:00:00.00,Line,,0,0,0,,{\\pos(${W / 2},${Math.round(top + fs * 1.3 * 2 + i * fs * 1.6)})\\fad(300,0)}${esc(l)}`),
    '',
  ].join('\n');
  const assFile = `${out}.ass`;
  await writeFile(assFile, ass);
  try {
    await atomicOutput(out, (tmp) => ffmpeg([
      '-f', 'lavfi', '-i', `color=c=0x1B2335:s=${W}x${H}:r=${fps}:d=${seconds}`,
      '-vf', `ass=${assFile.replace(/[\\:']/g, (c) => `\\${c}`)}`, '-t', String(seconds), ...ENCODE, '-an', '-f', 'mp4', tmp,
    ]));
  } finally {
    await rm(assFile, { force: true });
  }
  return seconds;
}
