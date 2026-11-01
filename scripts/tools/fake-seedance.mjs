// Fake Ark-format Seedance API for local testing: tasks finish after ~3 s with a generated test clip.
// Usage: node scripts/tools/fake-seedance.mjs [port]  then SEEDANCE_BASE_URL=http://127.0.0.1:<port>/api/v3 SEEDANCE_API_KEY=test
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 8799);
const dir = mkdtempSync(join(tmpdir(), 'fake-seedance-'));
const tasks = new Map();
const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/files/')) return res.end(readFileSync(join(dir, url.pathname.slice(7))));
  if (url.pathname === '/api/usage/tasks') return res.end(JSON.stringify({ actual_amount: 3.390589, currency: 'CNY' }));
  if (req.headers.authorization !== 'Bearer test') { res.writeHead(401); return res.end('{}'); }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const id = `cgt-${tasks.size + 1}`;
      const [w, h] = { '9:16': [480, 854], '16:9': [854, 480], '1:1': [480, 480] }[j.ratio] ?? [480, 854];
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:d=${j.duration}:r=24`, '-pix_fmt', 'yuv420p', join(dir, `${id}.mp4`)]);
      tasks.set(id, Date.now());
      console.log('task', id, j.ratio, j.duration, String(j.content?.[0]?.text).slice(0, 60));
      res.end(JSON.stringify({ id }));
    });
    return;
  }
  const id = url.pathname.split('/').pop();
  const done = Date.now() - (tasks.get(id) ?? 0) > 3000;
  res.end(JSON.stringify(done
    ? { id, status: 'completed', content: { video_url: `http://127.0.0.1:${port}/files/${id}.mp4` }, usage: { completion_tokens: 48437 } }
    : { id, status: 'in_progress' }));
});
srv.listen(port, () => console.log('fake seedance on', port));
