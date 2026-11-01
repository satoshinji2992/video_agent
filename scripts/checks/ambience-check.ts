// Checks src/media/ambience.ts. voiceGaps and the interval merging are checked on hand-made timelines; every volume
// expression is run through ffmpeg (as -af and inside a -filter_complex chain with atrim/adelay, the way
// finalize() embeds a clip's own sound) on a constant signal, and the gain it applies at each audio frame is
// compared with an independent reference: `under` during a line, `gap` in the gaps, linear ramps of `ramp`
// seconds before and after a line, lines closer than 0.4 s joined, a clip that starts or ends inside a line
// starting or ending ducked. ambienceProfile is checked on synthetic sound: silence, very quiet noise, pink and
// white noise, a held tone, a syllable-rate pulsed noise (unvoiced), a buzz voiced and pulsed like speech, the
// same buzz briefly after noise, hard-clipped noise, low wind rumble, and a video with no audio stream.
//
// On the development set (DEVSET, default ../video_agent_devset; skipped, not failed, without it):
// ambienceProfile on every clean and defect clip must give truth.json's audio character (none / ambience /
// speech / loud; the five clips without an audio stream must come back 'none', not throw; wind and clipped
// copies 'loud'), and `speech` must be true where people talk throughout and false where nobody talks. Then a
// mix is rendered the way tools.ts and finalize() build it (a voice at -18 LUFS for two lines, the clip's own
// sound under it through ambienceVolume with under 0.3 and gap 0.75) and its 400 ms loudness is read every
// 100 ms: on-location sound of -21 LUFS or quieter must sit at least 12 dB under the voice during the lines
// and come back in the gaps to within 24 LU of the voice level (hotter clips are printed, not judged: the
// caller's fixed gains are too high for them). Everything else is written under a fresh os.tmpdir() folder
// that is removed at the end.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambienceProfile, ambienceVolume, voiceGaps } from '../../src/media/ambience.ts';

const DEVSET = process.env.DEVSET ?? new URL('../../../video_agent_devset', import.meta.url).pathname;
const DIR = await mkdtemp(join(tmpdir(), 'ambience-check-'));
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Runs ffmpeg (killed after 60 s); resolves with stdout (with `log`, with stderr at that log level). */
function ffmpeg(args: string[], log?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', log ?? 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log ? Buffer.from(err) : Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}

/** Independent reference for the gain at clip time t. */
function reference(t: number, o: { clipStart: number; voice: Array<[number, number]>; under: number; gap: number; ramp?: number }) {
  const r = o.ramp ?? 0.3;
  const sorted = [...o.voice].sort((x, y) => x[0] - y[0]);
  const lines: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = lines[lines.length - 1];
    if (last && a - last[1] < 0.4) last[1] = Math.max(last[1], b);
    else lines.push([a, b]);
  }
  const at = t + o.clipStart;
  let duck = 0;
  for (const [a, b] of lines) {
    let d = 0;
    if (at >= a && at <= b) d = 1;
    else if (at < a && at > a - r) d = (at - (a - r)) / r;
    else if (at > b && at < b + r) d = (b + r - at) / r;
    duck = Math.max(duck, d);
  }
  return o.gap + (o.under - o.gap) * duck;
}

const RATE = 8000;
const FRAME = 256;
const LEVEL = 0.5;

/**
 * The gain the filter applies at the start of each audio frame: a constant LEVEL signal of `seconds` goes
 * through `filter` and the first sample of each frame is divided by LEVEL. With `embed`, the clip is cut
 * from a longer source with atrim and delayed by `delay` seconds after the filter, as in finalize().
 */
async function gains(filter: string, seconds: number, embed?: { delay: number }): Promise<number[]> {
  const src = ['-f', 'lavfi', '-i', `aevalsrc=${LEVEL}:s=${RATE}:n=${FRAME}:d=${seconds + 2}`];
  const out = ['-f', 'f32le', '-ac', '1', 'pipe:1'];
  const buf = embed
    ? await ffmpeg([...src, '-filter_complex', `[0:a]atrim=0:${seconds},asetnsamples=n=${FRAME},${filter},adelay=${Math.round(embed.delay * 1000)}[a]`, '-map', '[a]', ...out])
    : await ffmpeg([...src, '-af', `atrim=0:${seconds},asetnsamples=n=${FRAME},${filter}`, ...out]);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const skip = embed ? Math.round(embed.delay * RATE) : 0;
  const g: number[] = [];
  for (let i = skip; i < samples.length; i += FRAME) g.push(samples[i]! / LEVEL);
  return g;
}

try {
  console.log('voiceGaps');
  check(eq(voiceGaps([[1, 3], [4.5, 6]], 10), [[0, 1], [3, 4.5], [6, 10]]), 'gaps before, between and after lines');
  check(eq(voiceGaps([[1, 3], [3.5, 6]], 10), [[0, 1], [6, 10]]), 'a 0.5 s pause is not a 1 s gap');
  check(eq(voiceGaps([[1, 3], [3.5, 6]], 10, 0.5), [[0, 1], [3, 3.5], [6, 10]]), 'minGap 0.5 keeps it');
  check(eq(voiceGaps([[5, 7], [1, 4], [2, 3], [6.5, 8]], 9), [[0, 1], [4, 5], [8, 9]]), 'unsorted and overlapping lines merge');
  check(eq(voiceGaps([[-2, 1.5], [8, 12]], 10), [[1.5, 8]]), 'lines past either end are clipped to the timeline');
  check(eq(voiceGaps([], 4), [[0, 4]]), 'no voiceover: the whole timeline');
  check(eq(voiceGaps([[0, 4]], 4), []), 'voice throughout: no gaps');

  console.log('ambienceVolume: expression shape');
  const base = { under: 0.25, gap: 1 };
  check(ambienceVolume({ ...base, clipStart: 5, clipSeconds: 3, voice: [] }) === 'volume=1', 'no voiceover: plain gap gain');
  check(ambienceVolume({ ...base, clipStart: 5, clipSeconds: 3, voice: [[4, 9]] }) === 'volume=0.25', 'a line over the whole clip: plain under gain');
  check(ambienceVolume({ ...base, clipStart: 5, clipSeconds: 3, voice: [[0, 4.6], [8.4, 12]] }) === 'volume=1', 'lines beyond the clip plus ramp are left out');
  const terms = (s: string) => s.split('min(').length - 1;
  check(terms(ambienceVolume({ ...base, clipStart: 0, clipSeconds: 10, voice: [[1, 3], [3.3, 5]] })) === 1, 'lines 0.3 s apart are one duck');
  check(terms(ambienceVolume({ ...base, clipStart: 0, clipSeconds: 10, voice: [[1, 3], [3.5, 5]] })) === 2, 'lines 0.5 s apart are two ducks');
  const many: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [i * 1.5, i * 1.5 + 1] as [number, number]);
  const long = ambienceVolume({ ...base, clipStart: 100, clipSeconds: 5, voice: many });
  check(terms(long) <= 5 && long.length < 260, `200 lines, 5 s clip: ${terms(long)} terms, ${long.length} chars`);
  const tight = ambienceVolume({ ...base, clipStart: 0, clipSeconds: 30, voice: Array.from({ length: 60 }, (_, i) => [i * 0.5, i * 0.5 + 0.3] as [number, number]) });
  check(terms(tight) === 1, `60 lines 0.2 s apart collapse to ${terms(tight)} duck`);
  check(!/[^\\],/.test(long) && /:eval=frame$/.test(long), 'commas escaped for a filtergraph, eval=frame');

  console.log('ambienceVolume: rendered gains');
  const cases: Array<[string, { clipStart: number; clipSeconds: number; voice: Array<[number, number]>; under: number; gap: number; ramp?: number }, Array<[number, number]>]> = [
    // name, options, spot checks [clip time, gain]
    ['mid-timeline clip, joined lines, ends inside a line', { clipStart: 10, clipSeconds: 6, voice: [[11, 13], [13.3, 14], [15, 20]], under: 0.2, gap: 0.9 },
      [[0.3, 0.9], [0.85, 0.55], [1.5, 0.2], [3.15, 0.2], [4.15, 0.55], [4.5, 0.9], [5.5, 0.2], [5.95, 0.2]]],
    ['clip starts inside a line', { clipStart: 12, clipSeconds: 4, voice: [[10, 13]], under: 0.2, gap: 0.9 },
      [[0, 0.2], [0.5, 0.2], [1.15, 0.55], [2, 0.9]]],
    ['line starts at the clip start (ramp before it is cut)', { clipStart: 3, clipSeconds: 3, voice: [[3, 4], [5.9, 7]], under: 0.3, gap: 1, ramp: 0.5 },
      [[0, 1 - 0.7 * 1], [1.25, 0.65], [2, 1], [2.65, 0.3 + 0.7 * 0.5], [2.95, 0.3]]],
    ['under above gap (lifts during lines)', { clipStart: 0, clipSeconds: 4, voice: [[1, 2]], under: 0.9, gap: 0.3 },
      [[0.3, 0.3], [1.5, 0.9], [2.15, 0.6], [3, 0.3]]],
  ];
  for (const [name, o, spots] of cases) {
    const filter = ambienceVolume(o);
    for (const embed of [undefined, { delay: o.clipStart }]) {
      let g: number[];
      try {
        g = await gains(filter, o.clipSeconds, embed);
      } catch (e) {
        check(false, `${name}${embed ? ' (filter_complex)' : ''}: ffmpeg rejected ${filter}: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
      let worst = 0;
      g.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - reference((i * FRAME) / RATE, o)))));
      const frames = Math.round((o.clipSeconds * RATE) / FRAME);
      check(Math.abs(g.length - frames) <= 1 && worst < 0.002, `${name}${embed ? ' (filter_complex, adelay)' : ''}: ${g.length} frames, max error vs reference ${worst.toFixed(4)}`);
      if (embed) continue;
      // Spot checks: the gain at the frame holding t, against the stated level (one frame of ramp slack).
      const slack = (Math.abs(o.gap - o.under) / (o.ramp ?? 0.3)) * (FRAME / RATE) + 0.002;
      const bad = spots.filter(([t, want]) => Math.abs(g[Math.floor((t * RATE) / FRAME)]! - want) > slack);
      check(!bad.length, `${name}: levels at ${spots.map(([t, w]) => `${t}s=${Number(w.toFixed(3))}`).join(' ')}${bad.length ? ` (off at ${bad.map(([t]) => `${t}s=${g[Math.floor((t * RATE) / FRAME)]!.toFixed(3)}`).join(' ')})` : ''}`);
    }
  }

  console.log('ambienceProfile');
  const p = (name: string) => join(DIR, name);
  const make = (name: string, src: string, af?: string) => ffmpeg(['-f', 'lavfi', '-i', src, ...(af ? ['-af', af] : []), '-c:a', 'pcm_s16le', p(name)]);
  // A 130 Hz buzz with a few harmonics, pitch wobbling, pulsed into ~4.5 syllables a second with pauses.
  const speechAt = (t: string) => {
    const f0 = `(130+20*sin(2*PI*0.7*${t}))`;
    const buzz = [1, 0.6, 0.5, 0.4, 0.3, 0.2].map((a, i) => `${a}*sin(${2 * (i + 1)}*PI*${f0}*${t})`).join('+');
    return `0.4*(${buzz})*pow(max(0,sin(2*PI*4.5*${t})),2)*lt(mod(${t},2.2),1.8)`;
  };
  await make('silence.wav', 'anullsrc=r=44100:cl=stereo:d=6');
  await make('quiet.wav', 'anoisesrc=color=pink:amplitude=0.001:d=6');
  await make('pink.wav', 'anoisesrc=color=pink:amplitude=0.1:d=6');
  await make('white.wav', 'anoisesrc=color=white:amplitude=0.05:d=6');
  await make('tone.wav', 'sine=f=440:d=6', 'volume=0.3');
  await make('pulsed.wav', 'anoisesrc=color=pink:amplitude=0.3:d=6', "volume='pow(max(0,sin(2*PI*4.5*t)),2)':eval=frame");
  await make('speechy.wav', `aevalsrc='${speechAt('t')}':s=16000:d=6`);
  await make('clipped.wav', 'anoisesrc=color=pink:amplitude=0.9:d=6', 'volume=12dB');
  await make('wind.wav', 'anoisesrc=color=brown:amplitude=0.9:d=6', 'lowpass=f=120,volume=6dB');
  await make('noise_then_line.wav', `aevalsrc='0.03*(random(0)-0.5)+gte(t,6)*${speechAt('(t-6)')}':s=16000:d=8`);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('mute.mp4')]);
  const expect: Array<[string, string, boolean, Array<{ start: number; end: number; text: string }>?]> = [
    ['silence.wav', 'none', false],
    ['quiet.wav', 'none', false],
    ['pink.wav', 'ambience', false],
    ['white.wav', 'ambience', false],
    ['tone.wav', 'ambience', false],
    ['pulsed.wav', 'ambience', false],
    ['speechy.wav', 'speech', true],
    ['clipped.wav', 'loud', false],
    ['wind.wav', 'loud', false],
    ['noise_then_line.wav', 'ambience', true],
    // whisper's stock invention on room tone must not make it speech
    ['pink.wav', 'ambience', false, [{ start: 0, end: 6, text: 'Thanks for watching, please subscribe to the channel.' }]],
    ['mute.mp4', 'none', false],
  ];
  for (const [name, character, speech, transcript] of expect) {
    const r = await ambienceProfile(p(name), transcript);
    check(r.character === character && r.speech === speech && (name !== 'mute.mp4' || r.loudness === null),
      `${name}${transcript ? ' + invented transcript' : ''}: ${JSON.stringify(r)} (want ${character}, speech ${speech})`);
  }
  console.log(`dev set (${DEVSET})`);
  if (!existsSync(join(DEVSET, 'truth.json'))) {
    console.log(`SKIP dev-set cases: ${DEVSET} not found (set DEVSET=<dir>)`);
  } else {
    // truth.json holds -Infinity for the peak of a silent file, which JSON.parse does not take.
    const truth = JSON.parse(readFileSync(join(DEVSET, 'truth.json'), 'utf8').replace(/-Infinity/g, '-999')) as {
      files: Record<string, { category: string; audio?: { character: string; speech: string } }>;
    };
    const files = Object.entries(truth.files).filter(([, e]) => (e.category === 'footage' || e.category === 'defect') && e.audio);
    const got = new Map<string, Awaited<ReturnType<typeof ambienceProfile>> | Error>();
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async ([f]) => got.set(f, await ambienceProfile(join(DEVSET, f)).catch((e: Error) => e))));
    }
    const wrong: string[] = [], threw: string[] = [], speechWrong: string[] = [];
    const count: Record<string, number> = {};
    for (const [f, e] of files) {
      const r = got.get(f)!;
      if (r instanceof Error) { threw.push(`${f}: ${r.message}`); continue; }
      count[e.audio!.character] = (count[e.audio!.character] ?? 0) + 1;
      if (r.character !== e.audio!.character) wrong.push(`${f}: ${r.character}, truth ${e.audio!.character}`);
      if ((e.audio!.speech === 'yes' && r.character !== 'loud' && !r.speech) || (e.audio!.speech === 'no' && r.speech)) speechWrong.push(`${f}: speech ${r.speech}, truth ${e.audio!.speech}`);
    }
    check(!threw.length, `${files.length} clips profiled without an error (${threw.join('; ')})`);
    check(!wrong.length, `character as labelled on every clip (${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(', ')})${wrong.length ? `: ${wrong.join('; ')}` : ''}`);
    check(!speechWrong.length, `speech flag as labelled where people talk throughout or nobody talks${speechWrong.length ? `: ${speechWrong.join('; ')}` : ''}`);
    const loud = files.filter(([f]) => /wind|clipping/.test(f)).map(([f]) => got.get(f));
    check(loud.length === 4 && loud.every((r) => !(r instanceof Error) && r?.character === 'loud'), 'wind and clipped copies are loud');
    const silent = files.filter(([f]) => /^footage\//.test(f) && truth.files[f]!.audio!.character === 'none').map(([f]) => got.get(f));
    check(silent.length === 5 && silent.every((r) => !(r instanceof Error) && r?.loudness === null), 'the five clips without an audio stream: loudness null, character none');

    // A rendered mix: voice lines at 1–4 s and 6–9 s, the clip's own sound looped under them for 10 s.
    console.log('rendered mix (voice -18 LUFS; own sound under 0.3, gap 0.75)');
    const lines: Array<[number, number]> = [[1, 4], [6, 9]];
    const fmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const talk = join(DEVSET, 'footage/car_repair/garage_04_customer.mp4');
    const level = async (args: string[], graph: string) => {
      const log = (await ffmpeg([...args, '-filter_complex', `${graph},ebur128=framelog=verbose[o]`, '-map', '[o]', '-f', 'null', '-'], 'verbose')).toString();
      return [...log.matchAll(/t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+|-inf)/g)].map((m) => [Number(m[1]), m[2] === '-inf' ? -120 : Number(m[2])] as [number, number]);
    };
    // The summary's integrated loudness is the last "I:" in the log.
    const integrated = async (args: string[], graph: string) => Number([...(await ffmpeg([...args, '-filter_complex', `${graph},ebur128[o]`, '-map', '[o]', '-f', 'null', '-'], 'info')).toString().matchAll(/I:\s*(-?[\d.]+) LUFS/g)].pop()?.[1]);
    // The voice: three seconds of a person talking, set to -18 LUFS, at each line.
    const seg = `atrim=0.5:3.5,asetpts=PTS-STARTPTS,${fmt}`;
    const gain = -18 - await integrated(['-i', talk], `[0:a]${seg}`);
    const voiceGraph = `[0:a]${seg},volume=${gain.toFixed(2)}dB,asplit=2[x][y];[x]adelay=1000|1000,apad=whole_dur=10[x1];[y]adelay=6000|6000,apad=whole_dur=10[y1];[x1][y1]amix=inputs=2:normalize=0:duration=longest,atrim=0:10`;
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
    // Windows (each M covers the 0.4 s before t) wholly inside a line, and wholly in a gap clear of the ramps.
    const inLine = (t: number) => lines.some(([a, b]) => t - 0.4 >= a + 0.3 && t <= b);
    const inGap = (t: number) => t >= 0.5 && !lines.some(([a, b]) => t >= a - 0.3 && t - 0.4 <= b + 0.3);
    const voice = med((await level(['-i', talk], voiceGraph)).filter(([t]) => inLine(t)).map(([, v]) => v));
    const filter = ambienceVolume({ clipStart: 0, clipSeconds: 10, voice: lines, under: 0.3, gap: 0.75 });
    for (const rel of ['footage/gym/gym_01_exterior.mp4', 'footage/car_repair/garage_03_engine.mp4', 'footage/bakery/bakery_02_kneading.mp4', 'footage/street_food/stall_02_jianbing.mp4', 'footage/street_food/stall_06_wok.mp4', 'footage/gym/gym_02_coaching.mp4']) {
      const clip = join(DEVSET, rel);
      const lufs = await integrated(['-i', clip], `[0:a]${fmt}`);
      const bed = await level(['-stream_loop', '2', '-i', clip], `[0:a]atrim=0:10,asetpts=PTS-STARTPTS,${fmt},${filter}`);
      const under = med(bed.filter(([t]) => inLine(t)).map(([, v]) => v)), gapLevel = med(bed.filter(([t]) => inGap(t)).map(([, v]) => v));
      const what = `${rel.replace(/^.*\//, '')} (${lufs.toFixed(1)} LUFS): ${(voice - under).toFixed(1)} dB under the voice in the lines, ${(gapLevel - voice).toFixed(1)} LU against it in the gaps`;
      if (lufs <= -21) check(voice - under >= 12 && gapLevel - voice >= -24 && gapLevel < voice + 3, what);
      else console.log(`  info ${what}`);
    }
  }
} finally {
  await rm(DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
