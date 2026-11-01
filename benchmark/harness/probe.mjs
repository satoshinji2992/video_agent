// Connectivity check for the two judges (tiny calls, one small image). Prints models and timings only.
// Usage: node --env-file=<repo>/.env.cc probe.mjs [video-for-frame]
// Claude goes through Claude Code's own login (no ANTHROPIC_* in .env.cc); VAB_JUDGE_A=relay with .env uses the relay.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeJson, claudeJsonCC, extractFrame, geminiJson, P } from './lib.mjs';

const video = process.argv[2];
const schema = { type: 'object', properties: { color: { type: 'string' }, ok: { type: 'boolean' } }, required: ['color', 'ok'], additionalProperties: false };
let img = null;
if (video) {
  const f = await extractFrame(video, 1, join(P.logs, 'probe-frame.jpg'), { label: 'probe t=1.0s' });
  img = readFileSync(f).toString('base64');
}
const ask = img ? '这张图的主色调是什么颜色？用中文一个词回答 color，ok 填 true。' : '天空通常是什么颜色？用中文一个词回答 color，ok 填 true。';

const a = await (process.env.VAB_JUDGE_A === 'relay' ? claudeJson : claudeJsonCC)({
  system: 'You answer in JSON.', effort: 'low', maxTokens: 2000, schema,
  content: [...(img ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } }] : []), { type: 'text', text: ask }],
});
console.log('claude', JSON.stringify({ ok: a.ok, model: a.model, mode: a.mode, data: a.data, ms: a.ms, usage: a.usage, attempts: a.attempts }));

const models = (process.env.GEMINI_MODELS ?? 'gemini-3.5-pro,gemini-3.5-flash').split(',');
for (const m of models) {
  const g = await geminiJson({
    models: [m], system: 'You answer in JSON.', maxTokens: 2000,
    parts: [...(img ? [{ inline_data: { mime_type: 'image/jpeg', data: img } }] : []), { text: `${ask} 输出 JSON：{"color": string, "ok": boolean}` }],
  });
  console.log('gemini', m, JSON.stringify({ ok: g.ok, model: g.model, modelVersion: g.modelVersion, data: g.data, ms: g.ms, tried: g.tried }));
}
