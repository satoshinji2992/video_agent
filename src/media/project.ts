import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Aspect } from '../core/config.ts';
import type { SpeechLine } from '../providers/transcribe.ts';

/**
 * code = HTML animation; 3d = three.js scene rendered the same way; seedance = AI-generated realistic footage;
 * image = a still with a camera move; footage = a real video clip (archive footage found with find_footage).
 */
export type ShotKind = 'code' | '3d' | 'seedance' | 'image' | 'footage' | 'clip';
export const isCodeKind = (k: ShotKind) => k === 'code' || k === '3d';
export type ShotStatus = 'planned' | 'working' | 'ready' | 'failed';

export interface Shot {
  id: string;
  seconds: number;
  kind: ShotKind;
  brief: string;
  caption?: string;
  /** Hash of the inputs that produced clipFile; a shot is reusable while its inputs are unchanged. */
  inputHash?: string;
  clipFile?: string;
  thumbFile?: string;
  status: ShotStatus;
  error?: string;
  /** Set once a paid Seedance generation was submitted for this shot; a redo then needs the user's consent. */
  generatedOnce?: boolean;
  /** The script segment this shot belongs to. */
  segment?: string;
  /** Voiceover spoken during this shot, its audio file and length. */
  vo?: string;
  voFile?: string;
  /** How the voice reads vo when that differs from the written line (the subtitle keeps vo). */
  voTts?: string;
  voSeconds?: number;
  /** Realistic shot generated with its own synced sound (speech on camera, ambience); kept in the mix. */
  audio?: boolean;
  /**
   * Where the shot goes. main (default): in sequence. broll: full-frame cutaway over a main shot (its sound
   * keeps playing, e.g. a presenter's A-roll). pip: small window over a main shot. source: only material for
   * another shot's split screen.
   */
  role?: 'main' | 'broll' | 'pip' | 'source';
  /** broll/pip: the main shot it sits on, and when it starts within that shot (seconds). */
  over?: string;
  at?: number;
  /** pip window: position and width as fractions of the frame, plus looks. */
  rect?: { x: number; y: number; w: number };
  radius?: number;
  border?: boolean;
  /** broll/pip: how the layer comes in and goes out (fade, wipe*, slide*). */
  enter?: { type: string; duration: number };
  exit?: { type: string; duration: number };
  /** main: transition from the previous main shot into this one. */
  transition?: { type: string; duration: number };
  /** main: shown side by side (or stacked) with a source shot. */
  split?: { with: string; layout: 'lr' | 'tb' };
  /** image shots: the still in assets/ and its camera move. */
  image?: string;
  move?: string;
  /** image shots: 'cover' fills the frame (cropping), 'contain' shows the whole picture on a background. */
  fit?: 'cover' | 'contain';
  /** footage shots: the video in assets/ and where in it the shot starts (seconds). */
  footage?: string;
  from?: number;
  /**
   * clip shots (the user's own footage): the media item, where in it the shot starts, playback speed,
   * reverse, framing offset (-1..1 on each axis when the frame shape differs), colour preset, and how loud
   * its own sound plays (0 = muted).
   */
  media?: string;
  in?: number;
  speed?: number;
  reverse?: boolean;
  reframe?: { x: number; y: number };
  grade?: string;
  keepAudio?: number;
  /** Voiceover speed for this line (0.8–1.25, 1 = normal), passed to the voice service. */
  voSpeed?: number;
  /** Clip shots: steady the footage (set automatically when the stretch used was flagged 手抖). */
  stabilize?: boolean;
}

export const isMain = (s: Pick<Shot, 'role'>) => !s.role || s.role === 'main';

/** Voice directions the TTS reads but nobody should see: pause marks ("<#0.3#>") and interjection tags. */
const VOICE_MARKS = /<#\s*\d+(?:\.\d+)?\s*#>|\((?:laughs?|chuckles?|coughs?|clear-throat|clears throat|groans?|breath|breathes|pant|inhales?|exhales?|gasps?|sniffs?|sighs?|snorts?|burps?|lip-smacking|humming|hissing|emm|sneezes?)\)/gi;
export const hasVoiceMarks = (text: string) => new RegExp(VOICE_MARKS.source, 'i').test(text);
/** Text as shown (script card, subtitles, chat): the voice directions taken out, spacing tidied. */
export const forDisplay = (text: string) => text.replace(VOICE_MARKS, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？、；：,.!?;:])/g, '$1').replace(/([㐀-鿿，。！？、；：])[ \t]+(?=[㐀-鿿])/g, '$1').trim();

export interface ScriptSegment {
  id: string;
  start: number;
  end: number;
  role: string;
  visual: string;
  vo?: string;
  /** The line as spoken, when it carries voice directions (pause marks); vo is then the shown text. */
  vo_tts?: string;
  caption?: string;
  kind_hint?: string;
}
export interface Script {
  version: number;
  title: string;
  aspect: string;
  total_seconds: number;
  vo_language: string;
  style: string;
  insight: string;
  segments: ScriptSegment[];
  sources: Array<{ title: string; url: string }>;
  changed: string[];
}

export interface Version {
  n: number;
  file: string;
  createdAt: string;
  seconds: number;
  shots: Array<Pick<Shot, 'id' | 'kind' | 'seconds' | 'caption' | 'inputHash'>>;
}

export interface Project {
  title: string;
  aspect: Aspect;
  subtitles: boolean;
  /** The latest script shown to the user, if this video went through one. */
  script?: Script;
  /** One line of shared look (palette, type, motion) fixed with the plan, so shots can be written one at a time. */
  style?: string;
  /**
   * A small source label in a corner of every shot ("NASA/JHU-APL", "AI 生成画面", "示意动画"). Unset = on
   * whenever the video uses real footage.
   */
  sourceLabels?: boolean;
  /** The length asked for (or planned), in seconds: a version much longer than this is not delivered. */
  targetSeconds?: number;
  /** The voiceover voice chosen for this video's tone (a VOICE_CATALOG key); unset = the settings' default. */
  voice?: string;
  shots: Shot[];
  versions: Version[];
}

export const hashInputs = (...parts: unknown[]) =>
  createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

export class ProjectStore {
  readonly dir: string;
  project: Project = { title: '', aspect: '9:16', subtitles: true, shots: [], versions: [] };

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  path(...p: string[]) {
    return join(this.dir, ...p);
  }

  async init() {
    for (const d of ['assets', 'clips', 'shots', 'versions']) await mkdir(this.path(d), { recursive: true });
    if (existsSync(this.path('project.json'))) this.project = JSON.parse(await readFile(this.path('project.json'), 'utf8'));
  }

  async save() {
    await writeFile(this.path('project.json'), JSON.stringify(this.project, null, 2));
  }

  shot(id: string) {
    const s = this.project.shots.find((x) => x.id === id);
    if (!s) throw new Error(`没有 id 为 ${id} 的镜头。当前镜头：${this.project.shots.map((x) => x.id).join(', ') || '无'}`);
    return s;
  }

  totalSeconds() {
    // Cutaways, windows and split-screen material play on top of main shots and add no time.
    return this.project.shots.filter(isMain).reduce((a, s) => a + s.seconds, 0);
  }
}

const assTime = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};

const PUNCT = /[，、。！？；：…）”」]/;
const words = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * A Chinese line longer than `max` characters, split into even lines. Breaks go after punctuation when one
 * is near the even split, else between words, never inside one.
 */
export function wrapCjk(text: string, max: number): string {
  const chars = [...text];
  if (!/[㐀-鿿]/.test(text) || chars.length <= max) return text;
  const out: string[] = [];
  let rest = chars;
  for (let k = Math.ceil(chars.length / max); k > 1 && rest.length > max; k--) {
    const even = Math.ceil(rest.length / k);
    const bounds = new Set<number>();
    let at = 0;
    for (const w of words.segment(rest.join(''))) { at += [...w.segment].length; bounds.add(at); }
    // A cut must leave a remainder the lines still to come can hold.
    const ok = (c: number) => c > 0 && c <= max && c < rest.length && rest.length - c <= (k - 1) * max;
    const near = [0, 1, -1, 2, -2, 3, -3].map((d) => even + d).filter(ok);
    const cut = near.find((c) => PUNCT.test(rest[c - 1]!)) ?? near.find((c) => bounds.has(c)) ?? Math.min(even, max);
    out.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  out.push(rest.join(''));
  return out.join('\n');
}

/** Readable pieces of a subtitle line: sentences, and long sentences cut at commas, about 16 characters each. */
export function splitSentences(line: string): string[] {
  if (!line) return [];
  // About 16 Chinese characters fit a line; English words are narrower and longer.
  const cjk = /[㐀-鿿]/.test(line);
  const max = cjk ? 16 : 42;
  if (line.length <= max) return [line];
  // Clauses end at Chinese or English punctuation; an English full stop only before a space or the end (not
  // in 1.5); punctuation at the very start stays with the first clause.
  const clauses = line.match(/[。！？!?；;…，,、]*(?:[^。！？!?；;…，,、.]|\.(?!\s|$))+(?:[。！？!?；;…，,、]+|\.(?=\s|$))*["”」]?\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [line];
  const out: string[] = [];
  let ended = true;
  for (const c of clauses) {
    const last = out.at(-1);
    // Clauses join the current line while it stays short and has not ended a sentence; scraps under 5
    // characters join too, since they are too short to read on their own, as long as the line stays near max.
    if (last !== undefined && ((c.length < 5 && last.length + c.length <= max + 4) || (!ended && last.length + c.length <= max))) out[out.length - 1] = last + (cjk ? '' : ' ') + c;
    else out.push(c);
    ended = /[。！？!?；;….]["”」]?$/.test(c);
  }
  // A comma at the end of a subtitle line reads as a typo.
  return out.map((x) => x.replace(/[，,、]$/, ''));
}

/**
 * Whether a subtitle piece is already written on screen: most of its characters (Chinese characters, or
 * Latin letters and digits), in order, appear in the shot's own text. "那是人类第一次，站在另一个世界" under a
 * card reading "人类第一次 踏上另一个世界" is.
 */
export function shownOnScreen(piece: string, screen: string) {
  const chars = (x: string) => (/[㐀-鿿]/.test(piece) ? x.match(/[㐀-鿿0-9]/g) : x.toLowerCase().match(/[a-z0-9]/g)) ?? [];
  const a = chars(piece), b = chars(screen);
  if (a.length < 4 || !b.length) return false;
  let prev = new Array(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = x === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length] / a.length >= 0.6;
}

/**
 * `speech`: what is said on camera in shots with their own sound, timed within each shot (by shot id).
 * `onScreen`: the text a shot already shows (a code shot's cards and titles, by shot id); subtitle pieces
 * that repeat it are left out, so a closing card is not read twice on screen.
 */
export function buildAss(project: Project, width: number, height: number, speech = new Map<string, SpeechLine[]>(), badges: Array<{ start: number; end: number; text: string }> = [], onScreen = new Map<string, string>()): string | null {
  let t = 0;
  const lines: string[] = [];
  const fontSize = Math.round(Math.min(width, height) * 0.095);
  // libass only wraps at spaces, so a long Chinese line runs off both edges; it is broken by hand into
  // even lines. A Chinese character is about 0.6 of the font size wide here.
  const perLine = (style: string) => Math.max(6, Math.floor(((width - 48) * 0.88) / (fontSize * (style === 'Top' ? 0.85 : 1) * 0.6)));
  // Text is shown as written: braces would start ASS override blocks and backslashes escapes (\N, \h).
  const plain = (text: string) => text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝');
  const say = (style: string, from: number, to: number, text: string) => {
    if (to - from < 0.15) return;
    text = forDisplay(text);
    if (!text) return;
    lines.push(`Dialogue: 0,${assTime(from)},${assTime(to)},${style},,0,0,0,,${wrapCjk(plain(text).replace(/。$/, ''), perLine(style)).replace(/\n/g, '\\N')}`);
  };
  // A long line (a presenter talking for 10 s) is shown sentence by sentence, each for a share of its span
  // proportional to its length, so the subtitle follows the speech instead of hanging for the whole shot.
  // A piece that would get under 0.6 s is merged into its neighbour, so nothing just flashes.
  const spread = (style: string, line: string, from: number, span: number, until: number, screen = '') => {
    // Pieces lost their trailing comma in splitSentences; a merge puts it back.
    const cjk = /[㐀-鿿]/.test(line);
    const join = (a: string, b: string) => a + (/[。！？!?；;….]["”」]?$/.test(a) ? (cjk ? '' : ' ') : cjk ? '，' : ', ') + b;
    const parts = splitSentences(line);
    const share = (p: string) => (span * p.length) / parts.reduce((a, x) => a + x.length, 0);
    while (parts.length > 1) {
      const i = parts.reduce((m, p, k) => (share(p) < share(parts[m]!) ? k : m), 0);
      if (share(parts[i]!) >= 0.6) break;
      const j = i === 0 ? 1 : i === parts.length - 1 || share(parts[i - 1]!) <= share(parts[i + 1]!) ? i - 1 : i + 1;
      const [a, b] = [Math.min(i, j), Math.max(i, j)];
      parts.splice(a, 2, join(parts[a]!, parts[b]!));
    }
    let at = from;
    for (const part of parts) {
      const d = share(part);
      if (!shownOnScreen(part, screen)) say(style, at + Math.min(0.1, d * 0.15), Math.min(until, at + d - 0.05), part);
      at += d;
    }
  };
  for (const b of badges) say('Badge', b.start + 0.05, b.end - 0.05, b.text);
  for (const s of project.subtitles ? project.shots.filter(isMain) : []) {
    const end = t + s.seconds - 0.05;
    // A shot with its own voiceover is subtitled with the voiceover; the transcript is for on-camera speech.
    const spoken = s.vo?.trim() ? [] : (speech.get(s.id) ?? []).filter((x) => Math.min(x.end, s.seconds) - Math.max(0, x.start) >= 0.3);
    if (spoken.length) {
      // Someone speaks on camera: their words at the bottom, timed to the speech; the script caption (a POV
      // line, a title) moves to the top for the whole shot.
      for (const x of spoken) spread('Cap', x.text, t + Math.max(0, x.start - 0.1), Math.min(x.end, s.seconds) - Math.max(0, x.start - 0.1), end);
      if (s.caption?.trim()) say('Top', t + 0.1, t + s.seconds - 0.05, s.caption.trim());
    } else {
      // Subtitles default to the script caption, else what the voiceover says.
      const line = forDisplay(s.caption ?? s.vo ?? '');
      if (line) spread('Cap', line, t, s.seconds, end, onScreen.get(s.id));
    }
    t += s.seconds;
  }
  if (!lines.length) return null;
  // About 46 px at 480p in every shape; reviews of the 0.07 size kept finding captions too small to read.
  const outline = Math.max(3, Math.round(fontSize * 0.09));
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${outline},1,2,24,24,${Math.round(height * 0.1)},1`,
    `Style: Badge,Noto Sans CJK SC,${Math.max(14, Math.round(fontSize * 0.4))},&H00FFFFFF,&H00FFFFFF,&H70000000,&H78000000,0,0,0,0,100,100,0,0,3,${Math.max(2, Math.round(fontSize * 0.08))},0,9,${Math.round(width * 0.03)},${Math.round(width * 0.03)},${Math.round(height * 0.025)},1`,
    `Style: Top,Noto Sans CJK SC,${Math.round(fontSize * 0.85)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${outline},1,8,24,24,${Math.round(height * 0.08)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines, '',
  ].join('\n');
}
