// Re-queries the relay's billing lookup for every Seedance task id in attempts.jsonl and writes
// tools/log/usage.json: { taskId: { amount, currency, usd } }. Never prints the key or the lookup URL.
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../../../src/core/config.ts';
import { pricing } from '../../../src/core/ledger.ts';

const GEN = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const attempts = readFileSync(`${GEN}/log/attempts.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const only = process.argv.slice(2);
const ids = only.length ? only : [...new Set(attempts.map((a: { taskId: string | null }) => a.taskId).filter(Boolean))] as string[];
const out: Record<string, { amount: number | null; currency: string | null; usd: number | null }> = only.length ? JSON.parse(readFileSync(`${GEN}/log/usage.json`, 'utf8')) : {};
const PACE = Number(process.env.USAGE_PACE_MS ?? 1500);
if (!config.seedance.usageUrl) { console.log('no usage lookup configured'); process.exit(0); }
for (const id of ids) {
  let rec = { amount: null as number | null, currency: null as string | null, usd: null as number | null };
  for (let attempt = 0; attempt < 6; attempt++) {
  await new Promise((r) => setTimeout(r, PACE * (attempt + 1)));
  try {
    const res = await fetch(`${config.seedance.usageUrl}?task_id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${config.seedance.apiKey}` } });
    if (res.ok) {
      const j = (await res.json()) as { actual_amount?: number | string; currency?: string; data?: { actual_amount?: number | string; currency?: string } };
      const d = j.data ?? j;
      const amount = Number(d.actual_amount);
      const currency = (d.currency ?? '').toUpperCase();
      if (Number.isFinite(amount)) rec = { amount, currency, usd: currency === 'USD' ? amount : currency === 'CNY' ? amount / pricing.usdCnyRate : null };
    } else rec = { amount: null, currency: `HTTP ${res.status}`, usd: null };
  } catch (e) {
    rec = { amount: null, currency: `error ${(e as Error).name}`, usd: null };
  }
  if (rec.amount !== null || !String(rec.currency).includes('429')) break;
  }
  out[id] = rec;
}
writeFileSync(`${GEN}/log/usage.json`, JSON.stringify(out, null, 2));
const vals = Object.values(out).filter((_, i) => !only.length || only.includes(Object.keys(out)[i]));
console.log(`tasks=${ids.length} with_actual=${vals.filter((v) => v.usd !== null).length} total_usd=${vals.reduce((a, v) => a + (v.usd ?? 0), 0).toFixed(2)} currencies=${[...new Set(vals.map((v) => v.currency))].join(',')}`);
