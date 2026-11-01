// What people say on camera in shots generated with their own sound, with timings, so the subtitles follow
// the actual speech. The spoken words only exist inside the Seedance prompt; transcribing the finished clip
// gives the real wording and when each sentence is said. Results are cached next to the clip.
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { relay, relayReady } from '../core/config.ts';
import { ffmpeg, hasAudio } from '../core/ffmpeg.ts';

/** Chinese lines get Chinese punctuation (whisper often returns ASCII commas and question marks). */
const FULL: Record<string, string> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
/** Only marks touching a Chinese character change, so 1,999, 3:30 and URLs stay as they are. */
export const fullWidth = (s: string) => s
  .replace(/([㐀-鿿])\s*([,?!:;])\s*/g, (_, c: string, p: string) => c + FULL[p])
  .replace(/([,?!:;])\s*(?=[㐀-鿿])/g, (_, p: string) => FULL[p]!);

/** The lines a generation prompt asks someone to say: the quoted parts. */
export const spokenLines = (prompt: string) => [...prompt.matchAll(/(?<![\p{L}\p{N}])"([^"]+)"|“([^”]+)”|「([^」]+)」/gu)]
  .map((m) => (m[1] ?? m[2] ?? m[3])!.trim()).filter(Boolean).join(' ');

export interface SpeechLine { start: number; end: number; text: string }

/** Whisper is billed per minute of audio. */
export const TRANSCRIBE_USD_PER_MIN = 0.006;

// Whisper's well-known inventions on music or silence: whole stock phrases, so a presenter really saying
// "记得点赞关注" keeps the line; the bare words only count against a segment whisper itself doubts.
const HALLUCINATION = /请不吝点赞|請不吝點贊|点赞.{0,4}订阅.{0,4}(转发|打赏)|字幕(由|提供|志愿者|製作|制作)|Amara\.org|谢谢观看|謝謝觀看|明镜与点点|Thanks for watching|Thank you (so much )?for watching|感谢观看|感谢收看|谢谢收看|请订阅|欢迎订阅|please subscribe/i;
const DOUBTFUL = /字幕|订阅|訂閱|点赞|點贊|打赏|subscribe/i;

/**
 * The speech in `clip` as timed lines, or [] when nobody speaks. Cached in `<clip>.speech.json`; `fresh`
 * tells the caller whether this call went to the provider (and should be booked).
 */
export async function transcribe(clip: string, language?: 'zh' | 'en'): Promise<{ lines: SpeechLine[]; fresh: boolean; seconds: number }> {
  const cache = clip.replace(/\.mp4$/, '') + (language ? `.${language}` : '') + '.speech.json';
  if (existsSync(cache)) {
    try { return { lines: JSON.parse(readFileSync(cache, 'utf8')) as SpeechLine[], fresh: false, seconds: 0 }; } catch { /* redo */ }
  }
  if (!relayReady() || !hasAudio(clip)) return { lines: [], fresh: false, seconds: 0 };
  const mp3 = cache.replace(/\.json$/, '.mp3');
  const hintFile = clip.replace(/\.mp4$/, '') + '.prompt.txt';
  await ffmpeg(['-i', clip, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-q:a', '6', mp3]);
  try {
    const form = new FormData();
    form.append('file', new Blob([await readFile(mp3)], { type: 'audio/mpeg' }), 'speech.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    // Left to itself, whisper sometimes takes a Chinese line for English and returns a translation.
    if (language) form.append('language', language);
    // Steers Chinese towards simplified characters with punctuation (English speech stays English), and
    // the generation prompt, which holds the line the person was asked to say, fixes names and rare words.
    // Only the quoted words: the English scene description around them makes whisper describe the scene.
    const asked = existsSync(hintFile) ? spokenLines(readFileSync(hintFile, 'utf8')).slice(0, 400) : '';
    form.append('prompt', `以下是普通话的句子，使用简体中文和标点。${asked}`);
    const res = await fetch(`${relay.url}/v1/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${relay.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`转写失败（${res.status}）：${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = (await res.json()) as { duration?: number; segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[] };
    const lines = (j.segments ?? [])
      .filter((s) => !((s.no_speech_prob ?? 0) > 0.5 && (s.avg_logprob ?? 0) < -0.7))
      .filter((s) => !(DOUBTFUL.test(s.text) && ((s.no_speech_prob ?? 0) > 0.3 || (s.avg_logprob ?? 0) < -0.5)))
      .map((s) => ({ start: Math.max(0, s.start), end: s.end, text: fullWidth(s.text.trim()) }))
      .filter((s) => s.text && s.end > s.start && !HALLUCINATION.test(s.text));
    await writeFile(cache, JSON.stringify(lines));
    return { lines, fresh: true, seconds: j.duration ?? 0 };
  } finally {
    await rm(mp3, { force: true });
  }
}

/**
 * One uncached listen with whisper choosing the language itself (no language, no prompt): the text and the
 * audio length, or null when the call fails. Told a language, whisper also turns speech in another language
 * into a translation; left to itself it hands back English speech as English every time, though it now and
 * then translates Chinese speech too. So this is the listen that can tell which language was spoken.
 */
export async function listenAnyLanguage(file: string): Promise<{ text: string; seconds: number } | null> {
  if (!relayReady()) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([await readFile(file)], { type: file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4' }), file.endsWith('.mp3') ? 'speech.mp3' : 'speech.m4a');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    const res = await fetch(`${relay.url}/v1/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${relay.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { text?: string; duration?: number };
    return { text: String(j.text ?? '').trim(), seconds: j.duration ?? 0 };
  } catch {
    return null;
  }
}
