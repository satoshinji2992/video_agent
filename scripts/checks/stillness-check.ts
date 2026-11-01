// Checks src/media/stillness.ts on synthetic 1080x1920 clips encoded the way the renderer encodes shots (x264 crf 20,
// 24 fps): a static title card, one that fades in for 1 s and then holds, and a frozen testsrc frame must read as
// still; a slow zoompan push, a small slowly floating dot, a fast and a once-a-second counter, slow parallax, a
// soft glow drifting 10 or 20 px/s behind the card, a breathing glow and testsrc must read as moving. The gentle
// cases are kept near the slowest motion a viewer still notices, so a less sensitive measure fails here, and the
// soft glows creep up on the threshold, so a measure that counts a creeping stretch as frozen fails too.
// Everything is written under a fresh os.tmpdir() folder that is removed at the end.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CJK_FONT_FILE } from '../../src/core/ffmpeg.ts';
import { stillness } from '../../src/media/stillness.ts';

const DIR = await mkdtemp(join(tmpdir(), 'stillness-check-'));
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const W = 1080;
const H = 1920;
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '24', '-t', '5', '-an'];
const FONT = CJK_FONT_FILE ? `fontfile='${CJK_FONT_FILE}':` : '';
const VIGNETTE = 'vignette=PI/4';
/** The card drawn over the vignetted background. */
const CARD_FG = [
  'drawbox=x=140:y=600:w=800:h=600:color=white@0.15:t=fill',
  'drawbox=x=140:y=600:w=800:h=600:color=white@0.6:t=4',
  `drawtext=${FONT}text='新年快乐':fontsize=150:fontcolor=white:x=(w-tw)/2:y=760`,
  `drawtext=${FONT}text='祝各位同事 2027':fontsize=56:fontcolor=white@0.8:x=(w-tw)/2:y=1000`,
].join(',');
const CARD = `${VIGNETTE},${CARD_FG}`;
const p = (name: string) => join(DIR, `${name}.mp4`);
const fromCard = (args: string[]) => ['-protocol_whitelist', 'file,pipe', '-i', p('static'), ...args];
const GLOW = join(DIR, 'glow.png');
/** The card's vignetted background with a blurred 600 px glow at `x` (alpha scaled by `alpha`), card on top. */
const withGlow = (x: string, alpha = '1') => ['-f', 'lavfi', '-i', `color=c=0x2a2a3a:s=${W}x${H}:r=24:d=5`,
  '-loop', '1', '-framerate', '24', '-protocol_whitelist', 'file,pipe', '-i', GLOW, '-filter_complex',
  `[0]${VIGNETTE}[bg];[1]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alpha})',boxblur=40[g];` +
  `[bg][g]overlay=x='${x}':y=200:shortest=1,${CARD_FG}`];

/** Runs ffmpeg, killed after 120 s. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}

try {
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x2a2a3a:s=${W}x${H}:r=24:d=5`, '-vf', CARD, ...ENC, p('static')]);
  await ffmpeg(['-f', 'lavfi', '-i', "color=c=0x6050a0:s=600x600:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*max(0,1-hypot(X-300,Y-300)/300)'",
    '-frames:v', '1', GLOW]);
  // Expected class, then how the clip is made from the static card (or from scratch).
  const cases: [name: string, still: boolean, args: string[]][] = [
    ['static', true, []],
    ['fadein', true, fromCard(['-vf', 'fade=in:st=0:d=1'])],
    ['texture_still', true, ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=24:d=1`,
      '-vf', 'trim=end_frame=1,loop=loop=200:size=1:start=0,setpts=N/24/TB']],
    // 2.4 % zoom over 5 s on a 2x upscale so zoompan's integer offsets do not add jitter.
    ['push_slow', false, fromCard(['-vf',
      `scale=${2 * W}:${2 * H},zoompan=z='1+0.0002*on':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=24`])],
    // A 12 px dot drifting on a 12x8 px ellipse every 4 s.
    ['dot_float', false, [...fromCard([]), '-f', 'lavfi', '-i', 'color=0xffd080:s=12x12:r=24:d=5',
      '-filter_complex', "[0][1]overlay=x='534+12*sin(2*PI*t/4)':y='1500+8*cos(2*PI*t/4)'"]],
    ['counter', false, fromCard(['-vf',
      `drawtext=${FONT}text='%{eif\\:floor(t*5)*7\\:d}':fontsize=90:fontcolor=white:x=(w-tw)/2:y=1400`])],
    // A counter ticking once a second: still for ~0.9 s between ticks, but the evenly spaced ticks are motion.
    ['counter_1hz', false, fromCard(['-vf',
      `drawtext=${FONT}text='%{eif\\:floor(t)\\:d}':fontsize=90:fontcolor=white:x=(w-tw)/2:y=1400`])],
    // A soft glow drifting behind the card: it only crosses the change threshold after ~0.7–1.5 s.
    ['glow_drift_10', false, withGlow('100+10*t')],
    ['glow_drift_20', false, withGlow('100+20*t')],
    // The glow breathing (alpha 0.6–1.0, 3 s period): it pauses ~0.7 s at every peak and trough, 1.5 s apart.
    ['glow_breathe', false, withGlow('200', '0.8+0.2*sin(2*PI*T/3)')],
    // Ticks at 1, 2 and 3 s, then the counter stops and the card holds for 2 s.
    ['counter_stops', true, fromCard(['-vf',
      `drawtext=${FONT}text='%{eif\\:min(floor(t)\\,3)\\:d}':fontsize=90:fontcolor=white:x=(w-tw)/2:y=1400`])],
    // The whole card slides 5 px/s.
    ['parallax_slow', false, fromCard(['-vf', `pad=${W + 120}:${H}:0:0:0x2a2a3a,crop=${W}:${H}:x='60+5*t':y=0`])],
    ['testsrc', false, ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=24:d=5`]],
  ];
  const classified = cases.filter(([name]) => name !== 'counter_stops');
  await Promise.all(cases.filter(([, , args]) => args.length).map(([name, , args]) => ffmpeg([...args, ...ENC, p(name)])));

  console.log('Classification (the caller flags stillShare > 0.5 or longestStill >= 2.5 s as still):');
  for (const [name, expectStill] of classified) {
    const t0 = Date.now();
    const r = await stillness(p(name));
    const ms = Date.now() - t0;
    const desc = `${name.padEnd(14)} stillShare=${r.stillShare.toFixed(2)} longestStill=${r.longestStill.toFixed(1)}s (${ms} ms)`;
    // Margins well clear of the caller's rule, so a small drift in calibration shows up here.
    check(expectStill ? r.stillShare >= 0.8 : r.stillShare <= 0.25 && r.longestStill < 1, `${desc} → ${expectStill ? '静止' : '运动'}`);
  }

  console.log('Edge cases:');
  const s = await stillness(p('static'));
  check(s.stillShare === 1 && s.longestStill >= 4.3, `static card holds for the whole span after 0.6 s (${s.longestStill}s)`);
  const f0 = await stillness(p('fadein'), { skipStart: 0 });
  const f1 = await stillness(p('fadein'));
  check(f0.stillShare < f1.stillShare && f0.longestStill <= f1.longestStill + 0.1,
    `fade-in counts as motion when skipStart=0 (${f0.stillShare} < ${f1.stillShare})`);
  const stops = await stillness(p('counter_stops'));
  check(stops.longestStill >= 1.8, `the hold after a counter stops ticking still counts (${stops.stillShare} / ${stops.longestStill}s)`);
  const past = await stillness(p('static'), { skipStart: 9 });
  check(past.stillShare === 0 && past.longestStill === 0, 'skipStart past the end yields zeros');
  const missing = await stillness(join(DIR, 'missing.mp4')).then(() => 'resolved', (e: Error) => e.message);
  check(missing.startsWith('静止检测失败'), `missing file rejects (${missing.slice(0, 40)}…)`);
  const http = await stillness('http://127.0.0.1:9/x.mp4').then(() => 'resolved', (e: Error) => e.message);
  check(/Protocol 'http' not on whitelist|静止检测失败/.test(http) && http !== 'resolved', 'http input is refused by the protocol whitelist');
} finally {
  await rm(DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} stillness check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nAll stillness checks passed');
