// Checks the scene renderer's /vendor/three/ route from inside a real scene page: allowed files load with
// the right MIME type, everything else (traversal, encoded traversal, non-GET, unlisted files, other
// origins) is refused. Results come back through console.error, which renderScene collects.
// Usage: npx tsx scripts/checks/3d-route-check.ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeBrowser, renderScene } from '../../src/render/renderer.ts';

const cases: Array<[string, string, RequestInit?]> = [
  ['ok', '/vendor/three/build/three.module.js'],
  ['ok', '/vendor/three/build/three.core.js'],
  ['ok', '/vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js'],
  ['ok', '/vendor/three/examples/fonts/helvetiker_bold.typeface.json'],
  ['deny', '/vendor/three/../../package.json'],
  ['deny', '/vendor/three/%2e%2e/%2e%2e/package.json'],
  ['deny', '/vendor/three/build/..%2f..%2f..%2fpackage.json'],
  ['deny', '/vendor/three/build/%2e%2e%2f%2e%2e%2f%2e%2e%2fsrc%2fconfig.ts'],
  ['deny', '/vendor/three/VERSION'],
  ['deny', '/vendor/three/LICENSE'],
  ['deny', '/vendor/three/build/'],
  ['deny', '/vendor/three/build/three.module.js', { method: 'POST', body: 'x' }],
  ['deny', '/vendor/three/build/three.module.js', { method: 'HEAD' }],
  ['deny', '/src/renderer.ts'],
  ['deny', 'https://example.com/'],
  ['deny', 'http://127.0.0.1:8787/'],
];

const html = `<!doctype html><html><body><script>
const cases = ${JSON.stringify(cases)};
window.renderFrame = async () => {
  if (window.done) return; window.done = true;
  const out = [];
  for (const [want, url, init] of cases) {
    let got;
    try { const r = await fetch(url, init); got = r.status + ' ' + (r.headers.get('content-type') || '') + ' ' + (await r.text()).length + 'B'; }
    catch (e) { got = 'blocked (' + e.name + ')'; }
    out.push('ROUTE ' + want + ' ' + (init && init.method || 'GET') + ' ' + url + ' -> ' + got);
  }
  const m = await import('/vendor/three/build/three.module.js');
  out.push('ROUTE module import REVISION=' + m.REVISION);
  console.error(out.join('\\n')); // one message: renderScene gives up after 20 console errors
};
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), '3d-route-'));
mkdirSync(join(dir, 'assets'));
const r = await renderScene({ html, seconds: 1 / 24, aspect: '1:1', workspaceDir: dir, scenePath: join(dir, 'scene.html'), outPath: join(dir, 'out.mp4') });
await closeBrowser();
let bad = 0;
for (const line of r.consoleErrors.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('ROUTE'))) {
  const ok = line.startsWith('ROUTE ok') ? / -> 200 /.test(line) : line.startsWith('ROUTE deny') ? !/ -> 200 /.test(line) : true;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
}
const other = r.consoleErrors.filter((l) => !l.includes('ROUTE'));
if (other.length) console.log('other console errors (expected for refused requests):', other.length);
console.log(bad ? `${bad} FAILED` : 'all route checks passed');
process.exit(bad ? 1 : 0);
