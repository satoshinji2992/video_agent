// Frame-level checks on footage before it goes into a cut. Free libraries (NASA, Wikimedia Commons) ship clips
// with black bars baked into the picture (a square spacecraft frame pillarboxed inside 16:9) and with garbage
// frames (a partially transmitted image that is mostly one solid colour, like a probe's last half-received frame). Both look
// broken once composed, so they are found here by decoding small RGB frames in a single ffmpeg pass and judged
// with simple statistics. Dark space with a bright object is the classic false positive for both checks: it is
// dark at every edge and it contains flat areas, so bars must be neutral black meeting the picture along a
// straight inner edge (a planet's rim or a rounded card only touches the band near its widest point) and colour
// blocks must be saturated and exactly uniform. Scanned archive film adds a third kind: the camera gate around
// the picture, a band of any film colour (black, the orange film base) that is often too thin for a bar, with
// rounded corners and sprocket notches. It is told from walls, sky and designed frames by time: the band stays
// exactly still while the picture beside it lives. Everything is measured in displayed coordinates (after the
// rotation in the file's metadata). Every decode runs as an async child with a kill timeout (a synchronous call
// would freeze the server) and reads its input from the local disk only.
import { spawn } from 'node:child_process';

/** One problem found in a clip; consecutive sampled frames with the same problem are merged into one issue. */
export interface FrameIssue {
  /** Seconds from the start of the file at which the problem is first seen. */
  t: number;
  kind: 'flat-block' | 'side-bars' | 'top-bars';
  /** Chinese text for the user, e.g. '0.0–3.5 秒，左右各约 12% 黑边' or '0.0–9.5 秒，上下各约 4%、左右各约 5% 胶片片框（黑色，圆角）'. */
  detail: string;
  /** A flat block with text or a logo inside: a designed solid-colour title card, not a broken frame. */
  card?: boolean;
  /**
   * Bars found as a film frame (a stable band of one colour, often thin with rounded corners and sprocket
   * notches) rather than by the black-bar test; detail names its colour.
   */
  film?: boolean;
}

/** Width of the decoded analysis frames, in pixels. */
const SMALL_W = 160;
/** Side of the square cells used by the flat-block test. */
const CELL = 8;
/**
 * A cell is flat when no channel has a standard deviation above this (0–255 scale). Solid garbage fills measure
 * 0 even after re-encoding; clear sky keeps ~1 from its gradient and grain (see scripts/checks/framecheck-check.ts).
 */
const FLAT_SD = 0.5;
/**
 * A cell is a saturated colour when max−min of its mean RGB reaches FLAT_MIN_CHROMA, that difference is at least
 * FLAT_MIN_SAT of the brightest channel, and the brightest channel reaches FLAT_MIN_MAX (so black, white, grey
 * and dark space never qualify).
 */
const FLAT_MIN_CHROMA = 48;
const FLAT_MIN_SAT = 0.4;
const FLAT_MIN_MAX = 64;
/** Cells belong to the same colour when every channel mean is within this of the seed cell. */
const FLAT_SAME = 4;
/**
 * Sky blues (hue 180–240°, HSV saturation below 0.75) never count, even when perfectly uniform: a clean
 * rendered sky has no grain to tell it from a fill. Fully saturated blue garbage is still caught.
 */
const SKY_HUE: [number, number] = [180, 240];
const SKY_MAX_SAT = 0.75;
/** Share of the picture one flat saturated colour must cover to count as a broken frame. */
const FLAT_SHARE = 0.35;
/**
 * A flat block with at least CARD_CELLS other cells enclosed by it (text, a logo), or covering at least
 * CARD_FULL of the frame (a title card before its text fades in), reads as a designed solid-colour card rather
 * than a broken frame: a partially transmitted frame's fill runs out to the picture's edge beside real picture.
 */
const CARD_CELLS = 2;
const CARD_FULL = 0.95;
/** Luma at or below which a pixel counts as bar black (rgb24 from limited-range video maps black to 0). */
const DARK_MEAN = 24;
const DARK_MAX = 56;
/**
 * A column / row is bar when its median is at most DARK_MEAN and at least DARK_SHARE of its pixels are at most
 * DARK_MAX, so stars or a small channel logo in the bar do not end it.
 */
const DARK_SHARE = 0.92;
/**
 * Bars are neutral: most lines of a band must have a median chroma (max−min of R, G, B) of at most this. The
 * navy or brown backgrounds of designed dark graphics, around a phone mock-up or rounded cards, are not bars.
 */
const BAR_CHROMA = 12;
/** Lines beside a band cut short by a subtitle or logo still count as bar when this share of them is dark. */
const BAR_MOSTLY = 0.5;
/** A pixel at the picture's edge is "picture" when brighter than this. */
const FILL_LUMA = 32;
/**
 * The picture meets a bar along a straight edge: on at least EDGE_SHARE of the lines crossing the edge, picture
 * starts right at it (2 of the first EDGE_PX analysis pixels). A disc's rim (Blue Marble, Pluto) or a rounded UI
 * card only reaches the band near its widest point; cards with gaps between them cover too few lines. A pixel is
 * picture when brighter than FILL_LUMA or at least EDGE_DIFF away from the bar's level on its line.
 */
const EDGE_PX = 4;
const EDGE_SHARE = 0.8;
const EDGE_DIFF = 6;
/** Minimum bar size as a share of the width (side bars) or height (top bars). */
const BAR_MIN = 0.04;
/** Bars on all four sides may take at most this share of each dimension together. */
const BOX_MAX = 0.5;
/**
 * cropdetect's black limit on 8-bit limited-range video (black = 16): 32/255 still counts near-black bars
 * (0x101010 → 30) as black. Its edges are only used where they agree with the analysis frame.
 */
const CROP_LIMIT = (32 / 255).toFixed(4);
/**
 * Film frames: scanned archive film keeps the camera gate around the picture, a thin band of one colour (black,
 * grey, the orange film base) with rounded corners and sprocket notches reaching in from the edges. Unlike black
 * bars it may be any colour and too thin for BAR_MIN, so it is judged over several frames: a pixel is band when
 * every channel stays within FILM_TOL of the band's colour on at least FILM_STABLE of the frames, and the band is
 * what such pixels reach from the edges.
 */
const FILM_TOL = 16;
const FILM_STABLE = 0.8;
/** Frames at least this share in the band's colour (a fade, black leader) are left out of the judgement. */
const FILM_BLANK = 0.9;
/** Frames judged together (at least FILM_FRAMES, else no verdict): FILM_WINDOW seconds of samples in scanFrames. */
const FILM_FRAMES = 3;
const FILM_WINDOW = 6;
/**
 * A side has a band when its outermost line is band on at least FILM_EDGE of its length and the band's depth on
 * the middle 60% of the crossing lines (its core) is at least one pixel and at most FILM_MAX of the dimension,
 * with FILM_EDGE of the lines between 10% and 90% no more than one pixel deeper (a straight inner edge; corners
 * and notches are the exceptions).
 */
const FILM_EDGE = 0.75;
const FILM_MAX = 0.25;
/**
 * The picture inside lives right up to the band: the median, over the pixels within FILM_RING of the crop's
 * edges, of the median frame-to-frame luma change is at least FILM_JITTER (film grain, exposure flicker, motion),
 * and the band's own median is at most FILM_CALM of that. A frame drawn around a still picture, or a wall that
 * is as grainy as the picture beside it, does not pass.
 */
const FILM_RING = 2;
const FILM_JITTER = 0.6;
const FILM_CALM = 0.5;
/** ...and at most FILM_STILL: a gate is printed still, dark motion graphics around a picture are not. */
const FILM_STILL = 1;
/**
 * Film bands are neutral (black, grey, white) or a warm film-base colour (red to yellow, hue below FILM_HUE°):
 * navy and teal backgrounds of designed graphics, sky and grass are not film frames.
 */
const FILM_HUE = 60;
/** A film frame is reported only when the crop takes at least this share of the width or height on some side. */
const FILM_MIN = 0.02;

// ---------------------------------------------------------------------------------------------------------
// Running ffmpeg / ffprobe

/** Runs a command with a kill timeout. Callers must put '-protocol_whitelist','file,pipe' before every input. */
function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  onStdout?: (b: Buffer) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => {
      if (onStdout) onStdout(d);
      else if (out.length < 1 << 20) out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 4 << 20) err = err.slice(-(1 << 20));
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`画面检查超时（${cmd} 超过 ${Math.round(timeoutMs / 1000)} 秒未完成）`));
      else if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`));
      else resolvePromise({ stdout: out, stderr: err });
    });
  });
}

const safeIn = (file: string) => ['-protocol_whitelist', 'file,pipe', '-i', file];

/** Displayed size (width and height swapped when the file is rotated by ±90°) and duration (0 for stills). */
interface Probe { width: number; height: number; duration: number }

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json', file,
  ], 30_000);
  const j = JSON.parse(stdout) as {
    streams?: Array<{
      width?: number; height?: number; duration?: string;
      tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number | string }>;
    }>;
    format?: { duration?: string };
  };
  const s = j.streams?.[0];
  if (!s?.width || !s.height) throw new Error('文件里没有视频画面');
  const duration = Number(j.format?.duration) || Number(s.duration) || 0;
  // ffmpeg rotates decoded frames upright (phone clips are often stored landscape with a 90° display matrix),
  // so every frame decoded here and every cropdetect result is in displayed coordinates.
  const rotation = Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0) || 0;
  const turned = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return turned ? { width: s.height, height: s.width, duration } : { width: s.width, height: s.height, duration };
}

const smallHeight = (p: Probe) => Math.max(2, Math.round((SMALL_W * p.height) / p.width / 2) * 2);

/**
 * Decodes `span` seconds from `from` at `fps` frames per second (a rational string) as SMALL_W-wide rgb24 frames
 * in one ffmpeg pass, handing each complete frame to `onFrame` as it arrives. Frame `index` shows the source at
 * exactly `from + index / fps` (or the frame just before it): round=up picks the frame at the tick rather than
 * one up to half a step later, and start_time=0 pins the ticks to the seek point even when the first decoded
 * frame lands a little after it.
 */
async function decodeSmall(
  file: string, p: Probe, from: number, span: number, fps: string, onFrame: (rgb: Buffer, index: number) => void,
): Promise<void> {
  const h = smallHeight(p);
  const size = SMALL_W * h * 3;
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...(from > 0 ? ['-ss', from.toFixed(3)] : []),
    ...(Number.isFinite(span) && span > 0 ? ['-t', span.toFixed(3)] : []),
    ...safeIn(file),
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${fps}:round=up:start_time=0,scale=${SMALL_W}:${h}:flags=area,format=rgb24`,
    '-f', 'rawvideo', 'pipe:1',
  ];
  const seconds = Number.isFinite(span) && span > 0 ? span : p.duration || 600;
  await run('ffmpeg', args, Math.min(600_000, 30_000 + seconds * 2_000), (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= size) {
      onFrame(pending.subarray(0, size), index++);
      pending = pending.subarray(size);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// Per-frame statistics

/** Luma and chroma (max−min of R, G, B) of each pixel of an rgb24 frame. */
const planesOf = (rgb: Buffer): { y: Float32Array; c: Float32Array } => {
  const y = new Float32Array(rgb.length / 3);
  const c = new Float32Array(y.length);
  for (let i = 0, j = 0; i < y.length; i++, j += 3) {
    const [r, g, b] = [rgb[j], rgb[j + 1], rgb[j + 2]];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    c[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { y, c };
};

/** HSV hue in degrees (0 for greys). */
function hueOf([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

interface Flat {
  share: number;
  rgb: [number, number, number];
  /** Other cells (text, a logo) are enclosed by the block: a designed solid-colour card, not a broken frame. */
  card: boolean;
}

/** The largest area of one flat, saturated, near-identical colour, as a share of the frame (null when none). */
function flatBlock(rgb: Buffer, w: number, h: number): Flat | null {
  const cols = Math.floor(w / CELL);
  const rows = Math.floor(h / CELL);
  const cells: Array<[number, number, number]> = [];
  /** Index into `cells` per grid cell, -1 for cells that are not flat saturated colour. */
  const grid = new Int32Array(cols * rows).fill(-1);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const sum = [0, 0, 0];
      const sq = [0, 0, 0];
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
          const o = (y * w + x) * 3;
          for (let c = 0; c < 3; c++) {
            sum[c] += rgb[o + c];
            sq[c] += rgb[o + c] * rgb[o + c];
          }
        }
      }
      const n = CELL * CELL;
      const mean = sum.map((s) => s / n) as [number, number, number];
      const sd = Math.max(...sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c]))));
      const hi = Math.max(...mean);
      const chroma = hi - Math.min(...mean);
      if (sd > FLAT_SD || hi < FLAT_MIN_MAX || chroma < FLAT_MIN_CHROMA || chroma < hi * FLAT_MIN_SAT) continue;
      const hue = hueOf(mean);
      if (hue >= SKY_HUE[0] && hue <= SKY_HUE[1] && chroma < hi * SKY_MAX_SAT) continue;
      grid[cy * cols + cx] = cells.length;
      cells.push(mean);
    }
  }
  const total = cols * rows;
  if (!total || !cells.length) return null;
  const same = (c: [number, number, number], seed: [number, number, number]) =>
    Math.abs(c[0] - seed[0]) <= FLAT_SAME && Math.abs(c[1] - seed[1]) <= FLAT_SAME && Math.abs(c[2] - seed[2]) <= FLAT_SAME;
  let best = 0;
  let bestRgb = cells[0];
  for (const seed of cells) {
    let n = 0;
    for (const c of cells) if (same(c, seed)) n++;
    if (n > best) {
      best = n;
      bestRgb = seed;
    }
  }
  if (!best) return null;
  // Flood the other cells in from the frame's border; any left unreached are enclosed by the block.
  const inBlock = (i: number) => grid[i] >= 0 && same(cells[grid[i]], bestRgb);
  const reached = new Uint8Array(total);
  const stack: number[] = [];
  for (let i = 0; i < total; i++) {
    const cx = i % cols;
    const cy = (i - cx) / cols;
    if ((cx === 0 || cy === 0 || cx === cols - 1 || cy === rows - 1) && !inBlock(i)) {
      reached[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const cx = i % cols;
    for (const j of [cx > 0 ? i - 1 : -1, cx < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
      if (j >= 0 && j < total && !reached[j] && !inBlock(j)) {
        reached[j] = 1;
        stack.push(j);
      }
    }
  }
  let enclosed = 0;
  for (let i = 0; i < total; i++) if (!reached[i] && !inBlock(i)) enclosed++;
  return { share: best / total, rgb: bestRgb, card: enclosed >= CARD_CELLS || best / total >= CARD_FULL };
}

/** Dark columns / rows from each edge of an analysis frame. */
export interface Edges { left: number; right: number; top: number; bottom: number }

/** Share of the pixels along column `line` (vertical) or row `line` that are at most `max`. */
function darkShare(y: Float32Array, w: number, h: number, line: number, vertical: boolean, max: number): number {
  const n = vertical ? h : w;
  let k = 0;
  for (let i = 0; i < n; i++) if (y[vertical ? i * w + line : line * w + i] <= max) k++;
  return k / n;
}

/** Counts the dark columns and rows running in from each edge of a luma frame. */
function darkEdges(y: Float32Array, w: number, h: number): Edges {
  const dark = (line: number, vertical: boolean) =>
    darkShare(y, w, h, line, vertical, DARK_MEAN) >= 0.5 && darkShare(y, w, h, line, vertical, DARK_MAX) >= DARK_SHARE;
  let left = 0;
  while (left < w && dark(left, true)) left++;
  let right = 0;
  while (right < w - left && dark(w - 1 - right, true)) right++;
  let top = 0;
  while (top < h && dark(top, false)) top++;
  let bottom = 0;
  while (bottom < h - top && dark(h - 1 - bottom, false)) bottom++;
  return { left, right, top, bottom };
}

/**
 * Whether the picture meets a band along a straight edge: `line` is the first line past the band and `dir` (±1)
 * points inward. On at least EDGE_SHARE of the crossing lines r0..r1-1, at least 2 of the EDGE_PX pixels from
 * `line` inward must be picture: brighter than FILL_LUMA, or at least EDGE_DIFF away from the bar beside it on
 * the same crossing line (dark trees or shadow at the edge of a pillarboxed photo). Space around a planet, or a
 * UI background between cards, matches the bar and is not picture; a thin frame line drawn on a chart's black
 * margin is one pixel deep and is not enough. One pixel may be a blend of bar and picture after downscaling.
 */
function straightEdge(
  y: Float32Array, w: number, size: number, line: number, dir: number, vertical: boolean, r0: number, r1: number,
): boolean {
  if (r1 <= r0) return false;
  const at = (i: number, l: number) => y[vertical ? i * w + l : l * w + i];
  const bar: number[] = [];
  let n = 0;
  for (let i = r0; i < r1; i++) {
    // The bar's level on this crossing line: median of a few bar pixels, skipping the one next to the edge.
    bar.length = 0;
    for (let k = 2; k <= 7; k++) {
      const l = line - k * dir;
      if (l >= 0 && l < size) bar.push(at(i, l));
    }
    bar.sort((a, b) => a - b);
    const ref = bar.length ? bar[bar.length >> 1] : 0;
    let picture = 0;
    for (let k = 0; k < EDGE_PX; k++) {
      const l = line + k * dir;
      if (l < 0 || l >= size) break;
      const v = at(i, l);
      if (v > FILL_LUMA || Math.abs(v - ref) >= EDGE_DIFF) picture++;
    }
    if (picture >= 2) n++;
  }
  return n >= (r1 - r0) * EDGE_SHARE;
}

interface Bars {
  side: number | null;
  top: number | null;
  /** The bands as judged, after evening out a band cut short by a subtitle or logo. */
  e: Edges;
}

/**
 * Bar sizes (share of width / height, average of the two sides) when a frame has symmetric dark bands that meet
 * the picture along straight inner edges, else null per axis.
 */
function bars(y: Float32Array, c: Float32Array, w: number, h: number): Bars {
  const e = darkEdges(y, w, h);
  // A subtitle or logo inside one bar ends that band early: take the other band's size when the lines between
  // are still mostly dark. The straight-edge test below still has to find picture at the new edge.
  const even = (a: 'left' | 'top', b: 'right' | 'bottom') => {
    const vertical = a === 'left';
    const size = vertical ? w : h;
    const short = e[a] < e[b] ? a : b;
    const long = short === a ? b : a;
    for (let k = e[short]; k < e[long]; k++) {
      if (darkShare(y, w, h, short === a ? k : size - 1 - k, vertical, DARK_MAX) < BAR_MOSTLY) return;
    }
    e[short] = e[long];
  };
  even('left', 'right');
  even('top', 'bottom');
  const symmetric = (a: number, b: number, size: number) =>
    Math.min(a, b) >= Math.max(1, Math.ceil(size * BAR_MIN)) && a + b <= size * 0.85 && Math.abs(a - b) <= Math.max(2, size * 0.03);
  // Bars are neutral. The two lines next to the edge are left out: chroma bleeds into them from the picture.
  const neutral = (band: number, vertical: boolean, fromEnd: boolean) => {
    const size = vertical ? w : h;
    let n = 0;
    let k = 0;
    for (let l = 0; l < band - 2; l++) {
      n++;
      if (darkShare(c, w, h, fromEnd ? size - 1 - l : l, vertical, BAR_CHROMA) >= 0.5) k++;
    }
    return k >= n / 2;
  };
  let sideOk = symmetric(e.left, e.right, w) && neutral(e.left, true, false) && neutral(e.right, true, true);
  let topOk = symmetric(e.top, e.bottom, h) && neutral(e.top, false, false) && neutral(e.bottom, false, true);
  const sideEdges = (r0: number, r1: number) =>
    straightEdge(y, w, w, e.left, 1, true, r0, r1) && straightEdge(y, w, w, w - 1 - e.right, -1, true, r0, r1);
  const topEdges = (c0: number, c1: number) =>
    straightEdge(y, w, h, e.top, 1, false, c0, c1) && straightEdge(y, w, h, h - 1 - e.bottom, -1, false, c0, c1);
  // Bars on all four sides (a windowbox, keeping at least half of each dimension): each edge only spans the
  // picture between the other two bars. Otherwise each axis is judged on its own, across the whole frame, so a
  // lone object on black (an asteroid and its glow) is not boxed in by its own bounding box.
  const box = sideOk && topOk && e.left + e.right <= w * BOX_MAX && e.top + e.bottom <= h * BOX_MAX;
  if (box && sideEdges(e.top, h - e.bottom) && topEdges(e.left, w - e.right)) {
    // a windowbox
  } else {
    if (sideOk) sideOk = sideEdges(0, h);
    if (topOk) topOk = topEdges(0, w);
  }
  return {
    side: sideOk ? (e.left + e.right) / 2 / w : null,
    top: topOk ? (e.top + e.bottom) / 2 / h : null,
    e,
  };
}

const median = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

/** Whether a band colour can be a film frame: nearly neutral, or a warm hue. */
const filmColour = (rgb: [number, number, number]) =>
  Math.max(...rgb) - Math.min(...rgb) <= BAR_CHROMA * 2 || hueOf(rgb) < FILM_HUE;

/** A film frame found over several analysis frames: the crop's insets in analysis pixels and the band's colour. */
interface Film {
  left: number;
  right: number;
  top: number;
  bottom: number;
  rgb: [number, number, number];
  /** The band is thicker at all four corners than along the sides next to them: a rounded film gate. */
  round: boolean;
  /** The insets are a crop that clears every band pixel; false when only the straight cores could be measured. */
  crop: boolean;
}

/**
 * The film frame around `frames` (rgb24, w×h), or null. The band's colour is the median of the outermost line of
 * two opposite sides (they must agree). Band pixels reached from the edges give each side a depth per crossing
 * line; a frame needs a straight band on two opposite sides, or the film-gate signature (a band all round with
 * rounded corners), and a picture inside that changes up to the band. The crop is the largest rectangle that
 * leaves out every band pixel reached from the edges, notches and rounded corners included.
 */
function filmFrame(frames: Buffer[], w: number, h: number): Film | null {
  const n = frames.length;
  if (n < FILM_FRAMES) return null;
  const px = w * h;
  /** Median colour of the outermost line of a side over all frames. */
  const outer = (vertical: boolean, fromEnd: boolean): [number, number, number] => {
    const ch: number[][] = [[], [], []];
    const len = vertical ? h : w;
    for (const f of frames) {
      for (let i = 0; i < len; i++) {
        const o = (vertical ? i * w + (fromEnd ? w - 1 : 0) : (fromEnd ? h - 1 : 0) * w + i) * 3;
        for (let c = 0; c < 3; c++) ch[c].push(f[o + c]);
      }
    }
    return ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]) as [number, number, number];
  };
  const same = (a: [number, number, number], b: [number, number, number]) => a.every((v, c) => Math.abs(v - b[c]) <= FILM_TOL);
  const [cl, cr, ct, cb] = [outer(true, false), outer(true, true), outer(false, false), outer(false, true)];
  const colours: Array<[number, number, number]> = [];
  if (same(cl, cr) && filmColour(cl)) colours.push(cl);
  if (same(ct, cb) && filmColour(ct) && !(colours.length && same(colours[0], ct))) colours.push(ct);
  if (!colours.length) return null;

  for (const C of colours) {
    // Stable band pixels over the frames that show a picture (a fade or leader all in the band's colour would
    // make anything look stable), then the ones connected to the frame's edge.
    const count = new Uint16Array(px);
    const near = new Uint8Array(px);
    const shown: Buffer[] = [];
    for (const f of frames) {
      let k = 0;
      for (let i = 0, j = 0; i < px; i++, j += 3) {
        near[i] = Math.abs(f[j] - C[0]) <= FILM_TOL && Math.abs(f[j + 1] - C[1]) <= FILM_TOL && Math.abs(f[j + 2] - C[2]) <= FILM_TOL ? 1 : 0;
        k += near[i];
      }
      if (k >= px * FILM_BLANK) continue;
      shown.push(f);
      for (let i = 0; i < px; i++) count[i] += near[i];
    }
    if (shown.length < FILM_FRAMES) continue;
    // How much every pixel changes from one shown frame to the next: the median absolute luma difference, so a
    // cut or a flash frame in the window does not count as life.
    const steps = shown.length - 1;
    const diffs = new Float32Array(px * steps);
    for (let k = 1; k < shown.length; k++) {
      const [f, g] = [shown[k - 1], shown[k]];
      for (let i = 0, j = 0; i < px; i++, j += 3) {
        diffs[i * steps + k - 1] = Math.abs(0.299 * (g[j] - f[j]) + 0.587 * (g[j + 1] - f[j + 1]) + 0.114 * (g[j + 2] - f[j + 2]));
      }
    }
    const jitter = new Float32Array(px);
    for (let i = 0; i < px; i++) jitter[i] = diffs.subarray(i * steps, (i + 1) * steps).sort()[steps >> 1];
    const need = Math.ceil(shown.length * FILM_STABLE);
    const band = new Uint8Array(px);
    const stack: number[] = [];
    for (let i = 0; i < px; i++) {
      const x = i % w;
      const y = (i - x) / w;
      if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && count[i] >= need) {
        band[i] = 1;
        stack.push(i);
      }
    }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < px && !band[j] && count[j] >= need) {
          band[j] = 1;
          stack.push(j);
        }
      }
    }
    // How deep the band reaches in from each side on every crossing line (the deepest band pixel in that half,
    // so the ring of a sprocket notch counts even where the hole inside it shows something else).
    const reach = (vertical: boolean, fromEnd: boolean): Int32Array => {
      const len = vertical ? h : w;
      const size = vertical ? w : h;
      const r = new Int32Array(len);
      for (let i = 0; i < len; i++) {
        for (let k = (size >> 1) - 1; k >= 0; k--) {
          const l = fromEnd ? size - 1 - k : k;
          if (band[vertical ? i * w + l : l * w + i]) {
            r[i] = k + 1;
            break;
          }
        }
      }
      return r;
    };
    const rL = reach(true, false);
    const rR = reach(true, true);
    const rT = reach(false, false);
    const rB = reach(false, true);
    /** A side's core depth when it has a straight band, else 0; and whether its outermost line is band. */
    const side = (r: Int32Array, size: number) => {
      const len = r.length;
      const mid = [...r.subarray(Math.floor(len * 0.2), Math.ceil(len * 0.8))].sort((a, b) => a - b);
      const core = mid[mid.length >> 1];
      let edge = 0;
      for (const v of r) if (v > 0) edge++;
      const a = Math.floor(len * 0.1);
      const b = Math.ceil(len * 0.9);
      let straight = 0;
      for (let i = a; i < b; i++) if (r[i] <= core + 1) straight++;
      const rim = edge >= len * FILM_EDGE;
      return { core: rim && core >= 1 && core <= size * FILM_MAX && straight >= (b - a) * FILM_EDGE ? core : 0, rim };
    };
    const [sL, sR, sT, sB] = [side(rL, w), side(rR, w), side(rT, h), side(rB, h)];
    // Rounded corners: along each corner's diagonal the band reaches at least two pixels past the sides' cores.
    const diag = (x0: number, y0: number, dx: number, dy: number) => {
      let k = 0;
      while (k < Math.min(w, h) >> 2 && band[(y0 + k * dy) * w + x0 + k * dx]) k++;
      return k;
    };
    const corner = (d: number, a: { core: number }, b: { core: number }) => d >= Math.max(3, a.core + 2, b.core + 2);
    const round = corner(diag(0, 0, 1, 1), sL, sT) && corner(diag(w - 1, 0, -1, 1), sR, sT) &&
      corner(diag(0, h - 1, 1, -1), sL, sB) && corner(diag(w - 1, h - 1, -1, -1), sR, sB);
    const gate = round && sL.rim && sR.rim && sT.rim && sB.rim;
    // Opposite bands of about the same core, as a camera gate centres the picture.
    const pair = (a: typeof sL, b: typeof sL, size: number) => !!a.core && !!b.core && Math.abs(a.core - b.core) <= Math.max(2, size * 0.03);
    if (!(pair(sL, sR, w) || pair(sT, sB, h) || gate)) continue;

    // The largest rectangle clear of the band: for each top / bottom inset the side insets follow from the
    // reach along the rows in between, and the top / bottom reach along the columns in between must fit.
    let best: { left: number; right: number; top: number; bottom: number } | null = null;
    let bestArea = 0;
    const maxH = Math.floor(h * FILM_MAX);
    const maxW = Math.floor(w * FILM_MAX);
    for (let t = 0; t <= maxH; t++) {
      for (let b = 0; b <= maxH; b++) {
        let left = 0;
        let right = 0;
        for (let y = t; y < h - b; y++) {
          if (rL[y] > left) left = rL[y];
          if (rR[y] > right) right = rR[y];
        }
        if (left > maxW || right > maxW) continue;
        let fits = true;
        for (let x = left; x < w - right && fits; x++) fits = rT[x] <= t && rB[x] <= b;
        const area = (w - left - right) * (h - t - b);
        if (fits && area > bestArea) {
          bestArea = area;
          best = { left, right, top: t, bottom: b };
        }
      }
    }
    const box = best ?? { left: sL.core, right: sR.core, top: sT.core, bottom: sB.core };
    if (Math.max(box.left, box.right) < w * FILM_MIN && Math.max(box.top, box.bottom) < h * FILM_MIN) continue;

    // The picture lives right up to the crop's edges, and the band is stiller than it.
    const ring: number[] = [];
    for (let y = box.top; y < h - box.bottom; y++) {
      for (let x = box.left; x < w - box.right; x++) {
        if (Math.min(x - box.left, w - box.right - 1 - x, y - box.top, h - box.bottom - 1 - y) < FILM_RING) ring.push(jitter[y * w + x]);
      }
    }
    const still: number[] = [];
    for (let i = 0; i < px; i++) if (band[i]) still.push(jitter[i]);
    const live = median(ring);
    if (live < FILM_JITTER || median(still) > Math.min(FILM_STILL, live * FILM_CALM)) continue;
    return { ...box, rgb: C, round, crop: !!best };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Public API

const HUES: Array<[number, string]> = [
  [15, '红'], [45, '橙'], [70, '黄'], [160, '绿'], [195, '青'], [255, '蓝'], [290, '紫'], [340, '品红'], [360, '红'],
];

/** A short Chinese colour name for an RGB triple. */
function colourName(rgb: [number, number, number]): string {
  if (Math.max(...rgb) === Math.min(...rgb)) return '灰';
  const hue = hueOf(rgb);
  return HUES.find(([lim]) => hue < lim)?.[1] ?? '红';
}

/** Colour name of a film band: black, white and grey by brightness when it is nearly neutral. */
function bandColour(rgb: [number, number, number]): string {
  const luma = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  if (Math.max(...rgb) - Math.min(...rgb) > BAR_CHROMA) return colourName(rgb);
  return luma <= DARK_MEAN * 2 ? '黑' : luma >= 215 ? '白' : '灰';
}

const sec = (t: number) => t.toFixed(1);
const when = (a: number, b: number) => (b - a > 1e-6 ? `${sec(a)}–${sec(b)} 秒` : `${sec(a)} 秒`);
const pct = (x: number) => `${Math.max(1, Math.round(x * 100))}%`;

/** Raw statistics of one sampled frame, for calibration and for scanFrames. */
export interface FrameStats {
  t: number;
  /** Largest share of the frame covered by one flat, saturated colour (0 when none). */
  flatShare: number;
  flatColour: string;
  /** The flat block encloses other cells (text, a logo): a solid-colour title card rather than a broken frame. */
  flatCard: boolean;
  /** Dark columns / rows running in from each edge, in SMALL_W-wide frame pixels. */
  edges: Edges;
  /** Bar size per side as a share of width / height when the frame passes the bar test, else null. */
  side: number | null;
  top: number | null;
  /**
   * The film frame found over the FILM_WINDOW seconds of samples this one belongs to (null when none, or when
   * most of them have black bars): the crop per side as a share of width / height, the band's colour name, and
   * whether its corners are rounded.
   */
  film: FilmStats | null;
  /** Size of the analysis frame. */
  w: number;
  h: number;
}

/** A film frame in FrameStats: crop per side as a share of width / height, colour name ('黑', '橙'…), rounded corners. */
export interface FilmStats { left: number; right: number; top: number; bottom: number; colour: string; round: boolean }

/** Decodes one frame every `step` seconds between `from` and `to` (one ffmpeg pass) and measures each. */
export async function frameStats(file: string, opts: { from?: number; to?: number; step?: number } = {}): Promise<FrameStats[]> {
  if (!file) throw new Error('frameStats: missing file');
  const p = await probe(file);
  const step = Math.max(0.05, opts.step ?? 0.5);
  const from = Math.max(0, opts.from ?? 0);
  const to = opts.to ?? (p.duration || Infinity);
  if (!(to > from)) return [];
  const w = SMALL_W;
  const h = smallHeight(p);
  const out: FrameStats[] = [];
  // Film frames are judged per window of samples; the last window is filled up with samples before it.
  const per = Math.max(FILM_FRAMES, Math.round(FILM_WINDOW / step));
  const recent: Buffer[] = [];
  let judged = 0;
  const judge = () => {
    const open = out.slice(judged);
    const barred = open.filter((s) => s.side !== null || s.top !== null).length;
    const f = barred * 2 > open.length ? null : filmFrame(recent, w, h);
    const film = f && {
      left: f.left / w, right: f.right / w, top: f.top / h, bottom: f.bottom / h, colour: bandColour(f.rgb), round: f.round,
    };
    for (const s of open) s.film = film;
    judged = out.length;
  };
  await decodeSmall(file, p, from, to - from, `${Math.round(1000 / step)}/1000`, (rgb, i) => {
    const flat = flatBlock(rgb, w, h);
    const { y, c } = planesOf(rgb);
    const b = bars(y, c, w, h);
    out.push({
      t: Math.round((from + i * step) * 100) / 100,
      flatShare: flat?.share ?? 0,
      flatColour: flat ? colourName(flat.rgb) : '',
      flatCard: flat?.card ?? false,
      edges: darkEdges(y, w, h),
      side: b.side,
      top: b.top,
      film: null,
      w,
      h,
    });
    recent.push(Buffer.from(rgb));
    if (recent.length > per) recent.shift();
    if (out.length - judged === per) judge();
  });
  if (out.length > judged) judge();
  return out;
}

/**
 * Samples one frame every `step` seconds (default 0.5) between `from` and `to` (default the whole file) and
 * reports broken frames ('flat-block': at least 35% of the picture is one flat, saturated colour) and black bars
 * baked into the picture ('side-bars' / 'top-bars': symmetric dark bands of at least 4% per side that meet the
 * picture along straight inner edges, seen on at least two consecutive samples; a still needs one). Consecutive
 * hits of a kind merge into one issue at the first time. Film frames (filmFrame, judged per FILM_WINDOW seconds
 * of samples, so never on a still) come as one 'side-bars' or 'top-bars' issue (the thicker axis) with film
 * set, sized by the crop that clears them: '胶片片框（橙色，圆角）', or '黑边' for a plain black band. Meant for
 * downloaded footage (NASA, Commons): designed graphics are solid colour on purpose. A flat block with text or a logo inside it is still 'flat-block' (a
 * segment to avoid) but its detail calls it a solid-colour title card rather than a broken frame. Times are in
 * the file's displayed (rotated) picture. Returns [] for a clean file; throws when the file cannot be read.
 */
export async function scanFrames(file: string, opts: { from?: number; to?: number; step?: number } = {}): Promise<FrameIssue[]> {
  const stats = await frameStats(file, opts);
  if (!stats.length) return [];
  const { w, h } = stats[0];
  interface Hit { t: number; value: number; extra?: string; card?: boolean }
  const pick = (kind: FrameIssue['kind'], s: FrameStats): Hit | null =>
    kind === 'flat-block' ? (s.flatShare >= FLAT_SHARE ? { t: s.t, value: s.flatShare, extra: s.flatColour, card: s.flatCard } : null)
      : kind === 'side-bars' ? (s.side !== null ? { t: s.t, value: s.side } : null)
      : s.top !== null ? { t: s.t, value: s.top } : null;

  const issues: FrameIssue[] = [];
  for (const kind of ['side-bars', 'top-bars', 'flat-block'] as const) {
    let run: Hit[] = [];
    const flush = () => {
      if (!run.length) return;
      const a = run[0];
      const z = run[run.length - 1];
      // Bars must persist; a single dark sample is more likely a dark shot than a bar.
      if (kind === 'flat-block' || run.length >= Math.min(2, stats.length)) {
        const mean = run.reduce((s, r) => s + r.value, 0) / run.length;
        const most = Math.max(...run.map((r) => r.value));
        const detail = kind === 'side-bars' ? `${when(a.t, z.t)}，左右各约 ${pct(mean)} 黑边`
          : kind === 'top-bars' ? `${when(a.t, z.t)}，上下各约 ${pct(mean)} 黑边`
          : a.card ? `${when(a.t, z.t)}，纯色标题卡/字幕卡（${a.extra}色底，约占画面 ${pct(most)}）`
          : `${when(a.t, z.t)}，画面约 ${pct(most)} 是同一种${a.extra}色色块（像是传输坏帧）`;
        issues.push({ t: a.t, kind, detail, ...(kind === 'flat-block' ? { card: Boolean(a.card) } : {}) });
      }
      run = [];
    };
    for (const s of stats) {
      const hit = pick(kind, s);
      // Bars that change size are not the same bars (moving dark content); a card and a broken frame are told
      // apart. Either starts a new run.
      const changed = !!hit && !!run.length && (kind === 'flat-block'
        ? hit.card !== run[0].card
        : Math.abs(hit.value - run[0].value) > 2.5 / (kind === 'side-bars' ? w : h));
      if (!hit || changed) flush();
      if (hit) run.push(hit);
    }
    flush();
  }

  // Film frames: consecutive samples with the same frame (insets within 2.5 analysis pixels, same colour) are
  // one issue, of the kind of its thicker axis.
  const sameFilm = (a: FilmStats, b: FilmStats) => a.colour === b.colour &&
    Math.abs(a.left - b.left) * w <= 2.5 && Math.abs(a.right - b.right) * w <= 2.5 &&
    Math.abs(a.top - b.top) * h <= 2.5 && Math.abs(a.bottom - b.bottom) * h <= 2.5;
  const axis = (a: number, b: number, both: string, one: string, other: string) =>
    Math.max(a, b) < FILM_MIN ? '' : Math.abs(a - b) <= 0.03 ? `${both}各约 ${pct((a + b) / 2)}` : `${one}约 ${pct(a)}、${other}约 ${pct(b)}`;
  let film: FrameStats[] = [];
  const flushFilm = () => {
    if (!film.length) return;
    const f = film[0].film!;
    const parts = [axis(f.top, f.bottom, '上下', '上', '下'), axis(f.left, f.right, '左右', '左', '右')].filter(Boolean).join('、');
    const what = f.colour === '黑' && !f.round ? '黑边' : `胶片片框（${f.colour}色${f.round ? '，圆角' : ''}）`;
    issues.push({
      t: film[0].t, kind: f.left + f.right > f.top + f.bottom ? 'side-bars' : 'top-bars',
      detail: `${when(film[0].t, film[film.length - 1].t)}，${parts} ${what}`, film: true,
    });
    film = [];
  };
  for (const s of stats) {
    if (!s.film || (film.length && !sameFilm(film[0].film!, s.film))) flushFilm();
    if (s.film) film.push(s);
  }
  flushFilm();
  return issues.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
}

/**
 * The picture area inside black bars baked into the first ~10 s of a video (or a still), in displayed source
 * pixels (even numbers): the crop applies after ffmpeg's automatic rotation, as when the file is decoded with
 * default options. Bars are judged on the brightest value each pixel reaches over those seconds, with the same
 * test as scanFrames (symmetric dark bands meeting the picture along straight inner edges); null when there are
 * none. The exact edges come from ffmpeg cropdetect where it agrees with that judgement to within one analysis
 * pixel, else from the opposite bar (bars are symmetric), else from the analysis frame scaled up. Without black
 * bars, a film frame over those seconds (two frames a second) gives the crop that clears its band, rounded
 * corners and notches; null when its band cannot be cleared (scanFrames still reports it).
 */
export async function detectBars(file: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  if (!file) throw new Error('detectBars: missing file');
  const p = await probe(file);
  const seconds = Math.min(10, p.duration || 10);
  const w = SMALL_W;
  const h = smallHeight(p);
  const peak = new Float32Array(w * h);
  const peakC = new Float32Array(w * h);
  // Two frames a second: the whole seconds feed the black-bar peak, all of them the film-frame test.
  const frames: Buffer[] = [];
  await decodeSmall(file, p, 0, seconds, '2', (rgb, index) => {
    frames.push(Buffer.from(rgb));
    if (index % 2) return;
    const { y, c } = planesOf(rgb);
    for (let i = 0; i < y.length; i++) {
      if (y[i] > peak[i]) peak[i] = y[i];
      if (c[i] > peakC[i]) peakC[i] = c[i];
    }
  });
  const b = bars(peak, peakC, w, h);
  if (b.side === null && b.top === null) return filmCrop(filmFrame(frames, w, h), p, w, h);

  // 8-bit first so the limit means the same on 10-bit sources; skip=0 so a still's only frame counts.
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-t', seconds.toFixed(3), ...safeIn(file),
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `format=yuv420p,cropdetect=limit=${CROP_LIMIT}:round=2:reset=0:skip=0`, '-f', 'null', '-',
  ], 30_000 + seconds * 6_000);
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const m = all[all.length - 1];
  const W = p.width;
  const H = p.height;
  const [cw, ch, cx, cy] = m ? m.slice(1, 5).map(Number) : [W, H, 0, 0];
  /** Both bars of one axis in source pixels, from the analysis bands `a`/`b` and cropdetect's `ca`/`cb`. */
  const exact = (a: number, b: number, ca: number, cb: number, small: number, big: number): [number, number] => {
    const unit = big / small;
    const okA = !!m && Math.abs(ca / unit - a) <= 1;
    const okB = !!m && Math.abs(cb / unit - b) <= 1;
    return [okA ? ca : okB ? cb : Math.round(a * unit), okB ? cb : okA ? ca : Math.round(b * unit)];
  };
  const [left, right] = b.side !== null ? exact(b.e.left, b.e.right, cx, W - cx - cw, w, W) : [0, 0];
  const [top, bottom] = b.top !== null ? exact(b.e.top, b.e.bottom, cy, H - cy - ch, h, H) : [0, 0];
  // Round inward so no bar line is left at the edge.
  const x = Math.ceil(left / 2) * 2;
  const y = Math.ceil(top / 2) * 2;
  const cropW = Math.floor((W - x - right) / 2) * 2;
  const cropH = Math.floor((H - y - bottom) / 2) * 2;
  if (cropW < 2 || cropH < 2 || (cropW >= W * 0.97 && cropH >= H * 0.97)) return null;
  return { x, y, w: cropW, h: cropH };
}

/**
 * The crop of a film frame in displayed source pixels (even numbers), one analysis pixel further in on every side
 * with a band, so neither a blended band line nor the tip of a notch is left; null without a frame or when its
 * crop was not measurable.
 */
function filmCrop(f: Film | null, p: Probe, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  if (!f?.crop) return null;
  const ux = p.width / w;
  const uy = p.height / h;
  const at = (inset: number, unit: number) => (inset ? (inset + 1) * unit : 0);
  const x = Math.ceil(at(f.left, ux) / 2) * 2;
  const y = Math.ceil(at(f.top, uy) / 2) * 2;
  const cropW = Math.floor((p.width - x - at(f.right, ux)) / 2) * 2;
  const cropH = Math.floor((p.height - y - at(f.bottom, uy)) / 2) * 2;
  return cropW >= 2 && cropH >= 2 ? { x, y, w: cropW, h: cropH } : null;
}
