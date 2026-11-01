// Real-API check (dev server): one search through the research tool's routes.
// Usage: npx tsx scripts/tools/probe-research.ts "AI 在矿物勘探中的应用案例"
import { search } from '../../src/providers/research.ts';

const q = process.argv[2] ?? 'NewsBreak 天气预警功能有哪些';
const t0 = Date.now();
try {
  const r = await search(q);
  console.log(`provider ${r.provider}, ${Date.now() - t0} ms\n${r.summary}\n\nsources:\n${r.sources.map((s) => `- ${s.title} | ${s.domain} | ${s.url}`).join('\n')}`);
} catch (e) {
  console.log('FAIL', (e as Error).message);
}
