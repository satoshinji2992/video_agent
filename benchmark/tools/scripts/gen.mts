// Usage: gen.mts <spec.json> <id:tryLabel> [<id:tryLabel> ...]
// Runs the selected clip specs through Seedance (the adapter's limiter caps concurrency at
// SEEDANCE_MAX_CONCURRENT). Refuses a clip that already has 3 attempts (1 try + 2 retries).
import { readFileSync, existsSync } from 'node:fs';
import { runClip, GEN, RESOLUTION, config, MODEL, type ClipSpec } from './lib.mts';

const [specFile, ...picks] = process.argv.slice(2);
if (!specFile || !picks.length) { console.error('usage: gen.mts <spec.json> <id:try>...'); process.exit(2); }
// Several spec files may be given comma-separated, so one process (one limiter) runs them all.
const specs = specFile.split(',').flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as ClipSpec[]);
const attempts = existsSync(`${GEN}/log/attempts.jsonl`)
  ? readFileSync(`${GEN}/log/attempts.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { task: string; id: string; taskId: string | null; ok: boolean })
      // A submit-time refusal (no provider task id) generated nothing and is not counted as a try.
      .filter((a) => a.ok || a.taskId)
  : [];
console.log(`model=${MODEL} resolution=${RESOLUTION} draft=${config.seedance.draft} maxConcurrent=${config.seedance.maxConcurrent}`);
const jobs = picks.map((p) => {
  const [id, tryLabel] = p.split(':');
  const spec = specs.find((s) => s.id === id);
  if (!spec || !tryLabel) throw new Error(`bad pick ${p}`);
  const prior = attempts.filter((a) => a.task === spec.task && a.id === spec.id).length;
  if (spec.task !== 'probe' && prior >= 3) throw new Error(`${spec.task}/${id} already has ${prior} attempts (cap is 1 + 2 retries)`);
  return { spec, tryLabel };
});
const results = await Promise.all(jobs.map(({ spec, tryLabel }) => runClip(spec, tryLabel)));
console.log('\nSUMMARY');
for (const r of results) {
  console.log(`${r.item}\t${r.ok ? 'ok' : 'FAIL'}\t${r.probe ? `${r.probe.width}x${r.probe.height} ${r.probe.fps} ${r.probe.duration.toFixed(2)}s audio=${r.probe.audio}` : r.error}\t$${r.usd?.toFixed(3) ?? '?'} ${r.basis ?? ''}\t${r.elapsedS}s`);
}
