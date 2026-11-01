// Checks src/media/beats.ts. beatGrid: synthetic click tracks at 90, 120 and 128 BPM (accented bar, kick on the one)
// and swung variants (soft hi-hat two thirds into each beat) must come out within ±1 BPM, every beat within
// ±30 ms and the downbeats on the accented clicks; rock backbeats (kick on 1 and the 'and' of 3, snare on 2
// and 4, eighth-note hi-hats, which correlate more strongly at 1.5 beats than at the beat) must come out at
// the tempo or half of it with every beat or every other beat on the music; an ambient pad, sparse random hits and silence must report
// no pulse; the installed BGM must keep its known tempo. snapCuts: shots stay inside [min, max], no cut moves
// further than the tolerance, the total stays within 5%, a feasible plan lands at least 80% of its cuts on
// beats, and the output is deterministic. Synthetic audio is written under a fresh os.tmpdir() folder that is
// removed at the end.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beatGrid, snapCuts } from '../../src/media/beats.ts';

const DIR = await mkdtemp(join(tmpdir(), 'beats-check-'));
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const SR = 44100;
/** 16-bit mono WAV. */
async function wav(name: string, x: Float32Array): Promise<string> {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32000), 44 + i * 2);
  const file = join(DIR, `${name}.wav`);
  await writeFile(file, b);
  return file;
}

/** mulberry32 in [-1, 1), seeded so every run synthesises the same audio. */
function noise(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}
const rnd = noise(12345);

/** Adds a click (tone + noise tick), a kick (pitch-dropping sine), a snare (noise + 190 Hz) or a hi-hat (noise burst) at `t` s. */
function hit(x: Float32Array, t: number, amp: number, kind: 'click' | 'kick' | 'snare' | 'hat') {
  const s0 = Math.round(t * SR);
  const len = Math.round((kind === 'kick' ? 0.25 : kind === 'snare' ? 0.15 : 0.06) * SR);
  for (let i = 0; i < len && s0 + i < x.length; i++) {
    const tt = i / SR;
    const v = kind === 'click' ? (0.6 * Math.sin(2 * Math.PI * 1500 * tt) + 0.4 * rnd()) * Math.exp(-tt / 0.012)
      : kind === 'kick' ? Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-tt / 0.03)) * tt) * Math.exp(-tt / 0.08)
      : kind === 'snare' ? (0.7 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * tt)) * Math.exp(-tt / 0.05)
      : rnd() * Math.exp(-tt / 0.01);
    x[s0 + i]! += amp * v;
  }
}

/** Click track from `first` s: accented click plus kick on every 4th beat; swung soft hi-hats when `swing`. */
function clicks(bpm: number, seconds: number, first: number, swing: boolean) {
  const x = new Float32Array(Math.round(seconds * SR));
  const beats: number[] = [];
  for (let k = 0, t = first; t < seconds - 0.3; k++, t = first + (k * 60) / bpm) {
    beats.push(t);
    hit(x, t, k % 4 === 0 ? 0.6 : 0.4, 'click');
    if (k % 4 === 0) hit(x, t, 0.5, 'kick');
    if (swing) hit(x, t + (2 / 3) * (60 / bpm), 0.25, 'hat');
  }
  return { x, beats, downbeats: beats.filter((_, i) => i % 4 === 0) };
}

/** Rock backbeat from 0.3 s: kick on 1 and the 'and' of 3, snare on 2 and 4, hi-hats on every eighth. */
function backbeat(bpm: number, seconds: number) {
  const x = new Float32Array(Math.round(seconds * SR));
  const per = 60 / bpm;
  const beats: number[] = [];
  for (let k = 0, t = 0.3; t < seconds - 0.3; k++, t = 0.3 + k * per) {
    beats.push(t);
    if (k % 4 === 0) hit(x, t, 0.8, 'kick');
    if (k % 4 === 2) hit(x, t + per / 2, 0.6, 'kick');
    if (k % 2 === 1) hit(x, t, 0.5, 'snare');
    hit(x, t, 0.2, 'hat');
    hit(x, t + per / 2, 0.15, 'hat');
  }
  return { x, beats };
}

/** Ambient pad: slow-attack sine chords changing at irregular times over softly swelling filtered noise. */
function pad(seconds: number) {
  const x = new Float32Array(Math.round(seconds * SR));
  const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [233.1, 293.7, 349.2]];
  const changes = [0, 3.7, 8.9, 12.1, 17.6, 21.3, 26.8, 30.2, 35.5, 40.1];
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    let v = 0;
    for (let c = 0; c < changes.length; c++) {
      const a = changes[c]!;
      const b = changes[c + 1] ?? seconds + 3;
      if (t < a || t > b + 3) continue;
      const env = Math.min(1, (t - a) / 2.5) * Math.min(1, Math.max(0, (b + 3 - t) / 3));
      for (const f of chords[c % chords.length]!) v += 0.08 * env * Math.sin(2 * Math.PI * f * t + c);
    }
    lp += 0.02 * (rnd() - lp);
    x[i] = v + lp * 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.07 * t));
  }
  return x;
}

/** Clicks and hi-hats at random (Poisson) times, about `rate` a second: busy, but no pulse. */
function randomHits(seconds: number, rate: number) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let t = 0.2; t < seconds - 0.5; t += -Math.log(Math.max(1e-6, Math.abs(rnd()))) / rate) {
    hit(x, t, 0.3 + 0.3 * Math.abs(rnd()), rnd() > 0 ? 'click' : 'hat');
  }
  return x;
}

const nearest = (list: number[], t: number) => list.reduce((m, b) => Math.min(m, Math.abs(b - t)), Infinity);

try {
  console.log('beatGrid on synthetic click tracks (40 s):');
  for (const [bpm, swing, first] of [[90, false, 0.5], [120, false, 0.31], [128, false, 0.77], [90, true, 0.4], [120, true, 0.2]] as const) {
    const c = clicks(bpm, 40, first, swing);
    const name = `${bpm}${swing ? ' swung' : ''} BPM`;
    const g = await beatGrid(await wav(`click${bpm}${swing ? 's' : ''}`, c.x));
    const errs = c.beats.map((t) => nearest(g.beats, t));
    const extra = g.beats.filter((b) => nearest(c.beats, b) > 0.03).length;
    const downOk = g.downbeats.filter((d) => nearest(c.downbeats, d) < 0.03).length;
    check(g.bpm !== null && Math.abs(g.bpm - bpm) <= 1, `${name}: bpm ${g.bpm}, confidence ${g.confidence}`);
    check(Math.max(...errs) <= 0.03 && extra === 0,
      `${name}: all ${c.beats.length} beats found within ${Math.round(Math.max(...errs) * 1000)} ms, ${extra} extra (≤30 ms)`);
    check(g.downbeats.length > 0 && downOk === g.downbeats.length, `${name}: downbeats on the accented click (${downOk}/${g.downbeats.length})`);
    check(g.confidence >= 0.8, `${name}: clear pulse (confidence ${g.confidence} ≥ 0.8)`);
  }

  console.log('beatGrid on rock backbeats (40 s):');
  for (const bpm of [155, 160, 165, 170, 175, 180]) {
    const r = backbeat(bpm, 40);
    const g = await beatGrid(await wav(`backbeat${bpm}`, r.x));
    // At 155–180 BPM the grid may run at half tempo (preferring 80–140): then every other true beat counts.
    const half = g.bpm !== null && Math.abs(g.bpm - bpm / 2) <= 1;
    const truth = half ? [0, 1].map((p) => r.beats.filter((_, i) => i % 2 === p))
      .sort((a, b) => b.filter((t) => nearest(g.beats, t) <= 0.03).length - a.filter((t) => nearest(g.beats, t) <= 0.03).length)[0]! : r.beats;
    const found = truth.filter((t) => nearest(g.beats, t) <= 0.03).length;
    const extra = g.beats.filter((b) => nearest(truth, b) > 0.03).length;
    check(g.bpm !== null && (Math.abs(g.bpm - bpm) <= 1 || half),
      `${bpm} BPM backbeat: bpm ${g.bpm} (${bpm} or ${bpm / 2}), confidence ${g.confidence}`);
    check(found >= truth.length - 1 && extra === 0, `${bpm} BPM backbeat: ${found}/${truth.length} beats on the music, ${extra} off it (≤30 ms)`);
  }

  console.log('beatGrid on audio without a pulse:');
  for (const [name, x] of [['ambient pad 40 s', pad(40)], ['ambient pad 12 s', pad(12)], ['random hits 3/s', randomHits(40, 3)], ['silence', new Float32Array(SR * 10)]] as const) {
    const g = await beatGrid(await wav(name.replace(/\W+/g, '-'), x));
    check(g.confidence < 0.2 && g.bpm === null && g.beats.length === 0, `${name}: confidence ${g.confidence}, bpm ${g.bpm}, ${g.beats.length} beats`);
  }

  console.log('beatGrid determinism and limits:');
  const f128 = join(DIR, 'click128.wav');
  const [a, b] = [await beatGrid(f128), await beatGrid(f128)];
  check(JSON.stringify(a) === JSON.stringify(b), 'same file twice gives the same grid');
  const short = await beatGrid(f128, { maxSeconds: 10 });
  check(short.beats.length > 0 && short.beats[short.beats.length - 1]! < 10.05 && short.bpm !== null && Math.abs(short.bpm - 128) <= 1,
    `maxSeconds 10 analyses only the first 10 s (${short.beats.length} beats, bpm ${short.bpm})`);
  const missing = await beatGrid(join(DIR, 'missing.wav')).then(() => 'resolved', (e: Error) => e.message);
  check(missing.startsWith('节拍分析失败'), `missing file rejects (${missing.slice(0, 30)}…)`);
  const http = await beatGrid('http://127.0.0.1:9/x.mp3').then(() => 'resolved', (e: Error) => e.message);
  check(http !== 'resolved', 'http input is refused by the protocol whitelist');

  console.log('beatGrid on the installed BGM (first 120 s):');
  // Tempi read off contact sheets (waveform + low-passed waveform + spectrogram with the grid drawn on).
  const known: Record<string, number> = { 'bgm-tech-house.mp3': 124, 'cat-walk.mp3': 130, 'g-eazy-nba-type.mp3': 130, 'house-vibez.mp3': 122, 'tonight-hiphop.mp3': 105 };
  const bgmDir = new URL('../skills/video-shotcraft/assets/audio/bgm/', import.meta.url).pathname;
  const installed = await readdir(bgmDir).catch(() => [] as string[]);
  for (const name of installed.filter((n) => /\.(mp3|m4a|wav|ogg)$/i.test(n)).sort()) {
    const t0 = Date.now();
    const g = await beatGrid(join(bgmDir, name));
    const expect = known[name];
    const desc = `${name.padEnd(22)} bpm ${String(g.bpm).padEnd(5)} confidence ${g.confidence.toFixed(2)} first downbeat ${g.downbeats[0]}s (${Date.now() - t0} ms)`;
    if (expect === undefined) console.log(`  info ${desc}`);
    else check(g.bpm !== null && Math.abs(g.bpm - expect) <= 1 && g.confidence >= 0.5, `${desc} (expected ${expect})`);
  }

  console.log('snapCuts:');
  // 122 BPM grid from 0.05 s with every 4th beat a downbeat, like house-vibez.
  const period = 60 / 122;
  const beats = Array.from({ length: 200 }, (_, k) => Math.round((0.05 + k * period) * 1000) / 1000);
  const downbeats = beats.filter((_, k) => k % 4 === 0);
  /** Checks one result against the rules; returns the share of cuts on a beat. */
  const audit = (label: string, shots: Array<{ seconds: number; min: number; max: number }>, r: ReturnType<typeof snapCuts>, tol: number, grid: number[]) => {
    let planned = 0;
    let cut = 0;
    let worstMove = 0;
    let inRange = true;
    let on = 0;
    let plannedTotal = 0;
    for (const s of shots) plannedTotal += Math.min(s.max, Math.max(s.min, s.seconds));
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]!;
      planned += Math.min(s.max, Math.max(s.min, s.seconds));
      cut += r.seconds[i]!;
      if (!(r.seconds[i]! >= s.min - 1e-9 && r.seconds[i]! <= s.max + 1e-9)) inRange = false;
      worstMove = Math.max(worstMove, Math.abs(cut - planned));
      if (i < shots.length - 1 && nearest(grid, cut + r.offset) < 0.0015) on++;
    }
    const total = Math.abs(cut - plannedTotal) / plannedTotal;
    const share = shots.length > 1 ? on / (shots.length - 1) : 1;
    const ok = inRange && worstMove <= tol + 1e-6 && total <= 0.05 + 1e-9 && r.seconds.length === shots.length && on === r.snapped;
    return { ok, share, desc: `${label}: in range ${inRange}, worst move ${worstMove.toFixed(3)} s, total ${(total * 100).toFixed(1)}%, on beat ${on}/${shots.length - 1}` };
  };

  // A feasible plan: every planned cut within 0.2 s of a beat, room to move.
  const feasible = [3.1, 2.9, 4.2, 3.0, 3.3, 3.9, 2.6, 4.4].map((s) => ({ seconds: s, min: s - 1, max: s + 0.6 }));
  const r1 = snapCuts(feasible, beats, { downbeats });
  const a1 = audit('feasible plan', feasible, r1, 0.35, beats);
  check(a1.ok && a1.share >= 0.8, `${a1.desc}, offset ${r1.offset}, lengths ${r1.seconds.join(' ')}`);
  check(JSON.stringify(r1) === JSON.stringify(snapCuts(feasible, [...beats].reverse(), { downbeats })), 'deterministic (same result twice, beats in any order)');

  // Random plans: lengths 1.5–6 s, voiceover-bound minimums, +0.6 s maximums, some shots already at their limit.
  const pick = noise(99);
  let all = true;
  let onSum = 0;
  let cutSum = 0;
  let worst = '';
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(Math.abs(pick()) * 12);
    const tol = trial % 3 === 0 ? 0.2 : 0.35;
    const shots = Array.from({ length: n }, () => {
      const s = Math.round((1.5 + Math.abs(pick()) * 4.5) * 1000) / 1000;
      const min = Math.round(Math.max(0.5, s - Math.abs(pick()) * 1.5) * 1000) / 1000;
      return { seconds: s, min, max: pick() > 0.8 ? s : Math.round((s + 0.6) * 1000) / 1000 };
    });
    const r = snapCuts(shots, beats, { downbeats, tolerance: tol });
    const res = audit(`trial ${trial}`, shots, r, tol, beats);
    onSum += res.share * (n - 1);
    cutSum += n - 1;
    if (!res.ok) { all = false; worst ||= res.desc; }
  }
  check(all, `300 random plans keep [min, max], tolerance and the 5% total${worst ? ` (first failure: ${worst})` : ''}`);
  check(onSum / cutSum >= 0.8, `random plans land ${(100 * onSum / cutSum).toFixed(1)}% of cuts on a beat`);

  // A plan that cannot move: min = max = planned.
  const fixed = [3, 3, 4].map((s) => ({ seconds: s, min: s, max: s }));
  const r2 = snapCuts(fixed, beats, { offset: 0 });
  check(JSON.stringify(r2.seconds) === '[3,3,4]' && r2.offset === 0, `fixed shots stay as planned (${r2.seconds.join(' ')}, offset ${r2.offset})`);

  // No beats: plan unchanged (clamped into range).
  const r3 = snapCuts([{ seconds: 5, min: 1, max: 4 }, { seconds: 2, min: 2.5, max: 4 }], []);
  check(JSON.stringify(r3) === JSON.stringify({ seconds: [4, 2.5], snapped: 0, offset: 0 }), `no beats → planned lengths clamped (${r3.seconds.join(' ')})`);

  // A short video: the end may move by at most 5% (0.25 s of 5 s), less than the tolerance.
  const tiny = [{ seconds: 2.4, min: 1, max: 3 }, { seconds: 2.6, min: 1, max: 3 }];
  const r4 = snapCuts(tiny, beats, { tolerance: 0.35 });
  const a4 = audit('5 s video', tiny, r4, 0.35, beats);
  check(a4.ok, `${a4.desc}, lengths ${r4.seconds.join(' ')}`);

  // A fixed music offset is kept, and cuts land on beats in video time (beat - offset).
  const r5 = snapCuts(feasible, beats, { offset: 0.542, downbeats });
  const a5 = audit('offset 0.542', feasible, r5, 0.35, beats);
  check(r5.offset === 0.542 && a5.ok && a5.share >= 0.8, `${a5.desc}`);

  // The chosen offset is 0 or one of the first beats within 6 s.
  check(r1.offset === 0 || (beats.includes(r1.offset) && r1.offset <= 6), `chosen offset ${r1.offset} is 0 or an early beat`);
} finally {
  await rm(DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} beats check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nAll beats checks passed');
