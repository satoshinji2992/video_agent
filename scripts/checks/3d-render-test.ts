// Renders the skills/video-3d templates through the real scene renderer (same call as render_code_shot
// in src/tools/), measures time, and extracts frames to check they are not black/blank and do move.
// Usage: npx tsx scripts/checks/3d-render-test.ts [--out DIR] [--aspects 9:16,16:9] [--seconds N] [--supersample 1|2] [--parallel] [name-filter...]
//   --supersample defaults to 2, as render_code_shot renders 3d shots.
//   Without --seconds each template renders for its own `const DURATION = N` (default 5).
//   --parallel starts every render at once (the renderer's own limiter caps it at RENDER_CONCURRENCY) and
//   reports wall time per shot under contention instead of the sequential per-frame breakdown.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FRAME_SIZE, config, type Aspect } from '../../src/core/config.ts';
import { CHROME_ARGS, closeBrowser, renderScene } from '../../src/render/renderer.ts';

// Experiment hook: THREE_D_CHROME_ARGS="--a --b" replaces the renderer's launch args for this run only.
if (process.env.THREE_D_CHROME_ARGS) CHROME_ARGS.splice(0, CHROME_ARGS.length, ...process.env.THREE_D_CHROME_ARGS.split(/\s+/).filter(Boolean));

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const OUT = resolve(opt('--out') ?? join(tmpdir(), 'video-agent-3d-out'));
const ASPECTS = (opt('--aspects') ?? '9:16,16:9').split(',') as Aspect[];
const SECONDS = opt('--seconds');
const SUPERSAMPLE = Number(opt('--supersample') ?? 2);
const PARALLEL = argv.includes('--parallel');
if (PARALLEL) argv.splice(argv.indexOf('--parallel'), 1);
const filters = argv;

const TEMPLATES = resolve('skills/video-3d/templates');
const names = readdirSync(TEMPLATES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''))
  .filter((n) => !filters.length || filters.some((f) => n.includes(f)));

mkdirSync(join(OUT, 'frames'), { recursive: true });

/** Gray 64-px-wide thumbnails at 4 fps: mean brightness per sample and mean change between samples. */
function analyze(mp4: string, w: number, h: number) {
  const tw = 64, th = Math.round((64 * h) / w / 2) * 2;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', `fps=4,scale=${tw}:${th},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const n = tw * th, frames = Math.floor(raw.length / n);
  const means: number[] = [], diffs: number[] = [], stds: number[] = [];
  for (let f = 0; f < frames; f++) {
    let s = 0, s2 = 0, d = 0;
    for (let i = 0; i < n; i++) {
      const v = raw[f * n + i]!;
      s += v; s2 += v * v;
      if (f > 0) d += Math.abs(v - raw[(f - 1) * n + i]!);
    }
    means.push(s / n);
    stds.push(Math.sqrt(s2 / n - (s / n) ** 2));
    if (f > 0) diffs.push(d / n);
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { minMean: Math.min(...means), minStd: Math.min(...stds), avgDiff: avg(diffs), stillPairs: diffs.filter((d) => d < 0.05).length, samples: frames };
}

const rows: Record<string, unknown>[] = [];
if (PARALLEL) {
  const t0 = performance.now();
  await Promise.all(names.flatMap((name) => ASPECTS.map(async (aspect) => {
    const html = readFileSync(join(TEMPLATES, `${name}.html`), 'utf8');
    const seconds = Number(SECONDS ?? html.match(/const DURATION = ([\d.]+)/)?.[1] ?? 5);
    const work = join(OUT, 'work', `${name}_${aspect.replace(':', 'x')}_par`);
    mkdirSync(join(work, 'assets'), { recursive: true });
    const s0 = performance.now();
    try {
      const r = await renderScene({ html, seconds, aspect, workspaceDir: work, scenePath: join(work, 'scene.html'), outPath: join(work, 'out.mp4'), supersample: SUPERSAMPLE });
      rows.push({ template: name, aspect, seconds, totalMs: Math.round(performance.now() - s0), errors: r.consoleErrors.length });
    } catch (e) {
      rows.push({ template: name, aspect, error: (e as Error).message });
    }
  })));
  console.log(`parallel wall time: ${Math.round(performance.now() - t0)} ms for ${rows.length} shots, concurrency ${config.renderConcurrency}`);
}
for (const name of PARALLEL ? [] : names) {
  const html = readFileSync(join(TEMPLATES, `${name}.html`), 'utf8');
  const seconds = Number(SECONDS ?? html.match(/const DURATION = ([\d.]+)/)?.[1] ?? 5);
  for (const aspect of ASPECTS) {
    const tag = `${name}_${aspect.replace(':', 'x')}`;
    const work = join(OUT, 'work', tag);
    mkdirSync(join(work, 'assets'), { recursive: true });
    const run = async (secs: number, outPath: string) => {
      const t0 = performance.now();
      const r = await renderScene({ html, seconds: secs, aspect, workspaceDir: work, scenePath: join(work, 'scene.html'), outPath, supersample: SUPERSAMPLE });
      return { ms: performance.now() - t0, errors: r.consoleErrors };
    };
    try {
      // One-frame render = fixed cost (context + page load + warm-up + ffmpeg start); the rest is per frame.
      const one = await run(1 / config.fps, join(work, 'one.mp4'));
      const full = await run(seconds, join(OUT, `${tag}.mp4`));
      const frames = Math.round(seconds * config.fps);
      const perFrame = (full.ms - one.ms) / (frames - 1);
      const { width, height } = FRAME_SIZE[aspect];
      const a = analyze(join(OUT, `${tag}.mp4`), width, height);
      for (const at of [0.1, seconds * 0.35, seconds * 0.7, seconds - 0.1]) {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', join(OUT, `${tag}.mp4`), '-frames:v', '1', join(OUT, 'frames', `${tag}_t${at.toFixed(1)}.png`)]);
      }
      const row = {
        template: name, aspect, seconds, frames,
        setupMs: Math.round(one.ms), perFrameMs: Math.round(perFrame), totalMs: Math.round(full.ms),
        minMeanLuma: a.minMean.toFixed(1), minStd: a.minStd.toFixed(1), avgFrameDiff: a.avgDiff.toFixed(2), stillPairs: `${a.stillPairs}/${a.samples - 1}`,
        errors: [...new Set([...one.errors, ...full.errors])].slice(0, 3),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (e) {
      rows.push({ template: name, aspect, error: (e as Error).message });
      console.log(`FAIL ${tag}: ${(e as Error).message}`);
    }
  }
}
await closeBrowser();
writeFileSync(join(OUT, PARALLEL ? 'results-parallel.json' : 'results.json'), JSON.stringify(rows, null, 2));
console.table(rows.map((r) => ({ ...r, errors: (r.errors as string[] | undefined)?.length ?? '' })));
if (rows.some((r) => r.error)) process.exit(1);
