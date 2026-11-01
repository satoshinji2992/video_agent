// Voiceover lines through the relay's OpenAI-style speech endpoint (MiniMax speech-2.8-hd). Without a relay
// a stand-in tone of the length the line would take is written instead, so timing and mixing still work.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { relay, relayReady, tts, VOICE_CATALOG, VOICES } from '../core/config.ts';
import { atomicOutput, ffmpeg, probeDuration } from '../core/ffmpeg.ts';
import { settings } from '../core/settings.ts';

export const hasCjk = (s: string) => /[㐀-鿿]/.test(s);

/**
 * The voice id for a line: the video's own voice (a VOICE_CATALOG key chosen for its tone) when it speaks the
 * line's language, else the configured Chinese or English default.
 */
export function voiceFor(text: string, lang?: string, chosen?: string): string {
  const s = settings.get();
  const zh = lang ? lang.startsWith('zh') : hasCjk(text);
  const pick = chosen ? VOICE_CATALOG[chosen] : undefined;
  if (pick && (pick.lang === 'zh') === zh) return pick.id;
  return (VOICES[zh ? s.voiceZh : s.voiceEn] ?? VOICES[zh ? 'zh_gentle_m' : 'en_trust_m'])!.id;
}

/** Pause marks in the spoken form ("<#0.5#>", seconds) are read as silences; they are never shown. */
export const stripPauses = (text: string) => text.replace(/<#\d+(?:\.\d+)?#>/g, '');

/** Rough speaking time: about 4.5 Chinese characters or 2.6 English words per second, plus marked pauses. */
export function estimateSeconds(text: string) {
  const pauses = [...text.matchAll(/<#(\d+(?:\.\d+)?)#>/g)].reduce((a, m) => a + Number(m[1]), 0);
  text = stripPauses(text);
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const words = text.replace(/[㐀-鿿]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, cjk / 4.5 + words / 2.6 + pauses);
}

/** The speech endpoint answers with the audio itself, or JSON carrying it as hex or a download URL. */
async function audioBytes(res: Response): Promise<Buffer> {
  if (!(res.headers.get('content-type') ?? '').includes('json')) return Buffer.from(await res.arrayBuffer());
  const j = (await res.json()) as { data?: { audio?: string; url?: string }; audio?: string; url?: string };
  const hex = j.data?.audio ?? j.audio;
  if (hex && /^[0-9a-f]+$/i.test(hex)) return Buffer.from(hex, 'hex');
  const url = j.data?.url ?? j.url ?? (hex && /^https?:/.test(hex) ? hex : undefined);
  if (url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('配音返回里没有音频');
}

export const ttsEstimateUsd = (text: string) => (text.length / 1000) * tts.usdPer1kChars;

/**
 * Speaks `text` (pause marks allowed) with voice `voiceId` into outPath (mp3). `speed` (0.5–2, 1 = normal) is
 * the relay's top-level speed parameter: MiniMax reads faster or slower, rather than the audio being
 * stretched afterwards. Returns its length and whether it was a stand-in.
 */
export async function speak(text: string, voiceId: string, outPath: string, opts: { speed?: number } = {}): Promise<{ seconds: number; mock: boolean }> {
  const speed = Math.min(2, Math.max(0.5, opts.speed ?? 1));
  if (!relayReady()) {
    const seconds = estimateSeconds(text) / speed;
    // A quiet, wavering tone so the mix (and the music ducking under it) can be checked by ear.
    await atomicOutput(outPath, (out) => ffmpeg([
      '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds.toFixed(2)}`,
      '-af', 'tremolo=f=5:d=0.7,volume=0.35', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '6', '-f', 'mp3', out,
    ]));
    return { seconds: probeDuration(outPath), mock: true };
  }
  const res = await fetch(`${relay.url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.apiKey}` },
    // No response_format: the relay maps it onto MiniMax's output_format, which only takes hex or url.
    body: JSON.stringify({ model: tts.model, input: text, voice: voiceId, ...(Math.abs(speed - 1) > 0.01 ? { speed } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`配音失败（${res.status}）：${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await audioBytes(res);
  await atomicOutput(outPath, (out) => writeFile(out, data));
  return { seconds: probeDuration(outPath), mock: false };
}

/** Silence between lines of a take: marked with a pause this long, so the cuts are found reliably. */
export const LINE_PAUSE = 0.7;

/**
 * The pauses between the lines of a take of `lines` lines spoken in one go (joined with LINE_PAUSE pause
 * marks): its `lines - 1` longest silences, in order, as [start, end] seconds. null when the take does not show
 * that many clear pauses (the caller then speaks the lines one by one). Async: the server must not block on ffmpeg.
 */
export function takeCuts(file: string, lines: number, pause = LINE_PAUSE): Promise<Array<[number, number]> | null> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    p.stderr.on('data', (d) => { if (log.length < 1 << 20) log += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      clearTimeout(timer);
      const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
      const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
      // A silence still open at the end of the file is the take's tail, not a gap between lines.
      const gaps = ends.map((e, i) => ({ start: starts[i]!, end: e })).filter((g) => Number.isFinite(g.start) && g.start > 0.2);
      if (gaps.length < lines - 1) return resolve(null);
      const longest = [...gaps].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, lines - 1);
      // The marked pauses are clearly longer than a comma's breath; a take where they are not is not trusted.
      if (longest.some((g) => g.end - g.start < pause * 0.6)) return resolve(null);
      resolve(longest.sort((a, b) => a.start - b.start).map((g) => [g.start, g.end] as [number, number]));
    });
  });
}
