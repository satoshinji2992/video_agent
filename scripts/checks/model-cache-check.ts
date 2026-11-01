// Checks the model cache size cap (src/render/models.ts pruneModelCache): with three 1 MB entries, two old and one
// used just now, a 1.5 MB cap drops the oldest two; an entry used within the hour survives even a zero cap.
import { mkdirSync, writeFileSync, utimesSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const data = mkdtempSync(join(tmpdir(), 'mc-'));
process.env.DATA_DIR = data;
const { pruneModelCache } = await import('../../src/render/models.ts');
const mk = (rel: string, ageH: number) => { const d = join(data, 'model-cache', rel); mkdirSync(d, { recursive: true }); const f = join(d, 'a.bin'); writeFileSync(f, Buffer.alloc(1 << 20)); const t = new Date(Date.now() - ageH * 3600_000); utimesSync(f, t, t); return d; };
const a = mk('raw/polyhaven/A', 48), b = mk('opt/polyhaven/B', 24), c = mk('raw/nasa3d/C', 0.1);
const r = await pruneModelCache(1.5 * (1 << 20));
console.log('removed', r.removed.map((x) => x.split('model-cache/')[1]), 'left MB', (r.bytes / (1 << 20)).toFixed(1));
if (existsSync(a) || existsSync(b) || !existsSync(c)) { console.log('FAIL: wrong entries dropped'); process.exit(1); }
console.log('ok: oldest two dropped, fresh one kept');
const r2 = await pruneModelCache(0);
if (!existsSync(c) || r2.removed.length) { console.log('FAIL: an entry used within the hour was dropped'); process.exit(1); }
console.log('ok: entry used within the hour survives even a 0 cap');
