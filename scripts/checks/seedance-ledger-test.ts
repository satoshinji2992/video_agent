// Fake Ark-format Seedance API + ledger hard stop: with a $1.2 budget, generation is refused once it is spent.
// Runs against a fresh temp DATA_DIR and a local fake API; nothing real is called. npx tsx scripts/checks/seedance-ledger-test.ts
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data = mkdtempSync(join(tmpdir(), 'ledger-test-'));
Object.assign(process.env, { DATA_DIR: data, SEEDANCE_BASE_URL: 'http://127.0.0.1:8799/api/v3', SEEDANCE_API_KEY: 'test', SEEDANCE_POLL_MS: '200', BUDGET_LIMIT_USD: '1.2' });
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=480x854:rate=24:duration=5', '-pix_fmt', 'yuv420p', join(data, 'v.mp4')]);
const clip = readFileSync(join(data, 'v.mp4'));
const tasks = new Map<string, number>();
const srv = http.createServer((req, res) => {
  if (req.url?.endsWith('.mp4')) { res.end(clip); return; }
  if (req.headers.authorization !== 'Bearer test') { res.writeHead(401); return res.end('{}'); }
  if (req.method === 'POST') { const id = 'cgt-' + tasks.size; tasks.set(id, Date.now()); res.end(JSON.stringify({ id })); return; }
  if (req.url?.endsWith('.mp4')) { res.end(clip); return; }
  const id = req.url!.split('/').pop()!;
  const done = Date.now() - tasks.get(id)! > 500;
  res.end(JSON.stringify(done ? { id, status: 'succeeded', content: { video_url: 'http://127.0.0.1:8799/v.mp4' }, usage: { completion_tokens: 48437 } } : { id, status: 'running' }));
}).listen(8799);
const { generateClip } = await import('../../src/providers/seedance.ts');
const { ledger } = await import('../../src/core/ledger.ts');
const results: boolean[] = [];
for (const i of [1, 2, 3]) {
  try {
    const w = await generateClip({ prompt: 'test', seconds: 5, aspect: '9:16' }, join(data, `c${i}.mp4`), () => {}, { session: 't', item: `shot${i}` });
    console.log(`clip ${i}: ok, spent $${ledger.spent().toFixed(3)}${w ? ' WARNING: ' + w : ''}`);
    results.push(true);
  } catch (e) { console.log(`clip ${i}: refused -> ${(e as Error).message}`); results.push(false); }
}
srv.close();
if (!results[0] || results.at(-1)) { console.log('FAIL: expected the first clip to pass and the last to be refused'); process.exit(1); }
console.log('ok: budget stop refused generation once the budget was spent');
