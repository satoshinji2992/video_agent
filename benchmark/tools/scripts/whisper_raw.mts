// Usage: whisper_raw.mts <clip.mp4>...  Raw Whisper segments (no filtering) with no_speech_prob/avg_logprob.
import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { relay } from '../../../src/core/config.ts';
for (const clip of process.argv.slice(2)) {
  const mp3 = `${new URL('../tmp/', import.meta.url).pathname}${clip.split('/').slice(-2).join('_')}.mp3`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-q:a', '4', mp3]);
  const form = new FormData();
  form.append('file', new Blob([await readFile(mp3)], { type: 'audio/mpeg' }), 'a.mp3');
  form.append('model', process.env.WMODEL ?? 'whisper-1');
  form.append('response_format', process.env.WFMT ?? 'verbose_json');
  if (process.env.WPROMPT) form.append('prompt', process.env.WPROMPT);
  if (process.env.WLANG) form.append('language', process.env.WLANG);
  const res = await fetch(`${relay.url}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${relay.apiKey}` }, body: form, signal: AbortSignal.timeout(90_000) });
  const raw = await res.text(); if (!res.ok || process.env.WFMT) { console.log(clip.split('/').pop(), res.status, raw.slice(0, 400)); continue; }
  const j = JSON.parse(raw) as { language?: string; segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[] };
  console.log(`${clip.split('/').slice(-2).join('/')} [lang=${j.language}]: ` + (j.segments ?? []).map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)} ns=${(s.no_speech_prob ?? 0).toFixed(2)} lp=${(s.avg_logprob ?? 0).toFixed(2)}] ${s.text.trim()}`).join(' | '));
  await rm(mp3, { force: true });
}
