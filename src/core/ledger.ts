// Global spend ledger for paid calls (Seedance through the relay, and Claude when it is billed through a
// configured endpoint rather than the local Claude Code subscription). Append-only JSONL so totals survive
// restarts; a hard cap refuses any call that would push the total past the limit.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, FRAME_SIZE, type Aspect } from './config.ts';

export interface LedgerEntry {
  ts: string;
  session: string;
  item: string;
  model: string;
  usage: string;
  usd: number;
  /** 'actual' = the provider's billed amount; 'estimate' = computed from our price table. */
  basis: 'actual' | 'estimate';
}

const env = process.env;
export const pricing = {
  limitUsd: Number(env.BUDGET_LIMIT_USD ?? 100),
  warnRatio: Number(env.BUDGET_WARN_RATIO ?? 0.8),
  /** USD per million Seedance output tokens. Unverified secondary-source figure; set from the relay's price list. */
  seedanceUsdPerMTok: Number(env.SEEDANCE_USD_PER_MTOKEN ?? 9.72),
  /** CNY per USD, for providers that bill in yuan. */
  usdCnyRate: Number(env.USD_CNY_RATE ?? 7.2),
  /** Count Claude spend only when it is billed through a configured endpoint, not the local subscription. */
  claudeBilled: env.BUDGET_COUNT_CLAUDE ? env.BUDGET_COUNT_CLAUDE === 'true' : Boolean(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY),
  /** Reserve held back before each billed Claude turn, since its cost is only known afterwards. */
  claudeTurnReserveUsd: Number(env.BUDGET_CLAUDE_TURN_RESERVE_USD ?? 0.5),
};

/** Ark bills video by output tokens ≈ width × height × (fps × seconds + 1) / 1024. */
export function seedanceTokens(seconds: number, aspect: Aspect) {
  const { width, height } = FRAME_SIZE[aspect];
  return Math.round((width * height * (config.fps * seconds + 1)) / 1024);
}
export const seedanceUsd = (tokens: number) => (tokens / 1e6) * pricing.seedanceUsdPerMTok;

const file = join(config.dataDir, 'ledger.jsonl');
const stateFile = join(config.dataDir, 'ledger-state.json');
mkdirSync(config.dataDir, { recursive: true });

let spent = existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + (JSON.parse(l) as LedgerEntry).usd, 0)
  : 0;
let warned = existsSync(stateFile) ? Boolean(JSON.parse(readFileSync(stateFile, 'utf8')).warned) : false;

export const ledger = {
  spent: () => spent,
  limit: () => pricing.limitUsd,
  /** True when spending `usd` more stays within the cap. */
  canSpend: (usd: number) => spent + usd <= pricing.limitUsd + 1e-9,
  /** Records a charge; returns a one-time warning text when crossing the warning threshold. */
  record(e: Omit<LedgerEntry, 'ts'>): string | null {
    if (e.usd <= 0) return null;
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
    spent += e.usd;
    if (!warned && spent >= pricing.limitUsd * pricing.warnRatio) {
      warned = true;
      writeFileSync(stateFile, JSON.stringify({ warned }));
      return `生成额度已用 ${Math.round((spent / pricing.limitUsd) * 100)}%`;
    }
    return null;
  },
};

export const BUDGET_EXHAUSTED = '这个 demo 的生成额度用完了，暂时没法再做新镜头。';

export function readEntries(): LedgerEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const e = JSON.parse(l) as LedgerEntry & { basis: string };
    return { ...e, basis: e.basis === 'actual' ? 'actual' : 'estimate' };
  });
}

/** Claude entries (conversation, reviews) versus Seedance clips; model ids may be aliases, so compare to the configured ones too. */
export const isClaudeModel = (m: string) => m.startsWith('claude') || m === config.model || m === config.review.model;
