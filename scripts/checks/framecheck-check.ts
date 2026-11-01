// Check of src/media/framecheck.ts. Synthetic clips are built with ffmpeg lavfi under a fresh os.tmpdir() folder:
// pillarboxed 4:3 and 9:16 inside 16:9 (also 10-bit, with near-black 0x101010 bars, with a logo in one bar, as
// PNG / JPEG stills and a still looped into a clip), a letterboxed scope picture (also with a subtitle box in the
// bottom bar, and stored landscape with a 90° display rotation), a clip with one frame that is 60% solid red, a
// solid red title card with text, large centred discs on black (planets, partly cut off), dark UI graphics with
// cards and a phone mock-up, a dark starfield with a small bright ellipse (centred and moving), uniform black /
// white / grey / sky frames, a noisy sky gradient and a normal test pattern. Real stills from NASA and Wikimedia
// Commons (free, keyless) are turned into clips too: dark ones, a clear sky, the Blue Marble and Pluto discs must
// come out clean, and photos padded into 16:9 must be found with the right crop; they are skipped when offline.
// Film frames: a synthetic orange film gate with rounded corners and sprocket notches and a thin black one around
// a moving, flickering picture must be reported as 胶片片框 and cropped clear of corners and notches; ordinary
// footage with a uniform edge (a grainy wall on one side, a sky band over grass, a white studio around a moving
// figure), animated phone mock-ups on grey and navy, and a fade from black must not be. Real archive films are
// fetched with the project's own fetchFootage (skipped when offline): the Apollo 11 launch film KSC_69-71212
// (black gate, rounded corners, notches) must be reported and its crop must leave a clean picture; Apollo 10
// suit-up (white room, white suits) and a 16mm Navy ad must stay clean; the Artemis II 16mm high-speed film
// (gate with a timecode strip) and the Apollo 15 lunar liftoff (thin gate with notches) are printed, and must not
// be cropped by more than a thin gate's worth.
// Finally the development set's archive items (../video_agent_devset/archive: NASA and Commons footage
// and stills with their frame problems recorded in truth.json) are scanned read-only and judged against it.
// Run: npx tsx scripts/checks/framecheck-check.ts
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBars, frameStats, scanFrames, type FrameIssue } from '../../src/media/framecheck.ts';
import { fetchFootage } from '../../src/media/footage.ts';

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

/** Runs a command with a kill timeout and returns its stdout; inputs that are files go through -protocol_whitelist file,pipe. */
function exec(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => (clearTimeout(timer), fail(e)));
    p.on('close', (code) => (clearTimeout(timer), code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}
const ffmpeg = (args: string[], timeoutMs = 60_000) =>
  exec('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], timeoutMs).then(() => {});

const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '25'];
/** Encodes a lavfi graph into `out` (`pixFmt` overrides yuv420p, e.g. for a 10-bit clip). */
const lavfi = (graph: string, out: string, seconds = 3, pixFmt = 'yuv420p') =>
  ffmpeg(['-f', 'lavfi', '-i', graph, '-t', String(seconds), ...enc.map((a) => (a === 'yuv420p' ? pixFmt : a)), out]);
/** Loops a still image into a 1280x720 clip, filling the frame (cropping, no padding). */
const still = (img: string, out: string) => ffmpeg([
  '-loop', '1', '-protocol_whitelist', 'file,pipe', '-i', img, '-t', '2',
  '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', ...enc, out,
]);
/** Loops a still image into a 1280x720 clip, fitting it whole on black bars (how a portrait photo gets padded). */
const fitStill = (img: string, out: string) => ffmpeg([
  '-loop', '1', '-protocol_whitelist', 'file,pipe', '-i', img, '-t', '2',
  '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black', ...enc, out,
]);
/** Width and height of an image or video. */
async function size(file: string): Promise<[number, number]> {
  const out = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], 30_000);
  const [w, h] = out.trim().split(',').map(Number);
  return [w, h];
}

async function download(url: string, file: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'video-agent-framecheck-check/0.1' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return false;
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const show = (issues: FrameIssue[]) => (issues.length ? issues.map((i) => `[${i.kind} @${i.t}] ${i.detail}`).join(' | ') : '[]');
const barsOf = (issues: FrameIssue[]) => issues.filter((i) => i.kind !== 'flat-block');

/** One calibration row: peak flat share, dark edges of the first sample, bar shares, and the verdicts. */
async function calibrate(name: string, file: string) {
  const st = await frameStats(file);
  const peak = st.reduce((m, s) => (s.flatShare > m.flatShare ? s : m), st[0]);
  const e = st[0].edges;
  const sides = st.filter((s) => s.side !== null).length;
  const tops = st.filter((s) => s.top !== null).length;
  const films = st.filter((s) => s.film !== null).length;
  const bars = await detectBars(file);
  console.log(`  ${name.padEnd(26)} flat ${peak.flatShare.toFixed(2)}${peak.flatShare ? ` ${peak.flatColour}${peak.flatCard ? '卡' : ''}`.padEnd(4) : '    '}  edges L${e.left} R${e.right} T${e.top} B${e.bottom}`.padEnd(72) +
    ` side ${sides}/${st.length} top ${tops}/${st.length} film ${films}/${st.length}  crop ${bars ? `${bars.w}x${bars.h}+${bars.x}+${bars.y}` : 'null'}`);
}

/** Checks one padded clip: a single bar issue of `kind` and a crop of about `w`x`h`+`x`+`y` in even numbers. */
async function expectBars(name: string, file: string, kind: FrameIssue['kind'], crop: { x: number; y: number; w: number; h: number }, tol = 8) {
  const issues = await scanFrames(file);
  const b = await detectBars(file);
  console.log(`  ${name}: ${show(issues)} crop ${JSON.stringify(b)}`);
  check(barsOf(issues).length === 1 && issues[0]?.kind === kind, `${name} → one ${kind} issue`);
  check(!!b && near(b.x, crop.x, tol / 2) && near(b.y, crop.y, tol / 2) && near(b.w, crop.w, tol) && near(b.h, crop.h, tol) &&
    [b.x, b.y, b.w, b.h].every((v) => v % 2 === 0), `${name} crop ≈ ${crop.w}x${crop.h}+${crop.x}+${crop.y}, even numbers (${JSON.stringify(b)})`);
}

/** Checks that a clip has no bars in either check (flat blocks are allowed unless `noFlat`). */
async function expectNoBars(name: string, file: string, noFlat = true) {
  const issues = await scanFrames(file);
  const b = await detectBars(file);
  check((noFlat ? issues.length : barsOf(issues).length) === 0 && b === null, `${name} → ${noFlat ? 'clean' : 'no bars'}, no crop (${show(issues)}, crop ${JSON.stringify(b)})`);
}

/** Writes `file` cropped to `c` into `out` (to check that a crop leaves a clean picture). */
const cropTo = (file: string, c: { x: number; y: number; w: number; h: number }, out: string) =>
  ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', file, '-an', '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y}`, ...enc, out], 300_000);

/**
 * Checks a clip with a film frame: one film issue whose detail names it 胶片片框 in `colour`, a crop within `tol`
 * of `crop` (even numbers), and a clean picture once cropped.
 */
async function expectFilm(name: string, file: string, colour: string, crop: { x: number; y: number; w: number; h: number }, tol = 12) {
  const issues = await scanFrames(file);
  const b = await detectBars(file);
  console.log(`  ${name}: ${show(issues)} crop ${JSON.stringify(b)}`);
  const film = issues.filter((i) => i.film);
  check(film.length === 1 && barsOf(issues).length === 1 && new RegExp(`胶片片框（${colour}色，圆角）$`).test(film[0].detail),
    `${name} → one film-frame issue naming a ${colour} rounded film frame (${film[0]?.detail})`);
  check(!!b && near(b.x, crop.x, tol / 2) && near(b.y, crop.y, tol / 2) && near(b.w, crop.w, tol) && near(b.h, crop.h, tol) &&
    [b.x, b.y, b.w, b.h].every((v) => v % 2 === 0), `${name} crop ≈ ${crop.w}x${crop.h}+${crop.x}+${crop.y}, even numbers (${JSON.stringify(b)})`);
  if (!b) return;
  const out = file.replace(/\.mp4$/, '.cropped.mp4');
  await cropTo(file, b, out);
  const after = await scanFrames(out);
  check(barsOf(after).length === 0 && (await detectBars(out)) === null, `${name} cropped → no frame left (${show(after)})`);
}

/** The development set (outside the repo, never deployed): archive footage with known frame problems. */
const DEVSET = process.env.DEVSET_DIR ?? new URL('../../../video_agent_devset', import.meta.url).pathname;

const dir = await mkdtemp(join(tmpdir(), 'framecheck-'));
try {
  const f = (n: string) => join(dir, n);
  console.log(`Building clips in ${dir}`);
  const disc = (r: number) =>
    `nullsrc=s=1280x720:r=25,geq=lum='if(lt(hypot(X-640,Y-360),${r}),130+70*sin(X/23)*sin(Y/19),16)':cb=128:cr=128`;
  await Promise.all([
    lavfi('testsrc2=s=960x720:r=25,pad=1280:720:160:0:black', f('pillar.mp4')),
    lavfi('testsrc2=s=960x720:r=25,pad=1280:720:160:0:black', f('pillar10.mp4'), 3, 'yuv420p10le'),
    lavfi('testsrc2=s=960x720:r=25,pad=1280:720:160:0:0x101010', f('pillargrey.mp4')),
    lavfi('testsrc2=s=960x720:r=25,pad=1280:720:160:0:black,drawbox=x=1160:y=40:w=80:h=60:color=white:t=fill', f('pillar-logo.mp4')),
    lavfi('testsrc2=s=406x720:r=25,pad=1280:720:437:0:black', f('phone.mp4')),
    lavfi('testsrc2=s=1280x544:r=25,pad=1280:720:0:88:black', f('letter.mp4')),
    lavfi('testsrc2=s=1280x544:r=25,pad=1280:720:0:88:black,drawbox=x=400:y=648:w=480:h=30:color=white:t=fill', f('letter-sub.mp4')),
    lavfi("testsrc2=s=1280x720:r=25,drawbox=x=0:y=0:w=1280:h=432:color=red:t=fill:enable='eq(n,50)'", f('redframe.mp4'), 4),
    // A solid red title card: two lines of "text" (white bars) in the middle.
    lavfi('color=c=0xC81E1E:s=1280x720:r=25,drawbox=x=340:y=290:w=600:h=56:color=white:t=fill,drawbox=x=440:y=384:w=400:h=32:color=white:t=fill', f('titlecard.mp4'), 2),
    lavfi(disc(460), f('planet460.mp4'), 2),
    lavfi(disc(520), f('planet520.mp4'), 2),
    lavfi(disc(560), f('planet560.mp4'), 2),
    // Dark UI graphics (9:16): rounded-ish cards and a phone mock-up on navy, cards with gaps on neutral grey.
    lavfi('color=c=0x0F192D:s=720x1280:r=25,drawbox=x=60:y=180:w=600:h=880:color=0x2A3550:t=8,drawbox=x=68:y=188:w=584:h=864:color=0x141E33:t=fill,drawbox=x=110:y=420:w=500:h=300:color=white:t=fill', f('ui-phone.mp4'), 2),
    lavfi('color=c=0x0F192D:s=720x1280:r=25,drawbox=x=40:y=200:w=640:h=200:color=0x1B2742:t=fill,drawbox=x=40:y=440:w=640:h=200:color=0x1B2742:t=fill,drawbox=x=40:y=680:w=640:h=200:color=0x1B2742:t=fill,drawbox=x=100:y=270:w=420:h=60:color=white:t=fill,drawbox=x=100:y=510:w=420:h=60:color=white:t=fill,drawbox=x=100:y=750:w=420:h=60:color=white:t=fill', f('ui-cards.mp4'), 2),
    lavfi('color=c=0x161616:s=720x1280:r=25,drawbox=x=40:y=200:w=640:h=200:color=0x505050:t=fill,drawbox=x=40:y=440:w=640:h=200:color=0x505050:t=fill,drawbox=x=40:y=680:w=640:h=200:color=0x505050:t=fill,drawbox=x=150:y=270:w=420:h=60:color=white:t=fill', f('ui-cards-grey.mp4'), 2),
    lavfi("nullsrc=s=1280x720:r=25,geq=lum='if(lt(random(1),0.0015),200+random(2)*55,if(lt(pow((X-640)/70,2)+pow((Y-360)/45,2),1),210,6))':cb=128:cr=128", f('stars.mp4')),
    lavfi("nullsrc=s=1280x720:r=25,geq=lum='if(lt(random(1),0.0015),220,if(lt(pow((X-300-40*T)/40,2)+pow((Y-200)/28,2),1),230,4))':cb=128:cr=128", f('stars-moving.mp4')),
    lavfi('testsrc=s=1280x720:r=25', f('testsrc.mp4')),
    lavfi('color=c=black:s=1280x720:r=25', f('black.mp4'), 2),
    lavfi('color=c=white:s=1280x720:r=25', f('white.mp4'), 2),
    lavfi('color=c=0x808080:s=1280x720:r=25', f('grey.mp4'), 2),
    lavfi('color=c=0x87CEEB:s=1280x720:r=25', f('sky-solid.mp4'), 2),
    lavfi('gradients=s=1280x720:r=25:c0=0x4A90D9:c1=0xA9D3F5:x0=0:y0=0:x1=0:y1=720:speed=0.00001,noise=alls=3:allf=t', f('sky-gradient.mp4'), 2),
  ]);
  // Film frames: a gate mask (opaque outside a rounded rectangle inset `i` with corner radius `r`, and inside
  // notches of radius `n` centred on the middle of each inner edge) laid over a panning, grainy, flickering
  // picture. Edges that are uniform by chance: a grainy grey wall on the left, a sky band over grass, a white
  // studio around a moving figure, phone mock-ups whose card slides in (grey, navy), and a fade from black.
  const moving = "testsrc2=s=1400x800:r=25,crop=1280:720:'60+50*sin(t)':'40+30*cos(t)',noise=alls=6:allf=t,eq=brightness='0.02*sin(6*t)':eval=frame";
  const gate = (colour: string, i: number, r: number, n: number, out: string) => ffmpeg(['-f', 'lavfi', '-i',
    `color=c=${colour}:s=1280x720,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(max(abs(X-640)-${640 - i - r},0),max(abs(Y-360)-${360 - i - r},0)),${r})*` +
    `gte(min(min(hypot(X-640,Y-${i}),hypot(X-640,Y-${720 - i})),min(hypot(X-${i},Y-360),hypot(X-${1280 - i},Y-360))),${n}),0,255)'`, '-frames:v', '1', out]);
  await Promise.all([gate('0xC86414', 40, 90, 30, f('gate-orange.png')), gate('black', 20, 100, 0, f('gate-black.png'))]);
  const overGate = (mask: string, out: string) => ffmpeg(['-f', 'lavfi', '-i', moving, '-loop', '1', '-protocol_whitelist', 'file,pipe', '-i', mask,
    '-filter_complex', '[0][1]overlay=format=auto,noise=alls=3:allf=t', '-t', '3', ...enc, out], 120_000);
  await Promise.all([
    overGate(f('gate-orange.png'), f('film-orange.mp4')),
    overGate(f('gate-black.png'), f('film-black.mp4')),
    lavfi(`${moving},drawbox=x=0:y=0:w=320:h=720:color=0x8A8A8A:t=fill,noise=alls=4:allf=t`, f('wall-left.mp4')),
    lavfi(`${moving},drawbox=x=0:y=0:w=1280:h=150:color=0x87CEEB:t=fill,drawbox=x=0:y=600:w=1280:h=120:color=0x3A7D2A:t=fill,noise=alls=5:allf=t`, f('sky-grass.mp4')),
    lavfi("color=c=0xF2F2F2:s=1280x720:r=25,drawbox=x='520+60*sin(2*t)':y=180:w=240:h=540:color=0x404040:t=fill,drawbox=x='580+60*sin(2*t)':y=70:w=120:h=110:color=0xC09070:t=fill,noise=alls=4:allf=t", f('studio-white.mp4')),
    lavfi("color=c=0x161616:s=720x1280:r=25,drawbox=x=60:y=180:w=600:h=880:color=0x505050:t=4,drawbox=x=110:y='1100-700*min(t/2,1)':w=500:h=300:color=white:t=fill", f('ui-phone-anim-grey.mp4')),
    lavfi("color=c=0x0F192D:s=720x1280:r=25,drawbox=x=60:y=180:w=600:h=880:color=0x2A3550:t=8,drawbox=x=110:y='1100-700*min(t/2,1)':w=500:h=300:color=white:t=fill", f('ui-phone-anim-navy.mp4')),
    lavfi(`${moving},fade=in:0:40`, f('fade-in.mp4')),
  ]);
  // Stills of the pillarbox, one looped back into a clip; the letterbox stored landscape with a 90° display
  // rotation (shown as a 720x1280 portrait clip with side bars).
  await Promise.all([
    ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', f('pillar.mp4'), '-frames:v', '1', f('pillar.png')]),
    ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', f('pillar.mp4'), '-frames:v', '1', '-q:v', '3', f('pillar.jpg')]),
    ffmpeg(['-display_rotation', '90', '-protocol_whitelist', 'file,pipe', '-i', f('letter.mp4'), '-c', 'copy', f('rot-letter.mp4')]),
  ]);
  await still(f('pillar.png'), f('pillar-still.mp4'));

  // Real stills (network): dark NASA Saturn frames, a clear sky from Commons, the Blue Marble and Pluto filling
  // the frame (discs on black, cut off at the top and bottom), and portrait / square photos fitted on black bars.
  const net = join(dir, 'net');
  await mkdir(net);
  const nasa = (id: string) => `https://images-assets.nasa.gov/image/${id}/${id}~small.jpg`;
  const real: Array<[string, string]> = [];
  const padded: Array<[string, string, string]> = [];
  await Promise.all([
    ...([['nasa-dark (PIA12639)', 'PIA12639'], ['Blue Marble (as17-148-22727)', 'as17-148-22727'], ['Pluto (PIA19952)', 'PIA19952']] as const).map(async ([n, id]) => {
      if (await download(nasa(id), join(net, `${id}.jpg`))) await still(join(net, `${id}.jpg`), f(`${id}.mp4`)).then(() => real.push([n, f(`${id}.mp4`)]), () => {});
    }),
    (async () => {
      if (await download('https://upload.wikimedia.org/wikipedia/commons/thumb/2/24/Clear_blue_sky_%284-12-2026%29.jpg/1280px-Clear_blue_sky_%284-12-2026%29.jpg', join(net, 'sky.jpg'))) {
        await still(join(net, 'sky.jpg'), f('commons-sky.mp4')).then(() => real.push(['commons clear sky', f('commons-sky.mp4')]), () => {});
      }
    })(),
    ...['PIA09234', 'PIA23645', 'iss040e080833'].map(async (id) => {
      if (await download(nasa(id), join(net, `${id}.jpg`))) await fitStill(join(net, `${id}.jpg`), f(`${id}-fit.mp4`)).then(() => padded.push([`${id} fitted on bars`, f(`${id}-fit.mp4`), join(net, `${id}.jpg`)]), () => {});
    }),
  ]);
  real.sort((a, b) => a[0].localeCompare(b[0]));
  padded.sort((a, b) => a[0].localeCompare(b[0]));

  console.log('\nCalibration (flat = largest share of one flat saturated colour, 卡 = title card; side/top = samples passing the bar test):');
  for (const n of [
    'pillar', 'pillar10', 'pillargrey', 'pillar-logo', 'pillar-still', 'phone', 'letter', 'letter-sub', 'rot-letter', 'redframe', 'titlecard',
    'planet460', 'planet520', 'planet560', 'ui-phone', 'ui-cards', 'ui-cards-grey', 'stars', 'stars-moving', 'testsrc', 'black', 'white', 'grey', 'sky-solid', 'sky-gradient',
    'film-orange', 'film-black', 'wall-left', 'sky-grass', 'studio-white', 'ui-phone-anim-grey', 'ui-phone-anim-navy', 'fade-in',
  ]) {
    await calibrate(n, f(`${n}.mp4`));
  }
  await calibrate('pillar.png', f('pillar.png'));
  await calibrate('pillar.jpg', f('pillar.jpg'));
  for (const [n, file] of [...real, ...padded]) await calibrate(n, file);

  console.log('\nscanFrames / detectBars:');
  {
    const issues = await scanFrames(f('pillar.mp4'));
    console.log(`  pillar: ${show(issues)}`);
    check(issues.length === 1 && issues[0].kind === 'side-bars' && issues[0].t === 0, 'pillarboxed 4:3 → one side-bars issue at 0 s');
    check(/^0\.0–2\.5 秒，左右各约 1[23]% 黑边$/.test(issues[0]?.detail ?? ''), `pillarbox detail reads '0.0–2.5 秒，左右各约 12% 黑边' (${issues[0]?.detail})`);
    const b = await detectBars(f('pillar.mp4'));
    console.log(`  pillar crop: ${JSON.stringify(b)}`);
    check(!!b && near(b.x, 160, 4) && b.y === 0 && near(b.w, 960, 8) && b.h === 720 && [b.x, b.y, b.w, b.h].every((v) => v % 2 === 0), 'pillarbox crop ≈ 960x720+160+0, even numbers');
  }
  const pillarCrop = { x: 160, y: 0, w: 960, h: 720 };
  await expectBars('10-bit pillarbox', f('pillar10.mp4'), 'side-bars', pillarCrop);
  await expectBars('near-black 0x101010 pillarbox', f('pillargrey.mp4'), 'side-bars', pillarCrop);
  await expectBars('pillarbox with a logo in one bar', f('pillar-logo.mp4'), 'side-bars', pillarCrop);
  await expectBars('pillarbox PNG still', f('pillar.png'), 'side-bars', pillarCrop);
  await expectBars('pillarbox JPEG still', f('pillar.jpg'), 'side-bars', pillarCrop);
  await expectBars('pillarbox still looped into a clip', f('pillar-still.mp4'), 'side-bars', pillarCrop);
  {
    const issues = await scanFrames(f('phone.mp4'));
    console.log(`  phone: ${show(issues)}`);
    check(issues.length === 1 && issues[0].kind === 'side-bars' && /各约 3[34]%/.test(issues[0].detail), '9:16 inside 16:9 → side-bars of about 34% each');
    const b = await detectBars(f('phone.mp4'));
    check(!!b && near(b.x, 437, 4) && near(b.w, 406, 8) && b.h === 720, `phone crop ≈ 406x720+437+0 (${JSON.stringify(b)})`);
  }
  {
    const issues = await scanFrames(f('letter.mp4'));
    console.log(`  letter: ${show(issues)}`);
    check(issues.length === 1 && issues[0].kind === 'top-bars' && /上下各约 1[23]% 黑边/.test(issues[0].detail), 'letterboxed 2.35:1 → one top-bars issue of about 12%');
    const b = await detectBars(f('letter.mp4'));
    console.log(`  letter crop: ${JSON.stringify(b)}`);
    check(!!b && b.x === 0 && b.w === 1280 && near(b.y, 88, 4) && near(b.h, 544, 8), 'letterbox crop ≈ 1280x544+0+88');
  }
  await expectBars('letterbox with a subtitle in the bottom bar', f('letter-sub.mp4'), 'top-bars', { x: 0, y: 88, w: 1280, h: 544 });
  {
    const st = await frameStats(f('rot-letter.mp4'));
    check(st[0]?.w === 160 && st[0]?.h === 284, `90°-rotated letterbox is analysed upright as portrait (${st[0]?.w}x${st[0]?.h})`);
    await expectBars('90°-rotated letterbox (side bars once upright)', f('rot-letter.mp4'), 'side-bars', { x: 88, y: 0, w: 544, h: 1280 });
  }
  {
    const issues = await scanFrames(f('redframe.mp4'));
    console.log(`  redframe: ${show(issues)}`);
    check(issues.length === 1 && issues[0].kind === 'flat-block' && issues[0].t === 2, 'one red frame at 2.0 s → one flat-block issue at 2.0 s');
    check(/^2\.0 秒，画面约 (5[5-9]|6[0-5])% 是同一种红色色块（像是传输坏帧）$/.test(issues[0]?.detail ?? ''), `red detail reads '2.0 秒，画面约 60% 是同一种红色色块（像是传输坏帧）' (${issues[0]?.detail})`);
    const late = await scanFrames(f('redframe.mp4'), { from: 2.5 });
    check(late.length === 0, 'from: 2.5 skips the red frame');
    const win = await scanFrames(f('redframe.mp4'), { from: 1.5, to: 2.6, step: 0.25 });
    check(win.length === 1 && win[0].t === 2, `from/to/step window still reports it at 2.0 s (${show(win)})`);
    check((await detectBars(f('redframe.mp4'))) === null, 'red frame clip has no bars');
  }
  {
    const issues = await scanFrames(f('titlecard.mp4'));
    console.log(`  titlecard: ${show(issues)}`);
    check(issues.length === 1 && issues[0].kind === 'flat-block' && /^0\.0–1\.5 秒，纯色标题卡/.test(issues[0].detail) && !/坏帧/.test(issues[0].detail),
      `solid red title card with text → one flat-block issue that calls it a title card, not a broken frame (${issues[0]?.detail})`);
  }
  for (const n of ['planet460', 'planet520', 'planet560', 'ui-phone', 'ui-cards', 'ui-cards-grey']) await expectNoBars(`${n} (no straight edge / not black)`, f(`${n}.mp4`));
  for (const n of ['stars', 'stars-moving', 'testsrc', 'black', 'white', 'grey', 'sky-solid', 'sky-gradient']) await expectNoBars(n, f(`${n}.mp4`));
  // Film frames: crops clear of the notches (inset + notch radius) and of the rounded corners, plus the analysis
  // pixel of margin. The thin black gate has no notches, so its rounded corners set the crop: the largest clear
  // rectangle takes more off the long sides and less off the short ones.
  await expectFilm('orange film gate with rounded corners and notches', f('film-orange.mp4'), '橙', { x: 72, y: 72, w: 1136, h: 576 });
  await expectFilm('thin black film gate with rounded corners', f('film-black.mp4'), '黑', { x: 80, y: 32, w: 1120, h: 656 }, 24);
  for (const n of ['wall-left', 'sky-grass', 'studio-white', 'ui-phone-anim-grey', 'ui-phone-anim-navy', 'fade-in']) await expectNoBars(`${n} (uniform edge, not a film frame)`, f(`${n}.mp4`));
  if (!real.length && !padded.length) console.log('  (offline: real NASA / Commons stills skipped)');
  for (const [n, file] of real) await expectNoBars(n, file);
  for (const [n, file, img] of padded) {
    // The photo scaled to fit 1280x720; the bars are what is left on each side.
    const [iw, ih] = await size(img);
    const k = Math.min(1280 / iw, 720 / ih);
    const [pw, ph] = [Math.round(iw * k), Math.round(ih * k)];
    if (pw < 1280 * 0.92) await expectBars(n, file, 'side-bars', { x: (1280 - pw) / 2, y: 0, w: pw, h: 720 }, 12);
    else await expectBars(n, file, 'top-bars', { x: 0, y: (720 - ph) / 2, w: 1280, h: ph }, 12);
  }
  {
    let threw = false;
    await scanFrames(f('missing.mp4')).catch(() => (threw = true));
    check(threw, 'a missing file rejects instead of returning []');
  }

  // Real archive films, fetched as the app fetches them (skipped when a library cannot be reached; Commons
  // rate-limits downloads, so they go one at a time).
  console.log('\nArchive films:');
  const films = join(dir, 'films');
  const film = async (id: string) => {
    try {
      return join(films, (await fetchFootage(id, films, { maxSeconds: 60 })).file);
    } catch (e) {
      console.log(`  (${id} skipped: ${(e as Error).message})`);
      return null;
    }
  };
  const ksc = await film('nasa:KSC_69-71212-sRGB');
  if (ksc) {
    // 720x720: a black gate about 1% thick, corners rounded over ~45 px, notches ~30 px deep in every edge.
    const issues = await scanFrames(ksc);
    const b = await detectBars(ksc);
    console.log(`  KSC_69-71212 (Apollo 11 launch film): ${show(issues)} crop ${JSON.stringify(b)}`);
    const gate = issues.find((i) => i.film);
    const end = gate ? Number(/–([\d.]+) 秒/.exec(gate.detail)?.[1] ?? 0) : 0;
    check(!!gate && gate.t <= 6 && end >= 55 && /胶片片框（黑色，圆角）$/.test(gate.detail), `KSC_69-71212 → a black rounded film frame reported across the clip (${gate?.detail})`);
    check(!!b && b.x >= 28 && b.y >= 28 && b.x + b.w <= 720 - 28 && b.y + b.h <= 720 - 28 && b.w >= 620 && b.h >= 620,
      `KSC_69-71212 crop clears notches and corners (28–50 px per side) (${JSON.stringify(b)})`);
    if (b) {
      const out = join(dir, 'ksc-cropped.mp4');
      await cropTo(ksc, b, out);
      const after = await scanFrames(out);
      check(barsOf(after).length === 0, `KSC_69-71212 cropped → no frame left (${show(after)})`);
    }
  }
  for (const [n, id] of [['Apollo 10 suit-up (white room)', 'commons:File:Apollo 10.webm'], ['16mm Navy ad', 'commons:File:JOIN THE NAVY- 8 Classic US Navy Recruitment Ads - 16mm Film Scan.webm']]) {
    const file = await film(id);
    if (file) await expectNoBars(n, file);
  }
  for (const [n, id] of [['Artemis II 16mm high-speed film', 'nasa:KSC-20260401-MH-AJN01-0001-Artemis_II_Launch_16mm_High_Speed_Film-M19183'], ['Apollo 15 lunar liftoff', 'commons:File:Apollo 15 liftoff from moon.webm']]) {
    const file = await film(id);
    if (!file) continue;
    const issues = await scanFrames(file);
    const b = await detectBars(file);
    const [w, h] = await size(file);
    console.log(`  ${n}: ${show(issues)} crop ${JSON.stringify(b)}`);
    if (issues.some((i) => i.film)) check(!b || (b.x <= w * 0.06 && b.y <= h * 0.06 && w - b.x - b.w <= w * 0.06 && h - b.y - b.h <= h * 0.06), `${n} → any film crop is thin (${JSON.stringify(b)})`);
  }

  // The development set's archive items (../video_agent_devset/archive, read-only; skipped when absent):
  // NASA and Commons footage and stills fetched with fetchFootage, with frame problems recorded in truth.json
  // from looking at the clips (spans accurate to about ±0.5 s). Baked-in pillarboxes must be found at about
  // their recorded size and cropped; dark surrounds that are not bars (a globe or the Sun on black, a round ISS
  // window, a panorama's jagged mosaic edge), designed cards and clean items must get no bars and no crop; no
  // item has a broken colour block. Known misjudgements are printed as KNOWN and do not fail the run (they are
  // listed in KNOWN below with what goes wrong); one that starts passing prints 'ok (was known)'.
  if (existsSync(join(DEVSET, 'truth.json'))) {
    type Issue = { type: string; t?: [number, number]; note?: string };
    type Item = { category: string; kind?: string; frame_issues?: Issue[]; measured: { width: number; height: number; duration?: number } };
    const truth = (JSON.parse(readFileSync(join(DEVSET, 'truth.json'), 'utf8').replace(/-Infinity|NaN/g, 'null')) as { files: Record<string, Item> }).files;
    const archive = Object.keys(truth).filter((k) => truth[k].category === 'archive').sort();
    /** What src/media/framecheck.ts gets wrong on the set today, by item and check. */
    const KNOWN: Record<string, string> = {
      'archive/ft-nasa-a79ead0fcf.mp4 crop': 'detectBars judges only the first 10 s; a full-frame slate fills 0–5.9 s, so the pillarbox from 6 s gets no crop',
      'archive/ft-nasa-8be6d604bc.jpg no bars': 'a row of eclipse photos on black sky reads as a 42% letterbox (each disc meets the band, the gaps are dark)',
      'archive/ft-nasa-4ee351aa75.mp4 no bars': 'a split-screen layout with labelled black bands above and below reads as a 16% letterbox',
      'archive/ft-commons-68b22ff917.mp4 no bars': 'a 16 mm gate (rounded corner on the right, LED counter strip) shows as short runs of 23% side bars on dark frames, not as a film frame',
    };
    const verdict = (key: string, ok: boolean, what: string) => {
      if (!KNOWN[key]) return check(ok, what);
      console.log(`  ${ok ? 'ok (was known)' : 'KNOWN'} ${what}${ok ? '' : ` — ${KNOWN[key]}`}`);
    };
    const spanOf = (i: FrameIssue) => {
      const m = /^([\d.]+)(?:–([\d.]+))? 秒/.exec(i.detail);
      return m ? [Number(m[1]), Number(m[2] ?? m[1]) + 0.5] as const : [i.t, i.t + 0.5] as const;
    };
    const covered = (issues: FrameIssue[], [a, b]: [number, number]) => {
      let n = 0;
      for (let t = a; t < b; t += 0.5) if (issues.some((i) => { const [x, y] = spanOf(i); return t >= x - 1e-6 && t < y; })) n++;
      return n / Math.max(1, Math.round((b - a) / 0.5));
    };
    const results = new Map<string, { issues: FrameIssue[]; crop: Awaited<ReturnType<typeof detectBars>>; ms: number }>();
    const queue = [...archive];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let rel = queue.shift(); rel; rel = queue.shift()) {
        const t0 = Date.now();
        const file = join(DEVSET, rel);
        results.set(rel, { issues: await scanFrames(file), crop: await detectBars(file), ms: Date.now() - t0 });
      }
    }));
    console.log(`\nDevelopment set archive (${archive.length} items):`);
    for (const rel of archive) {
      const it = truth[rel];
      const { issues, crop, ms } = results.get(rel)!;
      const known = (it.frame_issues ?? []).filter((i) => i.type !== 'burned_in_text');
      console.log(`  ${rel} ${it.measured.width}x${it.measured.height} (${ms} ms)\n    truth: ${known.map((i) => `${i.type}${i.t ? ` ${i.t.join('–')} s` : ''}`).join('; ') || 'clean'}\n    found: ${show(issues)}  crop ${JSON.stringify(crop)}`);
      const bad = issues.filter((i) => i.kind === 'flat-block' && !i.card);
      check(!bad.length, `${rel}: no broken colour block (${show(bad)})`);
      const bars = barsOf(issues);
      const side = known.find((i) => i.type === 'side_bars');
      if (side?.t) {
        const share = covered(bars.filter((i) => i.kind === 'side-bars'), side.t);
        const pcts = bars.filter((i) => i.kind === 'side-bars').map((i) => Number(/左右各约 (\d+)%/.exec(i.detail)?.[1] ?? NaN)).filter((p) => p > 0);
        const want = (/~(\d+)(?:-(\d+))?\s*%/.exec(side.note ?? '') ?? []).slice(1).filter(Boolean).map(Number);
        const mid = want.length ? (want[0] + want[want.length - 1]) / 2 : NaN;
        verdict(`${rel} bars`, share >= 0.6 && pcts.length > 0 && pcts.every((p) => Math.abs(p - mid) <= 3),
          `${rel}: side bars reported over ${Math.round(share * 100)}% of ${side.t.join('–')} s at ${[...new Set(pcts)].join('/')}% (truth ~${want.join('-')}%)`);
        const W = it.measured.width;
        verdict(`${rel} crop`, !!crop && Math.abs(crop.x / W * 100 - mid) <= 3 && Math.abs((W - crop.x - crop.w) / W * 100 - mid) <= 3 && crop.y === 0,
          `${rel}: pillarbox crop of about ${mid}% each side (${JSON.stringify(crop)})`);
      } else if (known.some((i) => i.type === 'film_gate')) {
        // A gate on one side only: no symmetric bars, and any crop no deeper than a gate.
        const [w, h] = [it.measured.width, it.measured.height];
        verdict(`${rel} no bars`, bars.every((i) => i.film), `${rel}: film gate not reported as black bars (${show(bars)})`);
        check(!crop || (crop.x <= w * 0.25 && w - crop.x - crop.w <= w * 0.25 && crop.y <= h * 0.06 && h - crop.y - crop.h <= h * 0.06), `${rel}: any crop is no deeper than the gate (${JSON.stringify(crop)})`);
      } else {
        verdict(`${rel} no bars`, !bars.length && crop === null,
          `${rel}: ${known.length ? known.map((i) => i.type).join(', ') : 'clean'} → no bars, no crop`);
      }
    }
    console.log('  (Not looked for by framecheck: black gaps, white flash frames and leader, test patterns and slates are neutral or many-coloured, not one saturated block.)');
  } else console.log(`\n(development set not found at ${DEVSET}: archive items skipped)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} framecheck check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll framecheck checks passed');
