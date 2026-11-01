// Lists (and with --apply, removes) preference-memory items that are a project's facts rather than taste:
// anything filed under a category that no longer exists (the old '品牌信息': shop names, products, slogans) and
// anything that reads like a price, address, phone number or date. Run it with DATA_DIR pointing at the data
// folder whose memory.json should be cleaned; without --apply nothing is changed.
// Usage: DATA_DIR=<data dir> npx tsx scripts/tools/memory-cleanup.ts [--apply]
import { CATEGORIES, looksLikeFact, memory } from '../../src/agent/memory.ts';
import { config } from '../../src/core/config.ts';

const apply = process.argv.includes('--apply');
const items = memory.list();
const doomed = items.filter((m) => !(CATEGORIES as readonly string[]).includes(m.category) || looksLikeFact(m.content));
console.log(`memory file: ${config.dataDir}/memory.json — ${items.length} items, ${doomed.length} to remove${apply ? '' : ' (dry run)'}`);
for (const m of doomed) {
  const why = (CATEGORIES as readonly string[]).includes(m.category) ? 'reads like a fact' : `category ${m.category}`;
  console.log(`- ${m.id} [${m.category}] ${m.source} ${m.content}   ← ${why}${m.evidence[0] ? `；原话「${m.evidence[0].quote}」` : ''}`);
}
const kept = items.filter((m) => !doomed.includes(m));
console.log(`\nkept (${kept.length}):`);
for (const m of kept) console.log(`  ${m.id} [${m.category}] ${m.content}`);
if (apply) {
  let n = 0;
  for (const m of doomed) if (memory.remove(m.id)) n++;
  console.log(`\nremoved ${n} items`);
}
