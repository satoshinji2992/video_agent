// Real-API check (dev server): speak one line with each configured voice through the relay.
// Usage: npx tsx scripts/tools/probe-voice.ts
import { mkdirSync } from 'node:fs';
import { relayReady, VOICES, type VoiceKey } from '../../src/core/config.ts';
import { speak } from '../../src/providers/tts.ts';

if (!relayReady()) { console.log('relay not configured (RELAY_URL/RELAY_API_KEY or SEEDANCE_*)'); process.exit(1); }
mkdirSync('data/probe', { recursive: true });
const lines: Record<VoiceKey, string> = {
  zhMale: 'AI 正在改变找矿的方式。', zhFemale: '今天是个特别的日子，祝你生日快乐。',
  enMale: 'A storm hits your street in minutes. Would you know?', enFemale: 'Download NewsBreak. It is free.',
};
for (const [k, text] of Object.entries(lines) as Array<[VoiceKey, string]>) {
  const t0 = Date.now();
  try {
    const r = await speak(text, VOICES[k].id, `data/probe/voice-${k}.mp3`);
    console.log(`${k.padEnd(9)} ${VOICES[k].id.padEnd(24)} ok   ${r.seconds.toFixed(2)}s audio, ${Date.now() - t0} ms -> data/probe/voice-${k}.mp3`);
  } catch (e) {
    console.log(`${k.padEnd(9)} ${VOICES[k].id.padEnd(24)} FAIL ${(e as Error).message}`);
  }
}
