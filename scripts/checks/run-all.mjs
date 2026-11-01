// Runs every check that costs nothing: the type check, then each script in scripts/checks one after another.
// Each script gets a fresh temp DATA_DIR and an environment without API keys, so nothing paid can be called and
// nothing lands in data/. Checks that need the development set skip their dev-set cases when it is absent.
// Usage: npm run check [-- --offline] [name ...]   --offline skips the checks that download free public files.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const args = process.argv.slice(2);
const offline = args.includes('--offline');
const only = args.filter((a) => !a.startsWith('--'));
const devset = process.env.DEVSET ?? process.env.DEVSET_DIR ?? new URL('../../../video_agent_devset', import.meta.url).pathname;

/** name, command, and what it needs: net = downloads free public files, devset = needs the development set. */
const CHECKS = [
  ['typecheck', ['npx', 'tsc', '--noEmit', '-p', '.']],
  ['model-cache', ['npx', 'tsx', 'scripts/checks/model-cache-check.ts']],
  ['beats', ['npx', 'tsx', 'scripts/checks/beats-check.ts']],
  ['ambience', ['npx', 'tsx', 'scripts/checks/ambience-check.ts']],
  ['stillness', ['npx', 'tsx', 'scripts/checks/stillness-check.ts']],
  ['compose', ['npx', 'tsx', 'scripts/checks/compose-check.ts']],
  ['uploads', ['npx', 'tsx', 'scripts/checks/uploads-check.ts']],
  ['framecheck', ['npx', 'tsx', 'scripts/checks/framecheck-check.ts']],
  ['colormatch', ['npx', 'tsx', 'scripts/checks/colormatch-check.ts']],
  ['stabilize', ['npx', 'tsx', 'scripts/checks/stabilize-check.ts']],
  ['ingest', ['npx', 'tsx', 'scripts/checks/ingest-check.ts'], { devset: true }],
  ['seedance-ledger', ['npx', 'tsx', 'scripts/checks/seedance-ledger-test.ts']],
  ['pipeline-smoke', ['npx', 'tsx', 'scripts/checks/pipeline-smoke.ts']],
  ['3d-route', ['npx', 'tsx', 'scripts/checks/3d-route-check.ts']],
  ['3d-render', ['npx', 'tsx', 'scripts/checks/3d-render-test.ts']],
  ['3d-kit', ['npx', 'tsx', 'scripts/checks/3d-kit-check.ts', '--out', join(tmpdir(), 'video-agent-3d-kit')]],
  ['3d-model', ['npx', 'tsx', 'scripts/checks/3d-model-check.ts'], { net: true }],
  ['models', ['npx', 'tsx', 'scripts/checks/models-check.ts'], { net: true }],
  ['footage', ['npx', 'tsx', 'scripts/checks/footage-check.ts'], { net: true }],
];

// Nothing that could reach a paid API: no keys, no relay or Seedance endpoints.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD|RELAY|SEEDANCE|ANTHROPIC|OPENAI|GEMINI/i.test(k)));

const run = (cmd, extraEnv) => new Promise((done) => {
  const t0 = Date.now();
  const p = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (d) => { process.stdout.write(d); tail = (tail + d).slice(-4000); };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  p.on('close', (code) => done({ code, s: (Date.now() - t0) / 1000, tail }));
});

const rows = [];
for (const [name, cmd, needs = {}] of CHECKS) {
  if (only.length && !only.includes(name)) continue;
  if (needs.net && offline) { rows.push({ name, result: 'skip (offline)' }); continue; }
  if (needs.devset && !existsSync(join(devset, 'truth.json'))) { rows.push({ name, result: `skip (no dev set at ${devset})` }); continue; }
  console.log(`\n===== ${name}: ${cmd.join(' ')}`);
  const data = mkdtempSync(join(tmpdir(), `check-${name}-`));
  const r = await run(cmd, { DATA_DIR: data, DEVSET: devset, DEVSET_DIR: devset });
  rmSync(data, { recursive: true, force: true });
  rows.push({ name, result: r.code === 0 ? 'pass' : `FAIL (exit ${r.code})`, seconds: Math.round(r.s) });
}
console.log('\n===== summary');
console.table(rows);
process.exit(rows.some((r) => r.result.startsWith('FAIL')) ? 1 : 0);
