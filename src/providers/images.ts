// Still images through the relay's OpenAI-style image endpoint: gpt-image-2 (posters, Chinese titles) or
// Seedream 5.0. Used as stills in a video or as the first frame handed to Seedance. Without a relay,
// labelled solid-colour placeholders of the same size are written instead, so the rest of the flow still runs.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { relay, relayReady } from '../core/config.ts';
import { atomicOutput, CJK_FONT_FILE, ffmpeg } from '../core/ffmpeg.ts';

export type ImageModel = 'gpt-image-2' | 'seedream';
export type ImageShape = 'portrait' | 'landscape' | 'square';

const env = process.env;

interface ModelSpec { id: string; sizes: Record<ImageShape, string>; usdEach: number; nativeN: boolean }

const MODELS: Record<ImageModel, ModelSpec> = {
  'gpt-image-2': {
    id: env.IMAGE_MODEL_GPT ?? 'gpt-image-2',
    sizes: { portrait: '1024x1536', landscape: '1536x1024', square: '1024x1024' },
    usdEach: Number(env.IMAGE_USD_GPT ?? 0.04),
    nativeN: true,
  },
  seedream: {
    id: env.IMAGE_MODEL_SEEDREAM ?? 'doubao-seedream-5-0-260128',
    // Seedream refuses anything under 3,686,400 pixels, so these are the smallest sizes it takes.
    sizes: { portrait: '1440x2560', landscape: '2560x1440', square: '2048x2048' },
    usdEach: Number(env.IMAGE_USD_SEEDREAM ?? 0.03),
    nativeN: false,
  },
};

const TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_N = 4;

export interface ImageFile { path: string; width: number; height: number }
/** `warning` is set when fewer than n images came back, e.g. "3 张中成功 2 张；失败：图片生成失败（429）：…". */
export interface ImageResult { files: ImageFile[]; model: string; usd: number; basis: 'actual' | 'estimate'; usage: string; mock: boolean; warning?: string }

interface ApiImage { b64_json?: string; url?: string }
interface ApiReply { data?: ApiImage[]; usage?: Record<string, unknown> }

/** The provider's own words from an error body, kept short: JSON error.message when there is one. */
function providerMessage(body: string) {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
    if (m) return m.slice(0, 200);
  } catch { /* not JSON */ }
  return body.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * A fetch error as short text: undici hides the useful part (ECONNREFUSED…) in `cause`. URLs are cut, since
 * image links carry signed query parameters; `url` is also cut verbatim, for a malformed one the regex misses.
 */
function errorText(e: unknown, url?: string) {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const detail = err.cause?.code ?? err.cause?.message;
  let text = detail && !err.message.includes(detail) ? `${err.message}（${detail}）` : err.message;
  if (url) text = text.split(url).join('<url>');
  return text.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
}

/** A reference picture the new image should follow (the same presenter, product or scene). */
export interface ImageRef { bytes: Buffer; type: string }

/**
 * One POST to the image endpoint. `extra` carries model-specific fields such as Seedream's watermark. With
 * reference images, GPT goes through the edits endpoint (multipart); Seedream takes them as data URLs.
 */
function request(spec: ModelSpec, prompt: string, size: string, n: number, extra: Record<string, unknown>, refs: ImageRef[]): { url: string; init: RequestInit } {
  const auth = { Authorization: `Bearer ${relay.apiKey}` };
  if (refs.length && spec.nativeN) {
    const form = new FormData();
    for (const [k, v] of Object.entries({ model: spec.id, prompt, size, ...(n > 1 ? { n } : {}), ...extra })) form.append(k, String(v));
    refs.forEach((r, i) => form.append('image[]', new Blob([new Uint8Array(r.bytes)], { type: r.type }), `ref-${i + 1}.${r.type.split('/')[1] ?? 'png'}`));
    return { url: `${relay.url}/v1/images/edits`, init: { method: 'POST', headers: auth, body: form } };
  }
  const image = refs.length ? { image: refs.map((r) => `data:${r.type};base64,${r.bytes.toString('base64')}`) } : {};
  return {
    url: `${relay.url}/v1/images/generations`,
    init: { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: spec.id, prompt, size, ...(n > 1 ? { n } : {}), ...image, ...extra }) },
  };
}

async function callApi(spec: ModelSpec, prompt: string, size: string, n: number, extra: Record<string, unknown>, refs: ImageRef[] = []): Promise<ApiReply> {
  let res: Response;
  let body: string;
  try {
    const { url, init } = request(spec, prompt, size, n, extra, refs);
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // The body runs under the same timeout signal: a relay that sends headers and then stalls fails here.
    body = await res.text();
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError';
    throw new Error(timedOut ? `图片生成超时（${TIMEOUT_MS / 1000} 秒未返回）` : `图片生成请求失败：${errorText(e)}`);
  }
  if (!res.ok) throw new Error(`图片生成失败（${res.status}）：${providerMessage(body)}`);
  try {
    return JSON.parse(body) as ApiReply;
  } catch {
    throw new Error(`图片生成返回无法解析（${res.status}）：${body.slice(0, 120)}`);
  }
}

/** Fetches an image url. Every failure becomes a Chinese message without the url itself. */
async function download(url: string): Promise<{ bytes: Buffer; type: string }> {
  let res: Response;
  let bytes: Buffer | null = null;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
    else await res.body?.cancel();
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError';
    throw new Error(timedOut ? `图片下载超时（${DOWNLOAD_TIMEOUT_MS / 1000} 秒）` : `图片下载失败：${errorText(e, url)}`);
  }
  if (!bytes) throw new Error(`图片下载失败（${res.status}）`);
  return { bytes, type: res.headers.get('content-type') ?? '未知类型' };
}

/**
 * Image bytes from b64_json, or downloaded right away from url (Seedream's links expire). Anything that is
 * not an image, such as an HTML error page from an expired link, is refused here, before a file is written.
 */
async function imageBytes(img: ApiImage): Promise<{ bytes: Buffer; ext: ImageExt }> {
  if (img.b64_json) {
    const bytes = Buffer.from(img.b64_json, 'base64');
    const ext = extOf(bytes);
    if (!ext) throw new Error('图片生成返回的内容不是图片');
    return { bytes, ext };
  }
  if (img.url) {
    const { bytes, type } = await download(img.url);
    const ext = extOf(bytes);
    if (!ext) throw new Error(`图片下载内容不是图片（${type}）`);
    return { bytes, ext };
  }
  throw new Error('图片生成返回里没有图片');
}

type ImageExt = 'png' | 'jpg' | 'webp';

/** Extension from the file's magic bytes, since the providers differ (PNG from GPT, JPEG from Seedream); null if not an image. */
function extOf(b: Buffer): ImageExt | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** Width and height, or an error for a file ffprobe cannot read. stderr is piped so its complaints stay off the console. */
function probeSize(file: string): { width: number; height: number } {
  let out = '';
  try {
    out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch { /* reported below as unreadable */ }
  const [width, height] = out.split(',').map(Number);
  if (!width || !height) throw new Error('图片文件已损坏，无法读取尺寸');
  return { width, height };
}

/** Splits settled promises into values and failure messages. */
function settle<T>(results: PromiseSettledResult<T>[]) {
  const ok: T[] = [];
  const failed: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') ok.push(r.value);
    else failed.push((r.reason as Error)?.message ?? String(r.reason));
  }
  return { ok, failed };
}

/** usage as one readable line, e.g. "generated_images=1 output_tokens=4160". */
function usageLine(usages: Array<Record<string, unknown> | undefined>) {
  const sum: Record<string, number> = {};
  for (const u of usages) {
    for (const [k, v] of Object.entries(u ?? {})) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v;
  }
  return Object.entries(sum).map(([k, v]) => `${k}=${v}`).join(' ');
}

/**
 * Generates n (1–4) images for `prompt` and writes them as <outDir>/<stem>-<i>.<ext>.
 * gpt-image-2 is asked for all n in one call and topped up with single calls if it returns fewer;
 * Seedream gets parallel single calls. Cost is an estimate: the relay has no per-image billing lookup.
 */
export async function generateImages(
  req: { prompt: string; shape: ImageShape; model?: ImageModel; n?: number; extra?: Record<string, unknown>; refs?: ImageRef[] },
  outDir: string,
  stem: string,
): Promise<ImageResult> {
  const key = req.model ?? 'gpt-image-2';
  const spec = MODELS[key];
  if (!spec) throw new Error(`不支持的图片模型：${key}`);
  const n = Math.min(MAX_N, Math.max(1, Math.floor(req.n ?? 1)));
  const size = spec.sizes[req.shape] ?? spec.sizes.portrait;
  const usdEach = spec.usdEach;
  if (!relayReady()) {
    const files = await Promise.all(Array.from({ length: n }, (_, i) => placeholderImage(join(outDir, `${stem}-${i + 1}.png`), size, i)));
    return { files, model: spec.id, usd: 0, basis: 'estimate', usage: '', mock: true };
  }

  // Seedream adds an "AI生成" corner mark unless told not to; the caller may still override it via extra.
  const extra = { ...(key === 'seedream' ? { watermark: false } : {}), ...req.extra };
  // Every call that succeeded has been billed, so one failure must not throw away the others' images:
  // calls and downloads are settled, and only a run where nothing at all came back throws.
  const replies: ApiReply[] = [];
  const failed: string[] = [];
  const refs = req.refs ?? [];
  const single = (count: number) => Promise.allSettled(Array.from({ length: count }, () => callApi(spec, req.prompt, size, 1, extra, refs)));
  if (spec.nativeN) {
    // The first call is awaited plainly: if it fails nothing was billed, and topping up would likely fail the same way.
    replies.push(await callApi(spec, req.prompt, size, n, extra, refs));
    const got = replies[0].data?.length ?? 0;
    if (got < n) {
      const s = settle(await single(n - got));
      replies.push(...s.ok);
      failed.push(...s.failed);
    }
  } else {
    const s = settle(await single(n));
    replies.push(...s.ok);
    failed.push(...s.failed);
  }
  const images = replies.flatMap((r) => r.data ?? []).slice(0, n);

  const fetched = settle(await Promise.allSettled(images.map(imageBytes)));
  failed.push(...fetched.failed);
  // Numbered over the images that downloaded, so a failed call or download leaves no gap in <stem>-1, -2, ….
  const written = settle(await Promise.allSettled(fetched.ok.map(async ({ bytes, ext }, i) => {
    const path = join(outDir, `${stem}-${i + 1}.${ext}`);
    let dims = { width: 0, height: 0 };
    // Probed before the rename, so a file ffprobe cannot read is never left under its final name.
    await atomicOutput(path, async (tmp) => { await writeFile(tmp, bytes); dims = probeSize(tmp); });
    return { path, ...dims };
  })));
  failed.push(...written.failed);
  const files = written.ok;
  if (!files.length) throw new Error(failed[0] ?? '图片生成返回里没有图片');

  const missing = n - files.length;
  const reasons = [...new Set(failed)].join('；');
  return {
    files,
    model: spec.id,
    usd: files.length * usdEach,
    basis: 'estimate',
    usage: usageLine(replies.map((r) => r.usage)),
    mock: false,
    ...(missing > 0 ? { warning: `${n} 张中成功 ${files.length} 张；${reasons ? `失败：${reasons}` : `模型少返回了 ${missing} 张`}` } : {}),
  };
}

const PLACEHOLDER_COLORS = ['0x3b5b7a', '0x6a4c7d', '0x2f6b5a', '0x7a5a3b'];

/** A solid-colour PNG of the real size labelled "示意图片", so layout and cropping can still be checked. */
async function placeholderImage(path: string, size: string, i: number): Promise<ImageFile> {
  const [width, height] = size.split('x').map(Number);
  const font = CJK_FONT_FILE ? `fontfile='${CJK_FONT_FILE}':` : '';
  await atomicOutput(path, (out) => ffmpeg([
    '-f', 'lavfi', '-i', `color=c=${PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.length]}:s=${width}x${height}:d=1`,
    '-vf', `drawtext=${font}text='示意图片':fontsize=${Math.round(Math.min(width, height) / 10)}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
    // The temp name ends in .mp4, so the format has to be named; -update writes one still, not a sequence.
    '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '-update', '1', out,
  ]));
  return { path, width, height };
}

const SEEDANCE_IMAGE_LIMIT = 10 * 1024 * 1024;

/**
 * An image as a data: URL for Seedance's image_url. Seedance refuses images over 10 MB, so larger ones
 * (a big Seedream PNG) are first shrunk to a JPEG of at most 1280 px on the long side.
 */
export function imageToVideoInput(path: string): string {
  let bytes = readFileSync(path);
  // A format extOf does not know (GIF, BMP…) goes through the same JPEG re-encode, so the MIME type is always right.
  if (statSync(path).size > SEEDANCE_IMAGE_LIMIT || !extOf(bytes)) {
    const tmp = join(tmpdir(), `seedance-in-${randomUUID().slice(0, 8)}.jpg`);
    try {
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', path,
        '-vf', "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
        '-frames:v', '1', '-q:v', '3', tmp,
      ]);
      bytes = readFileSync(tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const ext = extOf(bytes) ?? 'jpg';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
