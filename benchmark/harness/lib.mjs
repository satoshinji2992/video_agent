// Shared helpers for the VEdit-Bench style harness (topics, references, driver, judges, guards, report).
// Secrets are read only from process.env, which the caller fills with `node|tsx --env-file=<app>/.env`.
// Nothing in this file prints a key or a relay address.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const SC = dirname(fileURLToPath(import.meta.url));
/** The app's DATA_DIR (sessions/, ledger.jsonl). */
export const DATA_DIR = resolve(process.env.VEVAL_DATA_DIR ?? join(SC, 'data'));
/** The app build under test (read only): used for the app's own research() and nothing else. */
export const APP_DIR = resolve(process.env.VEVAL_APP_DIR ?? join(SC, '..', '..'));
export const BASE = (process.env.BASE ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');

export const P = {
  topics: join(SC, 'topics.json'),
  references: join(SC, 'references'),
  runs: join(SC, 'runs'),
  scores: join(SC, 'scores'),
  guards: join(SC, 'guards'),
  sheets: join(SC, 'sheets'),
  frames: join(SC, 'frames'),
  logs: join(SC, 'logs'),
  notes: join(SC, 'notes'),
};
// Only the folders every script needs; the others are created when something is written into them.
for (const d of [P.runs, P.logs, P.notes]) mkdirSync(d, { recursive: true });

export const sh = promisify(execFile);

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

/** Writes JSON through a temp file so a crash never leaves half a file. */
export function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

export const allTopics = () => readJson(P.topics, []);
/** VideoAgentBench tasks (prompt + revision prompt + hidden evaluation points), driven in two stages. */
export const vabTasks = () => readJson(join(SC, 'vab-tasks.json'), []);
export function topicById(id) {
  const t = allTopics().find((x) => x.id === id) ?? vabTasks().find((x) => x.id === id);
  if (!t) throw new Error(`unknown topic ${id}; known: ${[...allTopics(), ...vabTasks()].map((x) => x.id).join(' ')}`);
  // Pack paths in vab-tasks.json are relative to this folder (benchmark/packs is filled by scripts/fetch-packs.sh).
  for (const k of ['assets', 'evaluator']) if (t[k]) t[k] = resolve(SC, t[k]);
  return t;
}
/** "e1,m2" / "all" / ["e1"] -> topic ids. */
export function topicIds(args) {
  const list = (Array.isArray(args) ? args : [args]).flatMap((a) => String(a).split(/[,\s]+/)).filter(Boolean);
  if (!list.length || list.includes('all')) return allTopics().map((t) => t.id);
  for (const id of list) topicById(id);
  return list;
}

export const sessionDir = (sid) => join(DATA_DIR, 'sessions', sid);

/** Ledger entries for one session, split into Claude and non-Claude (Seedance, TTS, images, search, ...). */
export function ledgerFor(sid, keep = () => true) {
  const file = join(DATA_DIR, 'ledger.jsonl');
  const entries = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.session === sid && keep(e))
    : [];
  const isClaude = (m) => String(m ?? '').startsWith('claude');
  const sum = (xs) => Math.round(xs.reduce((a, e) => a + (Number(e.usd) || 0), 0) * 10000) / 10000;
  const byKind = {};
  for (const e of entries) {
    const k = isClaude(e.model) ? (e.usage === 'opener' ? 'claude_opener' : 'claude_agent') : kindOfItem(e);
    byKind[k] = Math.round(((byKind[k] ?? 0) + (Number(e.usd) || 0)) * 10000) / 10000;
  }
  return {
    entries,
    claudeUsd: sum(entries.filter((e) => isClaude(e.model))),
    claudeAgentUsd: sum(entries.filter((e) => isClaude(e.model) && e.usage !== 'opener')),
    claudeOpenerUsd: sum(entries.filter((e) => isClaude(e.model) && e.usage === 'opener')),
    nonClaudeUsd: sum(entries.filter((e) => !isClaude(e.model))),
    estimatedEntries: entries.filter((e) => e.basis !== 'actual').length,
    byKind,
  };
}

function kindOfItem(e) {
  const m = String(e.model ?? '').toLowerCase();
  const item = String(e.item ?? '');
  if (m.includes('seedance')) return 'seedance';
  if (m.includes('speech') || item.startsWith('配音')) return 'tts';
  if (m.includes('whisper') || item.startsWith('听写')) return 'transcribe';
  if (item.startsWith('查资料') || e.usage === 'search') return 'research';
  if (m.includes('image') || item.includes('出图') || item.includes('图')) return 'image';
  return 'other';
}

export async function probeDuration(file) {
  const { stdout } = await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

export async function probeStreams(file) {
  const { stdout } = await sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  return { duration: Number(j.format?.duration), width: v?.width, height: v?.height, fps: v?.r_frame_rate, audio: j.streams.some((s) => s.codec_type === 'audio') };
}

const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => existsSync(f));

/**
 * One frame at `t` seconds, `width` px wide, with `label` printed on a black strip ABOVE the picture
 * (so the label never covers what is being judged). JPEG unless `out` ends in .png.
 */
export async function extractFrame(video, t, out, { width = 320, label = '' } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const bar = label ? 22 : 0;
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
  const vf = [`scale=${width}:-2:flags=lanczos`];
  if (label) vf.push(`pad=iw:ih+${bar}:0:${bar}:black`, `drawtext=${FONT ? `fontfile=${FONT}:` : ''}text='${esc(label)}':x=6:y=4:fontsize=14:fontcolor=white`);
  await sh('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', vf.join(','), ...(out.endsWith('.png') ? [] : ['-q:v', '3']), out]);
  return out;
}

export const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

/* ------------------------------ model calls ------------------------------ */

/** The relay for non-Claude models, resolved exactly like the app's config.ts `relay` object. */
export function relay() {
  const env = process.env;
  const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const url = (env.RELAY_URL ?? (env.SEEDANCE_BASE_URL ? origin(env.SEEDANCE_BASE_URL) : '')).replace(/\/+$/, '');
  const apiKey = env.RELAY_API_KEY ?? env.SEEDANCE_API_KEY ?? '';
  if (!url || !apiKey) throw new Error('relay not configured: run with --env-file=<app>/.env');
  return { url, apiKey };
}

/** Removes anything that looks like a key or a URL from an error text before it is logged. */
export function scrub(text) {
  let s = String(text ?? '');
  for (const v of [process.env.ANTHROPIC_API_KEY, process.env.SEEDANCE_API_KEY, process.env.RELAY_API_KEY, process.env.ANTHROPIC_BASE_URL, process.env.SEEDANCE_BASE_URL, process.env.RELAY_URL]) {
    if (v && v.length > 6) s = s.split(v).join('<redacted>');
  }
  return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>').replace(/https?:\/\/[^\s"')]+/g, '<url>').slice(0, 2000);
}

export function parseLooseJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return undefined; }
}

let anthropic;
async function anthropicClient() {
  if (anthropic) return anthropic;
  if (!process.env.ANTHROPIC_BASE_URL || !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY missing: run with --env-file=<app>/.env');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The relay documents anthropic-version 2023-06-01; pinning it keeps the request shape the relay knows.
  anthropic = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 20 * 60_000, maxRetries: 2,
    defaultHeaders: process.env.VEVAL_ANTHROPIC_VERSION === 'sdk' ? {} : { 'anthropic-version': process.env.VEVAL_ANTHROPIC_VERSION || '2023-06-01' },
  });
  return anthropic;
}

/** USD per million tokens (Anthropic list price for Opus 5.5; the relay may bill differently). */
const CLAUDE_PRICE = { 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-4-6': [3, 15] };

/**
 * One Claude call through the relay's /v1/messages (streamed), asking for JSON. Tries structured outputs
 * (output_config.format) first; if the relay rejects that field, asks again with the schema in the prompt.
 * content: Anthropic content blocks (text / base64 image).
 */
export async function claudeJson({ model = 'claude-opus-5-5', system, content, schema, effort = 'high', maxTokens = 32000 }) {
  const client = await anthropicClient();
  const t0 = Date.now();
  const attempts = [];
  const modes = process.env.VEVAL_NO_STRUCTURED === '1' ? ['prompt'] : ['structured', 'prompt'];
  for (const mode of modes) {
    for (let retry = 0; retry < 2; retry++) {
      const output_config = { effort, ...(mode === 'structured' ? { format: { type: 'json_schema', schema } } : {}) };
      const extra = mode === 'prompt' ? [{ type: 'text', text: `只输出一个 JSON 对象，符合这个 JSON Schema，不要任何其他文字或代码块标记：\n${JSON.stringify(schema)}` }] : [];
      try {
        const stream = client.messages.stream({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: [...content, ...extra] }], output_config });
        const msg = await stream.finalMessage();
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const usage = msg.usage ?? {};
        const price = CLAUDE_PRICE[model];
        const usd = price ? ((usage.input_tokens ?? 0) * price[0] + (usage.cache_creation_input_tokens ?? 0) * price[0] * 1.25 + (usage.cache_read_input_tokens ?? 0) * price[0] * 0.1 + (usage.output_tokens ?? 0) * price[1]) / 1e6 : null;
        if (msg.stop_reason === 'refusal') {
          attempts.push({ mode, error: `refusal ${JSON.stringify(msg.stop_details ?? null)}` });
          return { ok: false, model: msg.model, mode, stopReason: msg.stop_reason, raw: text, usage, usd, ms: Date.now() - t0, attempts };
        }
        const data = parseLooseJson(text);
        if (data && typeof data === 'object') return { ok: true, data, raw: text, model: msg.model, mode, stopReason: msg.stop_reason, usage, usd, ms: Date.now() - t0, attempts };
        attempts.push({ mode, error: `unparseable output (stop_reason ${msg.stop_reason}, ${text.length} chars)`, head: text.slice(0, 300) });
      } catch (e) {
        const status = e?.status;
        const message = scrub(e?.message ?? e);
        attempts.push({ mode, status, error: message });
        // A 400 on the structured attempt most likely means the relay does not pass output_config.format.
        if (mode === 'structured' && status === 400) break;
        if (status && status < 500 && status !== 429 && status !== 408) break;
      }
    }
  }
  return { ok: false, model, ms: Date.now() - t0, attempts };
}

/**
 * The same JSON call as claudeJson, but through Claude Code (the Agent SDK's CLI) with this machine's own
 * login instead of the relay: the process must run without ANTHROPIC_* variables (start it with the
 * relay-only .env.cc). Mirrors the app's askStructured (src/providers/llm.ts): no tools, structured output.
 */
export async function claudeJsonCC({ model = 'claude-opus-5-5', system, content, schema, effort = 'high', timeoutMs = 20 * 60_000 }) {
  const t0 = Date.now();
  if (Object.keys(process.env).some((k) => k.startsWith('ANTHROPIC_'))) {
    return { ok: false, model, ms: 0, attempts: [{ error: 'ANTHROPIC_* is set: Claude Code would use the relay. Start this process with --env-file=<app>/.env.cc' }] };
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { randomUUID } = await import('node:crypto');
  // A parent Claude Code session's variables would make the child join it; drop them as the app does.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_VERSION$)/.test(k)));
  Object.assign(env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });
  const cwd = join(P.logs, 'cc-cwd');
  mkdirSync(cwd, { recursive: true });
  const msg = { type: 'user', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content } };
  async function* once() { yield msg; }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let data, usd = null, raw = '', error = '', got = '';
  try {
    for await (const m of query({
      prompt: once(),
      options: {
        model, effort, systemPrompt: system, tools: [], allowedTools: [], permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true,
        maxTurns: 4, outputFormat: { type: 'json_schema', schema }, persistSession: false, cwd, env, abortController: abort,
      },
    })) {
      if (m.type === 'system' && m.subtype === 'init') got = m.model;
      if (m.type !== 'result') continue;
      usd = m.total_cost_usd ?? null;
      if (m.subtype === 'success') { raw = m.result ?? ''; data = m.structured_output ?? parseLooseJson(m.result); } else error = m.subtype;
    }
  } catch (e) {
    error = abort.signal.aborted ? 'timed out' : scrub(e?.message ?? e);
  } finally {
    clearTimeout(timer);
  }
  if (data && typeof data === 'object') return { ok: true, data, raw, model: got || model, mode: 'claude-code', usd, ms: Date.now() - t0, attempts: [] };
  return { ok: false, model: got || model, mode: 'claude-code', ms: Date.now() - t0, attempts: [{ error: error || 'no structured output' }] };
}

/** Text of a Gemini response, without thought parts. */
function geminiText(j) {
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
}

/**
 * One Gemini call through the relay's /v1beta generateContent with JSON output. Tries `models` in order
 * (the first that answers wins). parts: Gemini parts (text / inline_data).
 */
export async function geminiJson({ models = ['gemini-3.5-pro', 'gemini-3.5-flash'], system, parts, maxTokens = 32768, timeoutMs = 15 * 60_000 }) {
  const r = relay();
  const t0 = Date.now();
  const tried = [];
  for (const model of models) {
    for (let retry = 0; retry < 2; retry++) {
      const t1 = Date.now();
      try {
        const res = await fetch(`${r.url}/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${r.apiKey}` },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ role: 'user', parts }],
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await res.text();
        if (!res.ok) {
          tried.push({ model, status: res.status, error: scrub(body.slice(0, 400)), ms: Date.now() - t1 });
          if (res.status === 429 || res.status >= 500) continue; // retry the same model once
          break; // 4xx: this model is not available here; next model
        }
        const j = JSON.parse(body);
        const text = geminiText(j);
        const data = parseLooseJson(text);
        if (data && typeof data === 'object') {
          tried.push({ model, status: 200, ms: Date.now() - t1 });
          return { ok: true, data, raw: text, model, modelVersion: j.modelVersion, usage: j.usageMetadata, finishReason: j.candidates?.[0]?.finishReason, ms: Date.now() - t0, tried };
        }
        tried.push({ model, status: 200, error: `unparseable output (finishReason ${j.candidates?.[0]?.finishReason}, ${text.length} chars)`, head: text.slice(0, 300), ms: Date.now() - t1 });
      } catch (e) {
        tried.push({ model, error: scrub(e?.message ?? e), ms: Date.now() - t1 });
      }
    }
  }
  return { ok: false, ms: Date.now() - t0, tried };
}
