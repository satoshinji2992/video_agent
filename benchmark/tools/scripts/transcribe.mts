// Usage: transcribe.mts <clip.mp4> [<clip.mp4> ...]  -- Whisper transcript of on-camera speech (relay
// audio endpoint, not a Claude model). Prints timed lines; caches <clip>.speech.json beside the clip.
import { transcribe } from '../../../src/providers/transcribe.ts';
for (const clip of process.argv.slice(2)) {
  try {
    const r = await transcribe(clip);
    console.log(`${clip.split('/').slice(-2).join('/')}: ${r.lines.map((l) => `[${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join(' | ') || '(no speech)'}`);
  } catch (e) {
    console.log(`${clip}: FAIL ${(e as Error).message}`);
  }
}
