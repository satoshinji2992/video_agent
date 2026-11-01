// Checks on a finished version before it reaches the user: is there sound, is every voiceover line read as
// written (nothing skipped, no acronym spelled out letter by letter), and are there stretches of black.
import { spawn } from 'node:child_process';
import type { Shot } from './project.ts';
import { createLimiter } from '../core/limiter.ts';
import { listenAnyLanguage, transcribe } from '../providers/transcribe.ts';

/**
 * ffmpeg's log (stderr) for a run, read without blocking the server: these checks decode whole videos, and a
 * synchronous child process would freeze every other conversation meanwhile. Killed after `timeoutMs`;
 * whatever was logged by then is returned.
 */
function ffLog(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    p.stderr.on('data', (d) => { if (log.length < 16 << 20) log += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => { clearTimeout(timer); resolve(log); });
    p.on('close', () => { clearTimeout(timer); resolve(log); });
  });
}

function parseLoudness(log: string) {
  const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/i.exec(log);
  if (!m) return null;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

/** Integrated loudness in LUFS (-Infinity for silence), or null when it cannot be measured. */
export async function measureLoudness(file: string): Promise<number | null> {
  return parseLoudness(await ffLog(['-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], 300_000));
}

/** Stretches of (near) black of at least `min` seconds, as [start, end]. */
export async function blackSegments(file: string, min = 0.5): Promise<Array<[number, number]>> {
  const log = await ffLog(['-i', file, '-vf', `blackdetect=d=${min}:pix_th=0.10`, '-an', '-f', 'null', '-'], 300_000);
  // blackdetect counts a dark scene with a small bright subject (an asteroid against space) as black; a
  // stretch only counts when its middle frame has no clearly lit pixel either.
  const found = [...log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of found) if (await brightest(file, (a + b) / 2) < 60) out.push([a, b]);
  return out;
}

/**
 * The brightest luma (0-255) in the picture area of the frame at `t` seconds: the top caption and corner
 * label band and the bottom subtitle band are left out, since burned-in text is lit even over black.
 */
async function brightest(file: string, t: number): Promise<number> {
  const log = await ffLog(['-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'crop=iw:ih*0.58:0:ih*0.16,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YMAX', '-f', 'null', '-'], 20_000);
  return Number(/YMAX=(\d+)/.exec(log)?.[1] ?? 0);
}

/**
 * How lit a clip's opening is, over two frames a second of its first `seconds`: the average luma (0-255) and
 * the share of the picture that is clearly lit (luma 110 and up). A dim hook, or one whose subject is a speck,
 * loses the viewer before the first word. The caption and subtitle bands are left out.
 */
export function openingLight(file: string, seconds = 4): Promise<{ mean: number; lit: number } | null> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-t', String(seconds), '-protocol_whitelist', 'file,pipe', '-i', file,
      '-vf', 'fps=2,crop=iw:ih*0.58:0:ih*0.16,scale=96:96,format=gray', '-an', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let sum = 0, lit = 0, n = 0;
    p.stdout.on('data', (d: Buffer) => { for (const v of d) { sum += v; if (v >= 110) lit++; n++; } });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); resolve(n ? { mean: sum / n, lit: lit / n } : null); });
  });
}

/** Characters that carry the words: Chinese characters, or lowercase latin letters and digits. */
// Numbers are left out on both sides: whisper writes "三十" as "30" and "两千九百九十九" as "2999".
const essence = (s: string, cjk: boolean) => (cjk
  ? (s.replace(/[零〇一二两三四五六七八九十百千万亿]/g, '').match(/[㐀-鿿]/g) ?? [])
  : (s.toLowerCase().match(/[a-z]/g) ?? []));

/** Share of the expected characters heard, in order (longest common subsequence over the expected length). */
export function heardShare(expected: string, heard: string) {
  const cjk = /[㐀-鿿]/.test(expected);
  const a = essence(expected, cjk), b = essence(heard, cjk);
  if (!a.length) return 1;
  let prev = new Array(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = x === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** An acronym heard as separate letters ("D-A-R-T", "D A R T"). */
export function spelledOut(acronym: string, heard: string) {
  const letters = [...acronym].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(letters.join('[\\s.\\-·,，、]+'), 'i').test(heard);
}

export interface VoiceIssue { shotId: string; brief: string; kind: 'misread' | 'spelled'; expected: string; heard: string }

/**
 * Listens to every voiceover line (each transcribed once and cached) and compares it with what it should
 * say. `book` is called for each new transcription, with its length in seconds.
 */
export async function listenToVoiceovers(shots: Shot[], path: (rel: string) => string, book: (seconds: number) => void): Promise<VoiceIssue[]> {
  const issues: VoiceIssue[] = [];
  // Lines are transcribed a few at a time (one after another, eleven lines took a minute and more).
  const limit = createLimiter(4);
  const heardOf = new Map<string, string>();
  await Promise.all(shots.filter((s) => s.vo?.trim() && s.voFile).map((s) => limit(async () => {
    try {
      const zh = /[㐀-鿿]/.test(s.vo!);
      const r = await transcribe(path(s.voFile!), zh ? 'zh' : 'en');
      if (r.fresh) book(r.seconds);
      let heard = r.lines.map((x) => x.text).join('');
      // Which language the line was spoken in is judged on listens where whisper picks the language itself:
      // told "zh" it returns English speech as a Chinese translation, and now and then a Chinese line as an
      // English one. Left to itself it keeps English speech English every time and translates a Chinese line
      // about half the time, so up to five such listens are taken and one in Chinese settles it. The words
      // are then compared with the closest Chinese hearing.
      if (zh) {
        const chinese = /[㐀-鿿]/.test(heard) ? [heard] : [];
        let other = '';
        let spokenChinese = false;
        for (let k = 0; k < 5 && !spokenChinese; k++) {
          const x = await listenAnyLanguage(path(s.voFile!));
          if (!x?.text) continue;
          book(x.seconds);
          if (/[㐀-鿿]/.test(x.text)) { spokenChinese = true; chinese.push(x.text); } else other ||= x.text;
        }
        const expected = (s.voTts?.trim() || s.vo!).trim();
        if (spokenChinese) heard = chinese.reduce((a, b) => (Math.max(heardShare(s.vo!, b), heardShare(expected, b)) > Math.max(heardShare(s.vo!, a), heardShare(expected, a)) ? b : a));
        else if (other) heard = other;
      }
      heardOf.set(s.id, heard);
    } catch {
      // listening is best effort; a failed transcription is not a finding
    }
  })));
  for (const s of shots) {
    if (!s.vo?.trim() || !s.voFile) continue;
    const heard = heardOf.get(s.id) ?? '';
    if (!heard) continue;
    const spoken = (s.voTts?.trim() || s.vo).trim();
    // Either written form may be what whisper writes back (the acronym, or how it was spelled out for the voice).
    const share = Math.max(heardShare(s.vo, heard), s.voTts?.trim() ? heardShare(s.voTts, heard) : 0);
    const cjk = /[㐀-鿿]/.test(spoken);
    // Very short lines say too little to judge.
    if (essence(spoken, cjk).length >= 4 && share < 0.8) issues.push({ shotId: s.id, brief: s.brief, kind: 'misread', expected: spoken, heard });
    if (!s.voTts?.trim() && /[㐀-鿿]/.test(s.vo)) {
      for (const a of s.vo.match(/\b[A-Z]{2,6}\b/g) ?? []) {
        if (spelledOut(a, heard)) issues.push({ shotId: s.id, brief: s.brief, kind: 'spelled', expected: a, heard });
      }
    }
  }
  return issues;
}

/**
 * How long a clip opens on pure black (a slate, a fade-in from nothing), in seconds: up to the first frame
 * whose brightest pixel is clearly lit. Unlike blackdetect, a dark scene with a small bright subject (an
 * asteroid against space) is not black. Looks at the first 30 s.
 */
export async function leadingBlack(file: string): Promise<number> {
  const log = await ffLog(['-t', '30', '-protocol_whitelist', 'file,pipe', '-i', file, '-vf', 'scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YMAX', '-an', '-f', 'null', '-'], 60_000);
  let t = 0;
  for (const m of log.matchAll(/pts_time:([\d.]+)[\s\S]*?YMAX=(\d+)/g)) {
    t = Number(m[1]);
    if (Number(m[2]) >= 60) return t;
  }
  return 0;
}
