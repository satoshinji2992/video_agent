// One-shot model calls for background jobs (turn reviews, memory upkeep), outside any conversation.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../core/config.ts';

// The SDK replaces the child's env with this object. Inherited CLAUDE_* variables from a parent
// Claude Code session would make the child join that session and override effort.
/**
 * The Claude Code binary, found once. Without it the SDK looks for the binary on every query() and, on Linux,
 * calls process.report.getReport() to tell glibc from musl: a synchronous call that freezes the whole server
 * for ~10 s on machines where listing network interfaces is slow (WSL). Passed to every query().
 */
export const claudeExecutable: string | undefined = (() => {
  const require = createRequire(import.meta.url);
  const variants = process.platform === 'linux' ? [`linux-${process.arch}`, `linux-${process.arch}-musl`] : [`${process.platform}-${process.arch}`];
  for (const v of variants) {
    try {
      const p = require.resolve(`@anthropic-ai/claude-agent-sdk-${v}/claude${process.platform === 'win32' ? '.exe' : ''}`);
      if (existsSync(p)) return p;
    } catch { /* not installed */ }
  }
  return undefined;
})();

export const childEnv: Record<string, string | undefined> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_VERSION$)/.test(k)),
  ),
  // No update checks, telemetry or error reporting from the CLI: on a server these outbound calls only add
  // startup latency (and may stall on networks that block them). VIDEO_AGENT_CLI_TRAFFIC=1 keeps them.
  ...(process.env.VIDEO_AGENT_CLI_TRAFFIC === '1' ? {} : { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }),
};

export interface Img { mime: 'image/png' | 'image/jpeg'; data: Buffer }

/** Asks once for JSON matching `schema`; returns the parsed object and the call's estimated cost. */
/** Thrown when no usable answer came back; carries what the call cost anyway. */
export class AskError extends Error {
  constructor(message: string, readonly costUsd: number) { super(message); }
}

const TIMEOUT_MS = 3 * 60_000;

export async function askStructured<T>(o: { model: string; system: string; text: string; images?: Img[]; schema: Record<string, unknown> }): Promise<{ data: T; costUsd: number }> {
  const content = [
    ...(o.images ?? []).map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mime, data: i.data.toString('base64') } })),
    { type: 'text' as const, text: o.text },
  ];
  const msg = { type: 'user', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content } } as SDKUserMessage;
  async function* once() { yield msg; }
  // Background jobs run one at a time; a stuck call must not hold up every later review.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const q = query({
    prompt: once(),
    options: {
      pathToClaudeCodeExecutable: claudeExecutable,
      model: o.model,
      effort: config.review.effort,
      systemPrompt: o.system,
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 4,
      outputFormat: { type: 'json_schema', schema: o.schema },
      persistSession: false,
      cwd: config.dataDir,
      env: childEnv,
      abortController: abort,
    },
  });
  let data: unknown;
  let costUsd = 0;
  let error = '';
  try {
    for await (const m of q) {
      if (m.type !== 'result') continue;
      costUsd = m.total_cost_usd;
      if (m.subtype === 'success') data = m.structured_output ?? parseLooseJson(m.result);
      else error = m.subtype;
    }
  } catch (e) {
    throw new AskError(abort.signal.aborted ? 'timed out' : String((e as Error).message ?? e), costUsd);
  } finally {
    clearTimeout(timer);
  }
  if (data === undefined || data === null) throw new AskError(`no structured output (${error || 'empty'})`, costUsd);
  return { data: data as T, costUsd };
}

/**
 * One tiny request at server start, so the first visitor does not pay for a cold CLI (binary and file
 * caches, connection to the endpoint). Logs its timing; failures are only logged.
 */
export async function warmUp(model: string) {
  const t0 = Date.now();
  let init = 0;
  try {
    for await (const m of query({
      prompt: '只回复一个字：好',
      options: { pathToClaudeCodeExecutable: claudeExecutable, model, effort: 'low', tools: [], allowedTools: [], settingSources: [], permissionMode: 'dontAsk', strictMcpConfig: true, maxTurns: 1, persistSession: false, cwd: config.dataDir, env: childEnv },
    })) {
      if (m.type === 'system' && m.subtype === 'init' && !init) init = Date.now() - t0;
      if (m.type === 'result') {
        console.log(`warm-up: CLI ready in ${init} ms, first answer in ${Date.now() - t0} ms (${m.subtype}, $${m.total_cost_usd.toFixed(4)})`);
        return m.total_cost_usd;
      }
    }
  } catch (e) {
    console.error(`warm-up failed after ${Date.now() - t0} ms:`, (e as Error).message);
  }
  return 0;
}

function parseLooseJson(text: string) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return undefined; }
}
