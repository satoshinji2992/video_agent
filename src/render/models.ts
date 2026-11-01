// Real 3D models for 3D shots, found in general model libraries and made light enough for software rendering.
// Sources: Poly Haven (CC0 models with names, categories and tags), NASA 3D Resources (public domain spacecraft,
// equipment and terrain, scraped from science.nasa.gov) and NASA's Scientific Visualization Studio (public domain;
// only the pages that mention glb/glTF files are searched). Every candidate says what it depicts. A measured shape
// model of one specific real object (terrain or a globe built from elevation data, an asteroid shape model) is
// marked realShape and may only be shown as that object; everything else is generic and is labelled '三维示意' by
// the caller. Credits: Poly Haven's API terms ask for a User-Agent naming the software ('video_agent') on every
// request and for the content to be shown as coming from Poly Haven ('模型：Poly Haven（authors）'), without implying
// endorsement; NASA material is credited 'NASA'.
//
// fetchModel downloads with byte caps, timeouts and redirects followed by hand within an allowlist of hosts, then
// optimises in a worker thread (gltf-transform + meshoptimizer, pure JS/wasm): dedup, prune, weld, simplify down to
// a triangle budget, textures resized through ffmpeg (async, piped), the model centred and scaled into a unit
// bounding sphere, written as one self-contained .glb. Raw downloads and optimised results are cached across
// sessions under <dataDir>/model-cache, so the same model is not downloaded or optimised twice. Nothing downloaded
// is ever executed; archives are read entry by entry and only the model files are taken out, under our own names.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';
import type { Document, Node as GNode, Primitive, Scene } from '@gltf-transform/core';
import type { InstancedMesh } from '@gltf-transform/extensions';
import { config } from '../core/config.ts';
import { recordManifest, type ManifestEntry } from '../media/footage.ts';
import { createLimiter } from '../core/limiter.ts';

export type ModelSource = 'polyhaven' | 'nasa3d' | 'svs';

export interface ModelCandidate {
  /** 'polyhaven:<asset id>', 'nasa3d:<page slug>' or 'svs:<page id>/<file.glb>'; passed back to fetchModel. */
  id: string;
  source: ModelSource;
  title: string;
  /** What the model shows, in the library's words ("Mars 2020 Perseverance Rover: ...", "Moon globe with ..."). */
  depicts: string;
  /**
   * True only for a measured shape model of one specific real object (terrain or a globe built from elevation
   * data, a shape model from observations); it may be shown only as that object. False: a generic or modelled
   * object, which the caller labels '三维示意'.
   */
  realShape: boolean;
  /** 'CC0' or 'Public domain (NASA)'. */
  license: string;
  /** For the end card, printed verbatim: '模型：Poly Haven（Kirill Sannikov）', 'NASA'. */
  credit: string;
  /** The library's own credit line where it names one ('NASA/Jet Propulsion Laboratory'). */
  sourceCredit?: string;
  /** Approximate triangle count of the original, when the library says. */
  triangles?: number;
  /** Whether the model carries textures, when known before fetching. */
  textured?: boolean;
  /** Approximate download size in bytes, when the library says. */
  bytes?: number;
  /** https URL of a preview image. */
  thumb: string;
  /** Human page for attribution. */
  pageUrl: string;
  /** Its name or description names a brand (searchModels sorts these last). */
  branded?: boolean;
}

/** What assets_manifest.json holds for a fetched model (footage entries are ManifestEntry). */
export interface ModelManifestEntry extends Omit<ManifestEntry, 'source' | 'kind'> {
  source: ModelSource;
  kind: 'model';
  /** Always true: tells a 3D model apart from footage. */
  model3d: true;
  depicts: string;
  realShape: boolean;
  triangles: number;
  textures: number;
  /**
   * Size of the original in glTF units (metres) before it was scaled into the unit sphere; null when unknown. Real
   * world size only where the library models at real scale (Poly Haven does; NASA's spacecraft mostly do, a globe
   * may be modelled at radius 1).
   */
  sizeMetres: [number, number, number] | null;
}

export interface ModelStats {
  /** Triangles drawn for the default scene (a mesh used by several nodes counts each time). */
  triangles: number;
  meshes: number;
  primitives: number;
  textures: { count: number; maxSize: number };
  /** World-space bounding box of the default scene in file units; null when the scene has no geometry. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  bytes: number;
}

export interface FetchedModel {
  /** File name inside assetsDir: md-<source>-<hash>.glb. */
  file: string;
  triangles: number;
  textures: number;
  bytes: number;
  sizeMetres: [number, number, number] | null;
  entry: ModelManifestEntry;
}

const UA = 'video_agent';
const HEADERS = { 'User-Agent': UA };
const MB = 1024 * 1024;
const SEARCH_TIMEOUT = 20_000;
const PAGE_CAP = 4 * MB;
const JSON_CAP = 8 * MB;
const DOWNLOAD_TIMEOUT = 240_000;
const WORKER_TIMEOUT = 300_000;
const FFMPEG_TIMEOUT = 60_000;
const DEFAULT_TRIANGLES = 250_000;
const DEFAULT_TEXTURE = 2048;
const DEFAULT_BYTES = 150 * MB;
/** Bumped whenever the optimisation changes, so older cached results are not reused. */
const PIPELINE = 1;
const LICENSE: Record<ModelSource, string> = { polyhaven: 'CC0', nasa3d: 'Public domain (NASA)', svs: 'Public domain (NASA)' };
const SOURCE_NAME: Record<ModelSource, string> = { polyhaven: 'Poly Haven', nasa3d: 'NASA 3D Resources', svs: 'NASA 科学可视化工作室' };
const SVS_CREDIT = "NASA's Scientific Visualization Studio";

const cacheRoot = () => join(config.dataDir, 'model-cache');

// ---------------------------------------------------------------------------------------------------------------
// Network: an allowlist of hosts, redirects followed by hand, the User-Agent on every request, byte caps

/** The only hosts models are fetched from. Every URL, and every redirect hop, must be one of them, over https. */
const MODEL_HOSTS = new Set([
  'api.polyhaven.com', 'dl.polyhaven.org', 'cdn.polyhaven.com',
  'science.nasa.gov', 'assets.science.nasa.gov',
  'svs.gsfc.nasa.gov',
]);

/** An allowed https URL (http on an allowed host is upgraded), or null. */
export function modelUrl(raw: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol === 'http:') u.protocol = 'https:';
  return u.protocol === 'https:' && MODEL_HOSTS.has(u.hostname) && !u.username && !u.password ? u.toString() : null;
}

const OFF_LIST = '模型地址不在允许的来源里';

/** fetch() with the User-Agent, following at most 5 redirects itself and checking the host of each hop. */
export async function modelFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = modelUrl(raw);
  for (let hop = 0; url && hop < 6; hop++) {
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...HEADERS }, redirect: 'manual' });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) return res;
    await res.body?.cancel().catch(() => {});
    url = modelUrl(next, url);
  }
  throw new Error(OFF_LIST);
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** Thrown when a file is bigger than the caller allows. */
class TooBig extends Error {}

/** The whole body, at most `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > cap) {
    await res.body?.cancel().catch(() => {});
    throw new TooBig(`超过 ${fmtBytes(cap)}`);
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  if (res.body) {
    for await (const c of res.body as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > cap) {
        await res.body.cancel().catch(() => {});
        throw new TooBig(`超过 ${fmtBytes(cap)}`);
      }
      chunks.push(c);
    }
  }
  return Buffer.concat(chunks);
}

async function request(url: string, ms: number, who: string, cap: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await modelFetch(url, { signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e instanceof Error && e.message === OFF_LIST) throw e;
    throw new Error(isTimeout(e) ? `${who}响应超时` : `${who}连接失败`);
  }
  if (res.status === 429) { await res.body?.cancel().catch(() => {}); throw new Error(`${who}请求太频繁，稍后再试`); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`${who}返回错误 ${res.status}`); }
  try {
    return await readCapped(res, cap);
  } catch (e) {
    if (e instanceof TooBig) throw new Error(`${who}返回的内容太大`);
    throw new Error(isTimeout(e) ? `${who}响应超时` : `${who}连接中断`);
  }
}

async function getJson<T>(url: string, ms: number, who: string): Promise<T> {
  const body = await request(url, ms, who, JSON_CAP);
  try { return JSON.parse(body.toString('utf8')) as T; } catch { throw new Error(`${who}返回的数据无法解析`); }
}

const getText = async (url: string, ms: number, who: string) => (await request(url, ms, who, PAGE_CAP)).toString('utf8');

/** Download budget shared by every file of one model. */
interface Budget { left: number; cap: number }

/** A byte count for a message: '200 KB', '150 MB'. */
const fmtBytes = (n: number) => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Math.round(n / MB)} MB`);
const overCap = (cap: number) => new Error(`模型文件超过 ${fmtBytes(cap)} 的下载上限，已放弃`);
const tooBig = (b: Budget) => overCap(b.cap);

/** Streams `url` into `dest` (a new file), charging the bytes to `budget`. */
async function download(url: string, dest: string, budget: Budget, who: string): Promise<number> {
  let res: Response;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
  try {
    res = await modelFetch(url, { signal });
  } catch (e) {
    if (e instanceof Error && e.message === OFF_LIST) throw e;
    throw new Error(isTimeout(e) ? `${who}下载超时` : `${who}连接失败`);
  }
  if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); throw new Error(`${who}下载失败（${res.status}）`); }
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > budget.left) { await res.body.cancel().catch(() => {}); throw tooBig(budget); }
  const fh = await open(dest, 'wx');
  let n = 0;
  try {
    for await (const c of res.body as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > budget.left) { await res.body.cancel().catch(() => {}); throw tooBig(budget); }
      await fh.write(c);
    }
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(dest, { force: true });
    if (e instanceof Error && e.message.startsWith('模型文件超过')) throw e;
    throw new Error(isTimeout(e) ? `${who}下载超时` : `${who}下载中断`);
  }
  await fh.close();
  budget.left -= n;
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Text: HTML to plain text, query matching and ranking

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function plain(html: unknown): string {
  if (html == null) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      try { return String.fromCodePoint(n); } catch { return ' '; }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** The first sentence (or the first n characters) of a description. */
const firstSentence = (s: string, n = 180) => clip(s.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? s, n);

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'with', 'in', 'on', 'to', '3d', 'model', 'models', 'object', 'objects', 'free', 'cc0']);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lower-case word stems; camelCase and snake_case names are split. */
function words(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem);
}

type Field = [text: string, weight: number];

/**
 * How well `fields` match the query words: the share of query words found (the last word, the head noun of an
 * English compound like "flower pot", counts one and a half) and a score weighted by the field each is found in.
 * A compound written as one word ("flowerpot") matches both words.
 */
function match(query: string[], fields: Field[]): { cover: number; score: number } {
  const sets = fields.map(([t, w]) => [new Set(words(t)), w] as const);
  let cover = 0, total = 0, score = 0;
  for (const [i, q] of query.entries()) {
    const head = i === query.length - 1 ? 1.5 : 1;
    total += head;
    let best = 0;
    for (const [set, w] of sets) {
      const joined = (query[i - 1] && set.has(stem(query[i - 1]! + q))) || (query[i + 1] && set.has(stem(q + query[i + 1]!)));
      if (set.has(q) || joined) best = Math.max(best, w);
    }
    if (best) { cover += head; score += best * head; }
  }
  return { cover: total ? cover / total : 0, score };
}

const rank = (m: { cover: number; score: number }, bonus = 0) => m.cover * 10 + m.score + bonus;

/** Phrases that say a model was built from measurements of the real object. */
const MEASURED = /\b(?:shape\s+models?|topograph(?:y|ic|ical)|digital\s+elevation|elevation\s+(?:data|models?|maps?)|height\s*maps?|terrain\s+models?|laser\s+altimet\w*|altimetry|derived\s+from\s+[\w\s'’,/-]{0,60}?\bdata|stereo\s+(?:images|imagery|pairs)|photogrammetr\w*|lidar|3D\s+scan\w*)\b/i;
const NOT_MEASURED = /\bwithout\s+(?:any\s+)?(?:topograph\w*|elevation|relief|height\s*maps?)\b/gi;
const measured = (text: string) => MEASURED.test(text.replace(NOT_MEASURED, ' '));

// ---------------------------------------------------------------------------------------------------------------
// Poly Haven

interface PhAsset {
  name: string;
  type?: number;
  categories?: string[];
  category?: string;
  tags?: string[];
  authors?: Record<string, string>;
  polycount?: number;
  dimensions?: number[];
  description?: string;
  download_count?: number;
  thumbnail_url?: string;
  max_resolution?: number[];
}
interface PhFile { url: string; size?: number; md5?: string }
interface PhGltf { gltf?: { url: string; size?: number; md5?: string; include?: Record<string, PhFile> } }
interface PhFiles { gltf?: Record<string, PhGltf> }

const PH_API = 'https://api.polyhaven.com';
const PH_LIST_TTL = 24 * 3600_000;
let phList: { at: number; list: Record<string, PhAsset> } | null = null;
let phListLoading: Promise<Record<string, PhAsset>> | null = null;

/** Poly Haven's model list, kept for a day in memory and on disk (the file is small and CC0 metadata). */
async function polyhavenList(): Promise<Record<string, PhAsset>> {
  if (phList && Date.now() - phList.at < PH_LIST_TTL) return phList.list;
  return (phListLoading ??= (async () => {
    const file = join(cacheRoot(), 'polyhaven-models.json');
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < PH_LIST_TTL) {
        const list = JSON.parse(await readFile(file, 'utf8')) as Record<string, PhAsset>;
        phList = { at: s.mtimeMs, list };
        return list;
      }
    } catch { /* not cached yet */ }
    const list = await getJson<Record<string, PhAsset>>(`${PH_API}/assets?t=models`, SEARCH_TIMEOUT, SOURCE_NAME.polyhaven);
    if (!list || typeof list !== 'object') throw new Error('Poly Haven 返回的数据无法解析');
    phList = { at: Date.now(), list };
    await mkdir(cacheRoot(), { recursive: true });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(list)).then(() => rename(tmp, file)).catch(() => rm(tmp, { force: true }));
    return list;
  })().finally(() => { phListLoading = null; }));
}

function phCredit(a: PhAsset): string {
  const authors = Object.keys(a.authors ?? {}).filter(Boolean);
  return `模型：Poly Haven${authors.length ? `（${clip(authors.join('、'), 60)}）` : ''}`;
}

/** Poly Haven's description without its SEO lead-in ("Free (CC0) ... 3D model - ..."). */
function phDescription(a: PhAsset): string {
  return plain(a.description)
    .replace(/^free\s*(?:\(cc0\)\s*)?(?:\d+k\s+)?/i, '')
    .replace(/^(?:3d\s+)?model(?:\s+of)?\s*[-–—:,.]?\s*/i, '')
    .replace(/\b3D model\b\s*[-–—:]?\s*/i, '')
    .trim();
}

function phCandidate(id: string, a: PhAsset): ModelCandidate {
  const desc = phDescription(a);
  const what = [a.category?.replace(/\//g, ' > '), desc].filter(Boolean).join('; ');
  return {
    id: `polyhaven:${id}`, source: 'polyhaven', title: a.name || id,
    depicts: clip(`${a.name || id}${what ? ` — ${what}` : ''}`, 240),
    realShape: false, license: LICENSE.polyhaven, credit: phCredit(a),
    ...(a.polycount ? { triangles: a.polycount } : {}), textured: true,
    thumb: a.thumbnail_url ?? `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(id)}.png?width=256&height=256`,
    pageUrl: `https://polyhaven.com/a/${encodeURIComponent(id)}`,
  };
}

async function searchPolyhaven(query: string[]): Promise<Ranked[]> {
  const list = await polyhavenList();
  const out: Ranked[] = [];
  for (const [id, a] of Object.entries(list)) {
    if (!a || typeof a !== 'object' || (a.type !== undefined && a.type !== 2)) continue;
    const strong: Field[] = [[`${a.name ?? ''} ${id}`, 3], [(a.tags ?? []).join(' '), 2], [`${(a.categories ?? []).join(' ')} ${a.category ?? ''}`, 1.5]];
    if (match(query, strong).cover < 0.5) continue;
    const m = match(query, [...strong, [phDescription(a), 0.5]]);
    out.push({ cand: phCandidate(id, a), rank: rank(m, Math.log10(1 + (a.download_count ?? 0)) * 0.1) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// NASA 3D Resources (science.nasa.gov/3d-resources)

const NASA_CATALOG = 'https://science.nasa.gov/3d-resources/';
const NASA_LIST_API = 'https://science.nasa.gov/wp-json/smd/v1/content-list';
/** What the catalog page's list block asked for when this was written; used when the page cannot be read. */
const NASA_QUERY_FALLBACK: Record<string, string | number | boolean> = {
  block_id: 'content-list-9b8234fe-7f9c-4c6b-b6f1-d20260a330b0', layout: 'grid', listing_page: 'no', order: 'ASC', orderby: 'title',
  requesting_id: 447593, show_thumbnails: 'yes', response_format: 'html', post_types: 'any', filter_logic: 'match_all',
  base_terms: '{"category":"","science-org":"6502,6484,6483,6487","internal-terms":"6585","news-tags":""}',
};
const NASA_GLB_TERM_FALLBACK = '6491';
let nasaQuery: { at: number; query: Record<string, unknown>; glbTerm: string } | null = null;

/** The catalog's list query and the id of its "glb" format filter, read from the catalog page (kept 12 hours). */
async function nasaCatalogQuery(): Promise<{ query: Record<string, unknown>; glbTerm: string }> {
  if (nasaQuery && Date.now() - nasaQuery.at < 12 * 3600_000) return nasaQuery;
  let query: Record<string, unknown> = NASA_QUERY_FALLBACK;
  let glbTerm = NASA_GLB_TERM_FALLBACK;
  try {
    const html = await getText(NASA_CATALOG, SEARCH_TIMEOUT, SOURCE_NAME.nasa3d);
    const q = html.match(/data-starting-query="([^"]*)"/);
    if (q) {
      const j = JSON.parse(plain(q[1]).replace(/\s+/g, ' ')) as Record<string, unknown>;
      if (j && typeof j === 'object' && j.block_id) query = j;
    }
    const g = html.match(/data-filter-value="(\d+)">\s*glb\s*</i);
    if (g) glbTerm = g[1]!;
  } catch { /* the fallback query still works */ }
  nasaQuery = { at: Date.now(), query, glbTerm };
  return nasaQuery;
}

interface NasaListItem { slug: string; title: string; thumb: string }

async function nasaList(text: string, n: number): Promise<NasaListItem[]> {
  const { query, glbTerm } = await nasaCatalogQuery();
  const params = { ...query, search_query: text, number_of_items: n, current_page: 1, science_org: glbTerm, response_format: 'html' };
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`)
    .join('&');
  const j = await getJson<{ content?: string }>(`${NASA_LIST_API}?${qs}`, SEARCH_TIMEOUT, SOURCE_NAME.nasa3d);
  const items: NasaListItem[] = [];
  const seen = new Set<string>();
  for (const part of String(j?.content ?? '').split(/class="hds-content-item\s/).slice(1)) {
    const slug = part.match(/href="https:\/\/science\.nasa\.gov\/3d-resources\/([a-z0-9-]{1,120})\/"/)?.[1];
    const title = plain(part.match(/hds-a11y-heading-22">([\s\S]*?)<\/div>/)?.[1]);
    if (!slug || !title || seen.has(slug)) continue;
    seen.add(slug);
    const thumb = plain(part.match(/\ssrc="(https:\/\/assets\.science\.nasa\.gov\/[^"]+)"/)?.[1]);
    items.push({ slug, title, thumb });
  }
  return items;
}

interface NasaFile { url: string; name: string; bytes?: number }
interface NasaItem { slug: string; title: string; description: string; source: string; mission: string; thumb: string; glb: NasaFile[]; zip: NasaFile[] }

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: MB, GB: 1024 * MB };

function parseNasaItem(slug: string, html: string): NasaItem {
  const meta = (p: string) => plain(html.match(new RegExp(`<meta (?:property|name)="${p}" content="([^"]*)"`))?.[1]);
  const title = meta('og:title').replace(/\s*[-–]\s*NASA Science\s*$/, '') || slug;
  const description = meta('og:description') || meta('description');
  const detail = (label: string) => plain(html.match(new RegExp(`<h4 class="label">\\s*${label}\\s*</h4>\\s*<p>([\\s\\S]*?)</p>`))?.[1]);
  const glb: NasaFile[] = [];
  const zip: NasaFile[] = [];
  const seen = new Set<string>();
  for (const row of html.split(/class="hds-list-row hds-file-list-row"/).slice(1)) {
    const href = plain(row.match(/href="(https:\/\/assets\.science\.nasa\.gov\/[^"]+)"/)?.[1]);
    const url = href && modelUrl(href);
    if (!url) continue;
    const path = new URL(url).pathname;
    if (seen.has(path)) continue;
    seen.add(path);
    const size = row.match(/\(([\d.]+)\s*(B|KB|MB|GB)\)/i);
    const bytes = size ? Math.round(Number(size[1]) * (SIZE_UNITS[size[2]!.toUpperCase()] ?? 1)) : undefined;
    const name = decodeURIComponent(path.split('/').pop() ?? '');
    const file = { url, name, ...(bytes ? { bytes } : {}) };
    if (/\.glb$/i.test(path)) glb.push(file);
    else if (/\.zip$/i.test(path)) zip.push(file);
  }
  // Pages without the file list still link the files.
  if (!glb.length) {
    for (const m of html.matchAll(/href="(https:\/\/assets\.science\.nasa\.gov\/[^"]+\.glb)(?:\?[^"]*)?"/gi)) {
      const url = modelUrl(plain(m[1]));
      if (url && !seen.has(url)) { seen.add(url); glb.push({ url, name: decodeURIComponent(url.split('/').pop() ?? '') }); }
    }
  }
  return { slug, title, description, source: detail('Source'), mission: detail('Mission'), thumb: meta('og:image'), glb, zip };
}

/** Whether the page's source line names NASA (or names nobody); outside organizations' terms are unclear. */
const nasaMade = (it: NasaItem) => !it.source || /^NASA\b/i.test(it.source);

function nasaCandidate(it: NasaItem, thumb?: string): ModelCandidate {
  const text = `${it.title}. ${it.description}`;
  const realShape = measured(text);
  const desc = it.description ? firstSentence(it.description) : '';
  const file = it.glb[0] ?? it.zip[0];
  return {
    id: `nasa3d:${it.slug}`, source: 'nasa3d', title: it.title,
    depicts: clip(`${it.title}${desc ? ` — ${desc}` : ''}${realShape ? '' : '（NASA 发布的三维模型）'}`, 260),
    realShape, license: LICENSE.nasa3d, credit: 'NASA', ...(it.source ? { sourceCredit: it.source } : {}),
    ...(file?.bytes ? { bytes: file.bytes } : {}),
    thumb: thumb || it.thumb, pageUrl: `https://science.nasa.gov/3d-resources/${it.slug}/`,
  };
}

const nasaPage = async (slug: string, ms = SEARCH_TIMEOUT) =>
  parseNasaItem(slug, await getText(`https://science.nasa.gov/3d-resources/${slug}/`, ms, SOURCE_NAME.nasa3d));

async function searchNasa3d(text: string, query: string[], limit: number): Promise<Ranked[]> {
  const deadline = Date.now() + SEARCH_TIMEOUT;
  let list = await nasaList(text, 24);
  // The site's search wants every word; try the head noun's phrase without the rest when nothing comes back.
  if (!list.length && query.length > 1) list = await nasaList(query.slice(-2).join(' '), 24);
  const ranked = list
    .map((it) => ({ it, m: match(query, [[it.title, 3]]) }))
    .sort((a, b) => rank(b.m) - rank(a.m))
    .slice(0, Math.min(limit, 8));
  // Each page is read for its glb link, size, source and description: four at a time, within the deadline.
  const out: Ranked[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ranked.length && Date.now() < deadline - 500) {
      const { it } = ranked[next++]!;
      const item = await nasaPage(it.slug, Math.max(3000, deadline - Date.now())).catch(() => null);
      if (!item || !nasaMade(item) || (!item.glb.length && !item.zip.length)) continue;
      // Descriptions mention much besides the model ("the Saturn V moon rocket"): the title or mission must match.
      if (match(query, [[item.title, 3], [item.mission, 2]]).cover < 0.5) continue;
      const m = match(query, [[item.title, 3], [item.mission, 2], [item.description, 1]]);
      out.push({ cand: nasaCandidate(item, it.thumb), rank: rank(m) - (item.glb.length ? 0 : 1) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ranked.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// NASA Scientific Visualization Studio

interface SvsHit { id: number; title: string; description?: string; result_type?: string }
interface SvsMediaItem { instance?: { url?: string; filename?: string; media_type?: string; alt_text?: string } }
interface SvsPage {
  id: number;
  title: string;
  description?: string;
  main_image?: { url?: string };
  media_groups?: Array<{ description?: string; title?: string; items?: SvsMediaItem[] }>;
  keywords?: string[];
}
interface SvsGlb { file: string; url: string; text: string; thumb: string }

const SVS_API = 'https://svs.gsfc.nasa.gov/api';
let svsIndex: { at: number; hits: SvsHit[] } | null = null;

/** SVS pages whose text mentions glb or glTF files (the search cannot filter by file type), kept 12 hours. */
async function svsModelPages(): Promise<SvsHit[]> {
  if (svsIndex && Date.now() - svsIndex.at < 12 * 3600_000) return svsIndex.hits;
  const lists = await Promise.all(['glb', 'gltf'].map((w) =>
    getJson<{ results?: SvsHit[] }>(`${SVS_API}/search/?search=${w}&limit=100`, SEARCH_TIMEOUT, SOURCE_NAME.svs)));
  const seen = new Set<number>();
  const hits = lists.flatMap((l) => l.results ?? []).filter((h) => Number.isInteger(h?.id) && !seen.has(h.id) && seen.add(h.id));
  svsIndex = { at: Date.now(), hits };
  return hits;
}

/** The page's glb files, each with the words that describe it (its alt text and its media group's description). */
function svsGlbs(page: SvsPage): SvsGlb[] {
  const out: SvsGlb[] = [];
  const pageThumb = page.main_image?.url ? modelUrl(page.main_image.url) ?? '' : '';
  for (const g of page.media_groups ?? []) {
    const items = g.items ?? [];
    const image = items.find((i) => i.instance?.media_type === 'Image' && i.instance.url)?.instance?.url;
    for (const it of items) {
      const inst = it.instance;
      const url = inst?.url && modelUrl(inst.url);
      if (!url || !inst?.filename || !/\.glb$/i.test(inst.filename)) continue;
      const text = plain(`${inst.alt_text ?? ''} ${(g.description ?? '').replace(/_{2,}[^_]*_{2,}/g, ' ')}`);
      out.push({ file: inst.filename, url, text, thumb: (image && modelUrl(image)) || pageThumb });
    }
  }
  return out;
}

function svsCandidate(page: SvsPage, g: SvsGlb): ModelCandidate {
  const realShape = measured(g.text);
  const what = g.text || firstSentence(plain(page.description));
  return {
    id: `svs:${page.id}/${g.file}`, source: 'svs', title: `${plain(page.title)}（${g.file}）`,
    depicts: clip(`${what}${realShape ? '' : '（NASA 科学可视化工作室的三维模型）'}`, 260),
    realShape, license: LICENSE.svs, credit: 'NASA', sourceCredit: SVS_CREDIT,
    thumb: g.thumb, pageUrl: `https://svs.gsfc.nasa.gov/${page.id}/`,
  };
}

const svsPage = (id: number, ms = SEARCH_TIMEOUT) => getJson<SvsPage>(`${SVS_API}/${id}`, ms, SOURCE_NAME.svs);

async function searchSvs(query: string[]): Promise<Ranked[]> {
  const pages = (await svsModelPages())
    .map((h) => ({ h, m: match(query, [[plain(h.title), 3], [plain(h.description), 1]]) }))
    .filter((x) => x.m.cover >= 0.5)
    .sort((a, b) => rank(b.m) - rank(a.m))
    .slice(0, 3);
  const out: Ranked[] = [];
  await Promise.all(pages.map(async ({ h, m }) => {
    const page = await svsPage(h.id).catch(() => null);
    if (!page) return;
    // One file per media group, the small variant first: the others are the same model at a higher resolution.
    const byText = new Map<string, SvsGlb>();
    for (const g of svsGlbs(page)) {
      const had = byText.get(g.text);
      if (!had || (/small/i.test(g.file) && !/small/i.test(had.file))) byText.set(g.text, g);
    }
    for (const g of [...byText.values()].slice(0, 4)) {
      if (match(query, [[plain(page.title), 3], [g.text, 2]]).cover < 0.5) continue;
      const fm = match(query, [[plain(page.title), 3], [g.text, 2], [(page.keywords ?? []).join(' '), 1]]);
      out.push({ cand: svsCandidate(page, g), rank: rank(fm.cover >= m.cover ? fm : m) - 0.5 });
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Search

interface Ranked { cand: ModelCandidate; rank: number }
const ALL_SOURCES: ModelSource[] = ['polyhaven', 'nasa3d', 'svs'];

/**
 * Searches the model libraries for an English query (names, tags, categories and descriptions are matched; the
 * last word counts most, so "flower pot" finds pots before flowers). Results from all sources are merged by how
 * well they match. Throws only when every source asked failed.
 */
export async function searchModels(query: string, opts: { limit?: number; sources?: ModelSource[] } = {}): Promise<ModelCandidate[]> {
  const text = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const q = words(text);
  if (!q.length) throw new Error('请给出要找的模型的英文关键词');
  const limit = Math.max(1, Math.min(40, Math.floor(opts.limit ?? 12)));
  const sources = (opts.sources?.length ? opts.sources : ALL_SOURCES).filter((s) => ALL_SOURCES.includes(s));
  const errors: string[] = [];
  const lists = await Promise.all(sources.map(async (s) => {
    try {
      return s === 'polyhaven' ? await searchPolyhaven(q) : s === 'nasa3d' ? await searchNasa3d(text, q, limit) : await searchSvs(q);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return [];
    }
  }));
  if (errors.length === sources.length) throw new Error(`模型库都没有连上：${errors.join('；')}`);
  const seen = new Set<string>();
  // Models whose name or description carries a brand go last: they are poor stand-ins in an ad.
  return lists.flat()
    .map((r) => ({ ...r, cand: { ...r.cand, branded: namesBrand(r.cand) } }))
    .sort((a, b) => Number(a.cand.branded) - Number(b.cand.branded) || b.rank - a.rank)
    .filter((r) => !seen.has(r.cand.id) && seen.add(r.cand.id))
    .slice(0, limit)
    .map((r) => r.cand);
}

// ---------------------------------------------------------------------------------------------------------------
// Raw downloads, cached by source, id and variant

/** A downloaded model as the worker reads it: one .glb, or a .gltf with its resources by URI. */
interface RawModel {
  kind: 'glb' | 'gltf';
  dir: string;
  main: string;
  /** glTF URI (as written in the JSON) → file name inside dir. */
  resources: Record<string, string>;
  bytes: number;
  cand: ModelCandidate;
}

const safeName = (s: string) => `${s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60)}-${createHash('sha1').update(s).digest('hex').slice(0, 8)}`;

const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, job: () => Promise<T>): Promise<T> {
  const had = inflight.get(key) as Promise<T> | undefined;
  if (had) return had;
  const p = job().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function readRaw(dir: string): Promise<RawModel | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'raw.json'), 'utf8')) as RawModel;
    if (!raw?.main || !existsSync(join(dir, raw.main))) return null;
    await touch(join(dir, 'raw.json'));
    return { ...raw, dir };
  } catch {
    return null;
  }
}

/** Marks a cache entry as just used, for the size cap (pruneModelCache drops the least recently used). */
const touch = (file: string) => utimes(file, new Date(), new Date()).catch(() => {});

/**
 * Trims the shared cache to config.modelCacheMaxMb. One model's folder (raw/<source>/<key> or opt/<source>/<key>)
 * goes as a whole, least recently used first; anything used in the last hour is kept, so a fetch in progress is
 * never pulled from under itself.
 */
export async function pruneModelCache(maxBytes = config.modelCacheMaxMb * 1024 * 1024) {
  const entries: Array<{ dir: string; bytes: number; used: number }> = [];
  const walk = async (dir: string, acc: { bytes: number; used: number }) => {
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, d.name);
      if (d.isDirectory()) await walk(p, acc);
      else if (d.isFile()) { const s = await stat(p).catch(() => null); if (s) { acc.bytes += s.size; acc.used = Math.max(acc.used, s.mtimeMs); } }
    }
  };
  for (const kind of ['raw', 'opt']) {
    for (const source of await readdir(join(cacheRoot(), kind), { withFileTypes: true }).catch(() => [])) {
      if (!source.isDirectory()) continue;
      for (const key of await readdir(join(cacheRoot(), kind, source.name), { withFileTypes: true }).catch(() => [])) {
        if (!key.isDirectory()) continue;
        const dir = join(cacheRoot(), kind, source.name, key.name);
        const acc = { bytes: 0, used: 0 };
        await walk(dir, acc);
        entries.push({ dir, ...acc });
      }
    }
  }
  let total = entries.reduce((a, e) => a + e.bytes, 0);
  const removed: string[] = [];
  for (const e of entries.sort((a, b) => a.used - b.used)) {
    if (total <= maxBytes) break;
    if (Date.now() - e.used < 3600_000) continue;
    await rm(e.dir, { recursive: true, force: true });
    total -= e.bytes;
    removed.push(e.dir);
  }
  return { removed, bytes: total };
}

/** Fills a fresh temp dir with `fill`, then renames it into place; a dir another fetch completed first wins. */
async function cacheRaw(dir: string, fill: (tmp: string) => Promise<Omit<RawModel, 'dir'>>): Promise<RawModel> {
  const had = await readRaw(dir);
  if (had) return had;
  const tmp = `${dir}.${randomUUID().slice(0, 8)}.part`;
  await mkdir(tmp, { recursive: true });
  try {
    const raw = await fill(tmp);
    await writeFile(join(tmp, 'raw.json'), JSON.stringify(raw));
    try {
      await rename(tmp, dir);
    } catch {
      const done = await readRaw(dir);
      if (!done) throw new Error('模型缓存写入失败');
      await rm(tmp, { recursive: true, force: true });
      return done;
    }
    return { ...raw, dir };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** A glTF URI as a clean relative path, or null for data: URIs; throws for anything that leaves its folder. */
function relativeUri(uri: string): string | null {
  if (/^data:/i.test(uri)) return null;
  let p: string;
  try { p = decodeURIComponent(uri); } catch { throw new Error('模型引用了无法识别的文件路径'); }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.includes('\\') || p.includes('\0')) throw new Error('模型引用了不允许的文件路径');
  const n = posix.normalize(p);
  if (n === '..' || n.startsWith('../') || n.startsWith('/')) throw new Error('模型引用了不允许的文件路径');
  return n;
}

/** The external files a glTF JSON refers to, by their URI as written. */
function gltfUris(json: unknown): string[] {
  const j = json as { buffers?: Array<{ uri?: unknown }>; images?: Array<{ uri?: unknown }> };
  return [...new Set([...(j.buffers ?? []), ...(j.images ?? [])].map((x) => x?.uri).filter((u): u is string => typeof u === 'string' && !/^data:/i.test(u)))];
}

const extOf = (name: string) => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() ?? 'bin');

/** Poly Haven texture resolution for a texture cap: 1k for small caps, 2k otherwise, else the nearest offered. */
function phResolution(files: PhFiles, maxTexture: number): string {
  const offered = Object.keys(files.gltf ?? {}).filter((r) => files.gltf?.[r]?.gltf?.url);
  if (!offered.length) throw new Error('Poly Haven 没有这个模型的 glTF 文件');
  const want = maxTexture <= 1024 ? ['1k', '2k'] : ['2k', '1k'];
  return want.find((r) => offered.includes(r)) ?? offered.sort((a, b) => parseInt(a) - parseInt(b))[0]!;
}

async function polyhavenRaw(key: string, maxTexture: number, budget: Budget): Promise<RawModel> {
  const who = SOURCE_NAME.polyhaven;
  const [info, files] = await Promise.all([
    getJson<PhAsset>(`${PH_API}/info/${encodeURIComponent(key)}`, SEARCH_TIMEOUT, who),
    getJson<PhFiles>(`${PH_API}/files/${encodeURIComponent(key)}`, SEARCH_TIMEOUT, who),
  ]);
  if (!info?.name || (info.type !== undefined && info.type !== 2)) throw new Error(`Poly Haven 没有叫 ${key} 的模型`);
  const res = phResolution(files, maxTexture);
  const g = files.gltf![res]!.gltf!;
  const include = g.include ?? {};
  const listed = (g.size ?? 0) + Object.values(include).reduce((s, f) => s + (f.size ?? 0), 0);
  if (listed > budget.left) throw tooBig(budget);
  const dir = join(cacheRoot(), 'raw', 'polyhaven', safeName(key), res);
  const cand = phCandidate(key, info);
  return cacheRaw(dir, async (tmp) => {
    const main = 'main.gltf';
    await download(g.url, join(tmp, main), budget, who);
    let json: unknown;
    try { json = JSON.parse(await readFile(join(tmp, main), 'utf8')); } catch { throw new Error('Poly Haven 的模型文件无法解析'); }
    const resources: Record<string, string> = {};
    const includes = new Map(Object.entries(include).map(([k, f]) => [posix.normalize(k), f] as const));
    for (const [i, uri] of gltfUris(json).entries()) {
      const rel = relativeUri(uri);
      if (!rel) continue;
      const f = includes.get(rel);
      if (!f?.url) throw new Error(`Poly Haven 的模型缺少文件 ${clip(rel, 60)}`);
      const name = `r${i}.${extOf(rel)}`;
      await download(f.url, join(tmp, name), budget, who);
      resources[uri] = name;
    }
    return { kind: 'gltf' as const, main, resources, bytes: budget.cap - budget.left, cand };
  });
}

async function nasa3dRaw(slug: string, budget: Budget): Promise<RawModel> {
  const who = SOURCE_NAME.nasa3d;
  const item = await nasaPage(slug);
  if (!item.title) throw new Error(`NASA 3D Resources 没有 ${slug} 这个页面`);
  if (!nasaMade(item)) throw new Error(`这个模型由 ${clip(item.source, 40)} 提供，授权不明确，不能用`);
  const cand = nasaCandidate(item);
  const file = item.glb[0] ?? item.zip[0];
  if (!file) throw new Error('这个 NASA 页面没有 glb 格式的模型');
  if (file.bytes && file.bytes > budget.left * 1.02) throw tooBig(budget);
  const dir = join(cacheRoot(), 'raw', 'nasa3d', safeName(slug), createHash('sha1').update(file.url).digest('hex').slice(0, 10));
  return cacheRaw(dir, async (tmp) => {
    if (item.glb.length) {
      await download(file.url, join(tmp, 'main.glb'), budget, who);
      return { kind: 'glb' as const, main: 'main.glb', resources: {}, bytes: budget.cap - budget.left, cand };
    }
    const zip = join(tmp, 'download.zip');
    await download(file.url, zip, budget, who);
    const got = await extractModel(zip, tmp, budget.cap);
    await rm(zip, { force: true });
    return { ...got, bytes: budget.cap - budget.left, cand };
  });
}

async function svsRaw(key: string, budget: Budget): Promise<RawModel> {
  const who = SOURCE_NAME.svs;
  const m = key.match(/^(\d{1,7})(?:\/(.+))?$/);
  if (!m) throw new Error('SVS 模型编号应为 svs:<页面编号>/<文件名>.glb');
  const page = await svsPage(Number(m[1]));
  const glbs = svsGlbs(page);
  const g = m[2] ? glbs.find((x) => x.file === m[2]) : glbs.find((x) => /small/i.test(x.file)) ?? glbs[0];
  if (!g) throw new Error(m[2] ? `SVS 页面 ${m[1]} 没有 ${clip(m[2], 60)}` : `SVS 页面 ${m[1]} 没有 glb 模型`);
  const cand = { ...svsCandidate(page, g), id: `svs:${key}` };
  const dir = join(cacheRoot(), 'raw', 'svs', safeName(`${page.id}/${g.file}`));
  return cacheRaw(dir, async (tmp) => {
    await download(g.url, join(tmp, 'main.glb'), budget, who);
    return { kind: 'glb' as const, main: 'main.glb', resources: {}, bytes: budget.cap - budget.left, cand };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Zip archives: entries are read by offset and written under our own names, so no path in the archive is used

const inflateRawAsync = promisify(inflateRaw);

interface ZipEntry { name: string; method: number; flags: number; csize: number; size: number; offset: number }

function zipEntries(buf: Buffer): ZipEntry[] {
  const from = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('压缩包已损坏');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('不支持 ZIP64 压缩包');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('压缩包已损坏');
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({
      flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42), name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

async function zipRead(buf: Buffer, e: ZipEntry, cap: number): Promise<Buffer> {
  if (e.flags & 1) throw new Error('压缩包里的文件有密码');
  if (e.size > cap) throw new Error('压缩包里的模型太大');
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('压缩包已损坏');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.csize);
  if (data.length !== e.csize) throw new Error('压缩包已损坏');
  const out = e.method === 0 ? Buffer.from(data) : e.method === 8 ? await inflateRawAsync(data, { maxOutputLength: Math.max(1, e.size) }) : null;
  if (!out) throw new Error('压缩包用了不支持的压缩方式');
  if (out.length !== e.size) throw new Error('压缩包已损坏');
  return out;
}

/** Takes the model out of a zip: the first .glb, or the first .gltf with the files it refers to. */
async function extractModel(zipPath: string, outDir: string, cap: number): Promise<Pick<RawModel, 'kind' | 'main' | 'resources'>> {
  const buf = await readFile(zipPath);
  const entries = zipEntries(buf).filter((e) => {
    if (e.name.endsWith('/') || e.name.includes('\\') || e.name.includes('\0') || /^[a-z]:/i.test(e.name) || e.name.startsWith('/')) return false;
    const n = posix.normalize(e.name);
    return n !== '..' && !n.startsWith('../') && !/(^|\/)__MACOSX\//.test(n);
  });
  const byName = new Map(entries.map((e) => [posix.normalize(e.name), e] as const));
  let total = 0;
  const take = async (e: ZipEntry, name: string) => {
    total += e.size;
    if (total > cap) throw new Error(`解压后的模型超过 ${fmtBytes(cap)}`);
    await writeFile(join(outDir, name), await zipRead(buf, e, cap), { flag: 'wx' });
  };
  const glb = entries.find((e) => /\.glb$/i.test(e.name));
  if (glb) {
    await take(glb, 'main.glb');
    return { kind: 'glb', main: 'main.glb', resources: {} };
  }
  const gltf = entries.find((e) => /\.gltf$/i.test(e.name));
  if (!gltf) throw new Error('压缩包里没有 glb 或 glTF 模型');
  await take(gltf, 'main.gltf');
  let json: unknown;
  try { json = JSON.parse(await readFile(join(outDir, 'main.gltf'), 'utf8')); } catch { throw new Error('压缩包里的 glTF 无法解析'); }
  const base = posix.dirname(posix.normalize(gltf.name));
  const resources: Record<string, string> = {};
  for (const [i, uri] of gltfUris(json).entries()) {
    const rel = relativeUri(uri);
    if (!rel) continue;
    const full = posix.normalize(posix.join(base, rel));
    const e = full.startsWith('../') ? undefined : byName.get(full);
    if (!e) throw new Error(`压缩包里缺少模型文件 ${clip(rel, 60)}`);
    const name = `r${i}.${extOf(rel)}`;
    await take(e, name);
    resources[uri] = name;
  }
  return { kind: 'gltf', main: 'main.gltf', resources };
}

// ---------------------------------------------------------------------------------------------------------------
// Fetch

interface Caps { maxTriangles: number; maxTexture: number; maxBytes: number }

function caps(opts: { maxTriangles?: number; maxTexture?: number; maxBytes?: number }): Caps {
  const num = (v: number | undefined, d: number, lo: number, hi: number) => (Number.isFinite(v) && v! > 0 ? Math.round(Math.min(hi, Math.max(lo, v!))) : d);
  return {
    maxTriangles: num(opts.maxTriangles, DEFAULT_TRIANGLES, 100, 5_000_000),
    maxTexture: num(opts.maxTexture, DEFAULT_TEXTURE, 16, 8192),
    maxBytes: num(opts.maxBytes, DEFAULT_BYTES, 1024, 2048 * MB),
  };
}

interface OptimisedMeta { cand: ModelCandidate; triangles: number; textures: number; bytes: number; sizeMetres: [number, number, number] | null; rawBytes: number }

function parseId(id: string): { source: ModelSource; key: string } {
  const m = String(id ?? '').trim().match(/^(polyhaven|nasa3d|svs):(.+)$/);
  if (!m) throw new Error(`模型编号格式不对：${clip(String(id), 60)}（应为 polyhaven:…、nasa3d:… 或 svs:…）`);
  const source = m[1] as ModelSource;
  const key = m[2]!.trim();
  const ok = source === 'polyhaven' ? /^[A-Za-z0-9_-]{1,100}$/.test(key)
    : source === 'nasa3d' ? /^[a-z0-9-]{1,120}$/.test(key)
    : /^\d{1,7}(?:\/[A-Za-z0-9 ._()-]{1,120}\.glb)?$/i.test(key);
  if (!ok) throw new Error(`模型编号格式不对：${clip(String(id), 60)}`);
  return { source, key };
}

/**
 * Downloads one model (or takes it from the shared cache), optimises it to the caps and writes it into assetsDir as
 * md-<source>-<hash>.glb: one self-contained binary glTF, centred at the origin and scaled into a unit bounding
 * sphere (sizeMetres keeps the original size). The model is recorded in the project's assets_manifest.json (the
 * project is assetsDir's parent) with its licence, credit and realShape; the entry is returned too.
 */
export async function fetchModel(
  id: string,
  assetsDir: string,
  opts: { maxTriangles?: number; maxTexture?: number; maxBytes?: number } = {},
): Promise<FetchedModel> {
  const { source, key } = parseId(id);
  const c = caps(opts);
  const capsKey = `t${c.maxTriangles}-x${c.maxTexture}-p${PIPELINE}`;
  const variant = source === 'polyhaven' ? `${c.maxTexture <= 1024 ? '1k' : '2k'}-` : '';
  const optDir = join(cacheRoot(), 'opt', source, safeName(key));
  const optBase = join(optDir, `${variant}${capsKey}`);
  const file = `md-${source}-${createHash('sha1').update(`${source}:${key}|${capsKey}`).digest('hex').slice(0, 10)}.glb`;

  const meta = await once(`opt:${optBase}`, async (): Promise<OptimisedMeta> => {
    const cached = await readFile(`${optBase}.json`, 'utf8').then((s) => JSON.parse(s) as OptimisedMeta).catch(() => null);
    if (cached && existsSync(`${optBase}.glb`)) {
      await touch(`${optBase}.json`);
      if (cached.rawBytes > c.maxBytes) throw overCap(c.maxBytes);
      return cached;
    }
    const raw = await once(`raw:${source}:${key}:${variant}`, async () => {
      const budget: Budget = { left: c.maxBytes, cap: c.maxBytes };
      if (source === 'polyhaven') {
        const res = c.maxTexture <= 1024 ? '1k' : '2k';
        const hit = await readRaw(join(cacheRoot(), 'raw', 'polyhaven', safeName(key), res));
        return hit ?? polyhavenRaw(key, c.maxTexture, budget);
      }
      return source === 'nasa3d' ? nasa3dRaw(key, budget) : svsRaw(key, budget);
    });
    if (raw.bytes > c.maxBytes) throw overCap(c.maxBytes);
    await mkdir(optDir, { recursive: true });
    const tmp = `${optBase}.${randomUUID().slice(0, 8)}.tmp.glb`;
    try {
      const r = await runWorker<OptimiseResult>({ op: 'optimise', raw, maxTriangles: c.maxTriangles, maxTexture: c.maxTexture, out: tmp }, WORKER_TIMEOUT);
      const m: OptimisedMeta = { cand: raw.cand, triangles: r.triangles, textures: r.textures, bytes: r.bytes, sizeMetres: r.sizeMetres, rawBytes: raw.bytes };
      await rename(tmp, `${optBase}.glb`);
      await writeFile(`${optBase}.json`, JSON.stringify({ ...m, trianglesBefore: r.trianglesBefore, ms: r.ms, warnings: r.warnings }));
      return m;
    } finally {
      await rm(tmp, { force: true });
    }
  });

  await mkdir(assetsDir, { recursive: true });
  const dest = join(assetsDir, file);
  if (!existsSync(dest) || statSync(dest).size !== meta.bytes) {
    const tmp = `${dest}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await copyFile(`${optBase}.glb`, tmp);
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  const cand = meta.cand;
  const entry: ModelManifestEntry = {
    file, id: `${source}:${key}`, source, kind: 'model', model3d: true, title: cand.title, depicts: cand.depicts, realShape: cand.realShape,
    pageUrl: cand.pageUrl, license: cand.license, credit: cand.credit, needsAttribution: false,
    // A rendered model is never a photograph.
    artwork: true, ...(cand.sourceCredit ? { sourceCredit: cand.sourceCredit } : {}),
    triangles: meta.triangles, textures: meta.textures, sizeMetres: meta.sizeMetres, fetchedAt: new Date().toISOString(),
  };
  // footage.ts types the manifest for footage; model entries share the file and carry model3d to tell them apart.
  recordManifest(dirname(assetsDir), entry);
  return { file, triangles: meta.triangles, textures: meta.textures, bytes: meta.bytes, sizeMetres: meta.sizeMetres, entry };
}

/** Triangles, meshes, textures and bounding box of a .glb (read in a worker thread). */
export async function modelStats(glbPath: string): Promise<ModelStats> {
  return runWorker<ModelStats>({ op: 'stats', file: glbPath }, 120_000);
}

// ---------------------------------------------------------------------------------------------------------------
// Worker thread: everything that parses or transforms a model runs here, off the main event loop

const WORKER_TAG = 'video_agent:models';
type Job =
  | { op: 'optimise'; raw: RawModel; maxTriangles: number; maxTexture: number; out: string }
  | { op: 'stats'; file: string }
  | { op: 'textures'; file: string; max: number };
interface OptimiseResult {
  triangles: number; trianglesBefore: number; textures: number; bytes: number;
  sizeMetres: [number, number, number] | null; ms: number; warnings: string[];
}

/** At most two optimisations at once: each holds a whole model in memory and keeps a core busy. */
const workerLimit = createLimiter(2);

function runWorker<T>(job: Job, timeoutMs: number): Promise<T> {
  return workerLimit(() => new Promise<T>((resolve, reject) => {
    let done = false;
    const w = new Worker(new URL(import.meta.url), { workerData: { tag: WORKER_TAG, job }, resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); void w.terminate(); };
    const timer = setTimeout(() => finish(() => reject(new Error('模型处理超时'))), timeoutMs);
    w.on('message', (m: { ok: boolean; result?: T; error?: string }) =>
      finish(() => (m.ok ? resolve(m.result as T) : reject(new Error(m.error || '模型处理失败')))));
    w.on('error', (e: Error) => finish(() => reject(new Error(`模型处理失败：${clip(e.message, 200)}`))));
    w.on('exit', (code) => finish(() => reject(new Error(`模型处理意外退出（${code}）`))));
  }));
}

/** Loads gltf-transform without sharp: @gltf-transform/functions pulls it in for features not used here. */
async function loadLibs() {
  // Native image code must never load: resolve 'sharp' to a stub before the functions package asks for it.
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'sharp' || spec.startsWith('@img/sharp')) {
        return { url: 'data:text/javascript,export default function sharp(){throw new Error("sharp is disabled")}', format: 'module', shortCircuit: true };
      }
      return next(spec, ctx);
    },
  });
  const core = await import('@gltf-transform/core');
  const ext = await import('@gltf-transform/extensions');
  const fn = await import('@gltf-transform/functions');
  const { MeshoptSimplifier, MeshoptDecoder } = await import('meshoptimizer');
  await Promise.all([MeshoptSimplifier.ready, MeshoptDecoder.ready]);
  return { core, ext, fn, MeshoptSimplifier, MeshoptDecoder };
}
type Libs = Awaited<ReturnType<typeof loadLibs>>;

/** Reads a model, registering the Draco decoder only when the file needs it. */
async function readDoc(L: Libs, input: { kind: 'glb'; bytes: Uint8Array } | { kind: 'gltf'; json: unknown; resources: Record<string, Uint8Array> }): Promise<Document> {
  const io = new L.core.NodeIO().setLogger(quiet(L)).registerExtensions(L.ext.ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': L.MeshoptDecoder });
  const jsonDoc = input.kind === 'glb'
    ? await io.binaryToJSON(input.bytes)
    : { json: input.json as never, resources: input.resources as Record<string, Uint8Array<ArrayBuffer>> };
  const used = (jsonDoc.json as { extensionsUsed?: string[] }).extensionsUsed ?? [];
  if (used.includes('KHR_draco_mesh_compression')) {
    const draco = createRequire(import.meta.url)('draco3dgltf') as { createDecoderModule: () => Promise<unknown> };
    io.registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
  }
  return (await io.readJSON(jsonDoc)).setLogger(quiet(L));
}

/** gltf-transform logs each transform's work to the console; the server's log has no use for it. */
const quiet = (L: Libs) => new L.core.Logger(L.core.Logger.Verbosity.SILENT);

function primTriangles(prim: Primitive): number {
  const n = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
  const mode = prim.getMode();
  return mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
}

/** Triangles drawn for a scene: each node's mesh, times its GPU instances. */
function sceneTriangles(scene: Scene): number {
  let total = 0;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const inst = node.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing');
    const copies = inst?.listAttributes()[0]?.getCount() ?? 1;
    for (const p of mesh.listPrimitives()) total += primTriangles(p) * copies;
  });
  return total;
}

/** World-space bounding box of the scene's vertices and the sphere around its centre, read vertex by vertex. */
function sceneSphere(scene: Scene): { min: number[]; max: number[]; centre: number[]; radius: number } | null {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const meshes: Array<[GNode, Float32Array | number[]]> = [];
  scene.traverse((node) => { if (node.getMesh()) meshes.push([node, node.getWorldMatrix() as number[]]); });
  const v = [0, 0, 0];
  const world = (m: ArrayLike<number>) => [
    m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!,
    m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!,
    m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!,
  ];
  const each = (fn: (p: number[]) => void) => {
    for (const [node, m] of meshes) {
      for (const prim of node.getMesh()!.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        for (let i = 0, n = pos.getCount(); i < n; i++) { pos.getElement(i, v); fn(world(m)); }
      }
    }
  };
  each((p) => { for (let k = 0; k < 3; k++) { if (p[k]! < min[k]!) min[k] = p[k]!; if (p[k]! > max[k]!) max[k] = p[k]!; } });
  if (!Number.isFinite(min[0]!) || !Number.isFinite(max[0]!)) return null;
  const centre = [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2);
  let r2 = 0;
  each((p) => { const d = (p[0]! - centre[0]!) ** 2 + (p[1]! - centre[1]!) ** 2 + (p[2]! - centre[2]!) ** 2; if (d > r2) r2 = d; });
  return { min, max, centre, radius: Math.sqrt(r2) };
}

/** Runs ffmpeg with `input` on stdin and returns stdout (at most `cap` bytes); killed after FFMPEG_TIMEOUT. */
function ffmpegPipe(args: string[], input: Uint8Array, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let n = 0, err = '', failed: Error | null = null;
    const timer = setTimeout(() => { failed ??= new Error('ffmpeg 处理贴图超时'); p.kill('SIGKILL'); }, FFMPEG_TIMEOUT);
    p.stdout.on('data', (d: Buffer) => {
      n += d.length;
      if (n > cap) { failed ??= new Error('贴图解码结果过大'); p.kill('SIGKILL'); return; }
      chunks.push(d);
    });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.stdin.on('error', () => {});
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
      else resolve(Buffer.concat(chunks));
    });
    p.stdin.end(input);
  });
}

const DECODABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Resizes textures over maxTexture (and turns big opaque PNGs into JPEG) through ffmpeg; PNG only with alpha. */
async function shrinkTextures(L: Libs, doc: Document, maxTexture: number, warnings: string[]) {
  const root = doc.getRoot();
  for (const [i, tex] of root.listTextures().entries()) {
    const img = tex.getImage();
    const mime = tex.getMimeType();
    const size = img ? L.core.ImageUtils.getSize(img, mime) : null;
    if (!img || !size || !DECODABLE.has(mime)) {
      // KTX2/Basis or unreadable images: without a decoder the renderer cannot show them either.
      warnings.push(`贴图 ${tex.getName() || i} 的格式（${mime || '未知'}）无法处理，已去掉`);
      tex.dispose();
      continue;
    }
    const over = Math.max(size[0], size[1]) > maxTexture;
    const bulkyPng = mime === 'image/png' && img.byteLength > MB;
    if (!over && !bulkyPng) continue;
    const k = over ? maxTexture / Math.max(size[0], size[1]) : 1;
    const w = Math.max(1, Math.round(size[0] * k)), h = Math.max(1, Math.round(size[1] * k));
    let raw: Buffer;
    try {
      raw = await ffmpegPipe(['-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=lanczos,format=rgba`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], img, w * h * 4 + 64);
    } catch (e) {
      if (!over) continue;
      warnings.push(`贴图 ${tex.getName() || i} 无法解码，已去掉（${clip(e instanceof Error ? e.message : String(e), 80)}）`);
      tex.dispose();
      continue;
    }
    if (raw.length !== w * h * 4) throw new Error('贴图解码结果尺寸不对');
    let alpha = false;
    for (let p = 3; p < raw.length; p += 4) if (raw[p]! < 255) { alpha = true; break; }
    if (!over && alpha) continue;
    const enc = await ffmpegPipe(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1',
      ...(alpha ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj444p']), '-f', 'image2pipe', 'pipe:1'], raw, 64 * MB);
    tex.setImage(enc).setMimeType(alpha ? 'image/png' : 'image/jpeg').setURI(`texture_${i}.${alpha ? 'png' : 'jpg'}`);
  }
  // Format extensions left without any texture of their format.
  const mimes = new Set(root.listTextures().map((t) => t.getMimeType()));
  const formatExt: Record<string, string> = { EXT_texture_webp: 'image/webp', EXT_texture_avif: 'image/avif', KHR_texture_basisu: 'image/ktx2' };
  for (const e of root.listExtensionsUsed()) if (formatExt[e.extensionName] && !mimes.has(formatExt[e.extensionName]!)) e.dispose();
}

async function optimise(job: Extract<Job, { op: 'optimise' }>): Promise<OptimiseResult> {
  const t0 = performance.now();
  const L = await loadLibs();
  const { fn } = L;
  const warnings: string[] = [];
  const raw = job.raw;
  const doc = raw.kind === 'glb'
    ? await readDoc(L, { kind: 'glb', bytes: await readFile(join(raw.dir, raw.main)) })
    : await readDoc(L, {
      kind: 'gltf',
      json: JSON.parse(await readFile(join(raw.dir, raw.main), 'utf8')),
      resources: Object.fromEntries(await Promise.all(Object.entries(raw.resources).map(async ([uri, f]) => {
        const bytes = new Uint8Array(await readFile(join(raw.dir, f)));
        return [uri, bytes] as const;
      })).then((pairs) => pairs.flatMap(([uri, b]) => {
        let dec = uri;
        try { dec = decodeURIComponent(uri); } catch { /* keep as written */ }
        return dec === uri ? [[uri, b]] : [[uri, b], [dec, b]];
      }))),
    });
  const root = doc.getRoot();

  // One scene, no cameras or lights of its own, no compression extensions (they would need encoders to write).
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('模型文件里没有场景');
  for (const s of root.listScenes()) if (s !== scene) s.dispose();
  root.setDefaultScene(scene);
  for (const cam of root.listCameras()) cam.dispose();
  await doc.transform(fn.dequantize());
  for (const e of root.listExtensionsUsed()) {
    if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'KHR_lights_punctual'].includes(e.extensionName)) e.dispose();
  }
  const before = sceneSphere(scene);
  const sizeMetres = before ? ([0, 1, 2].map((k) => Math.round((before.max[k]! - before.min[k]!) * 1e4) / 1e4) as [number, number, number]) : null;
  if (!before || before.radius <= 0 || !Number.isFinite(before.radius)) throw new Error('模型没有可显示的几何体');

  await doc.transform(fn.dedup(), fn.prune(), fn.weld());
  if (!root.listAnimations().length && !root.listSkins().length) await doc.transform(fn.flatten(), fn.join(), fn.prune());
  const trianglesBefore = sceneTriangles(scene);

  // Simplify with growing error limits until the budget is met, then fall back to sloppy simplification.
  let tri = trianglesBefore;
  for (const error of [0.001, 0.01, 0.05, 1]) {
    if (tri <= job.maxTriangles) break;
    const ratio = Math.max(0.001, Math.min(1, (job.maxTriangles / tri) * 0.95));
    await doc.transform(fn.simplify({ simplifier: L.MeshoptSimplifier, ratio, error }));
    tri = sceneTriangles(scene);
  }
  if (tri > job.maxTriangles) {
    const ratio = (job.maxTriangles / tri) * 0.9;
    for (const mesh of root.listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const idx = prim.getIndices(), pos = prim.getAttribute('POSITION');
        if (prim.getMode() !== 4 || !idx || !pos) continue;
        const positions = pos.getArray() instanceof Float32Array ? (pos.getArray() as Float32Array) : Float32Array.from(pos.getArray() ?? []);
        const indices = Uint32Array.from(idx.getArray() ?? []);
        const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
        const [out] = L.MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 1);
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(out)).setBuffer(idx.getBuffer()));
        fn.compactPrimitive(prim);
      }
    }
    await doc.transform(fn.prune());
    tri = sceneTriangles(scene);
    if (tri > job.maxTriangles) throw new Error(`模型太复杂，简化后仍有 ${tri} 个三角形（上限 ${job.maxTriangles}）`);
    warnings.push('模型用粗略简化才降到三角形上限以内，细节可能有损');
  }

  await shrinkTextures(L, doc, job.maxTexture, warnings);

  // Centre at the origin and scale into a unit bounding sphere, under one new root node.
  const sphere = sceneSphere(scene);
  if (!sphere || sphere.radius <= 0) throw new Error('模型简化后没有可显示的几何体');
  const s = 1 / sphere.radius;
  const wrap = doc.createNode('model_root').setScale([s, s, s]).setTranslation([-sphere.centre[0]! * s, -sphere.centre[1]! * s, -sphere.centre[2]! * s]);
  for (const child of scene.listChildren()) { scene.removeChild(child); wrap.addChild(child); }
  scene.addChild(wrap);

  await doc.transform(fn.prune(), fn.unpartition());
  for (const b of root.listBuffers()) b.setURI('');
  const io = new L.core.NodeIO().setLogger(quiet(L)).registerExtensions(L.ext.ALL_EXTENSIONS);
  const glb = await io.writeBinary(doc);
  await writeFile(job.out, glb);
  return {
    triangles: sceneTriangles(scene), trianglesBefore, textures: root.listTextures().length, bytes: glb.byteLength,
    sizeMetres, ms: Math.round(performance.now() - t0), warnings,
  };
}

async function stats(file: string): Promise<ModelStats> {
  const L = await loadLibs();
  const bytes = await readFile(file);
  const doc = await readDoc(L, { kind: 'glb', bytes });
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  let maxSize = 0;
  for (const t of root.listTextures()) {
    const img = t.getImage();
    const size = img ? L.core.ImageUtils.getSize(img, t.getMimeType()) : null;
    if (size) maxSize = Math.max(maxSize, size[0], size[1]);
  }
  const box = scene ? L.core.getBounds(scene) : null;
  const finite = box && [...box.min, ...box.max].every(Number.isFinite);
  return {
    triangles: scene ? sceneTriangles(scene) : 0,
    meshes: root.listMeshes().length,
    primitives: root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0),
    textures: { count: root.listTextures().length, maxSize },
    bbox: finite ? { min: [...box.min] as [number, number, number], max: [...box.max] as [number, number, number] } : null,
    bytes: bytes.byteLength,
  };
}

/** The largest colour textures of a model (base colour and emissive first), as stored: PNG or JPEG bytes. */
async function textures(file: string, max: number): Promise<Array<{ mime: 'image/png' | 'image/jpeg'; data: Uint8Array }>> {
  const L = await loadLibs();
  const doc = await readDoc(L, { kind: 'glb', bytes: await readFile(file) });
  const root = doc.getRoot();
  const colour = new Set(root.listMaterials().flatMap((m) => [m.getBaseColorTexture(), m.getEmissiveTexture()]).filter(Boolean));
  const area = (t: ReturnType<typeof root.listTextures>[number]) => {
    const img = t.getImage();
    const size = img ? L.core.ImageUtils.getSize(img, t.getMimeType()) : null;
    return size ? size[0] * size[1] : 0;
  };
  return root.listTextures()
    .filter((t) => t.getImage() && (t.getMimeType() === 'image/png' || t.getMimeType() === 'image/jpeg'))
    .sort((a, b) => Number(colour.has(b)) - Number(colour.has(a)) || area(b) - area(a))
    .slice(0, max)
    .map((t) => ({ mime: t.getMimeType() as 'image/png' | 'image/jpeg', data: t.getImage()! }));
}

/**
 * A downloaded model's largest colour textures, for a look at what is printed on it (brand names, logos):
 * the metadata rarely says, and a lens ring's lettering is only legible on the texture itself.
 */
export async function modelTextures(glbPath: string, max = 3): Promise<Array<{ mime: 'image/png' | 'image/jpeg'; data: Buffer }>> {
  const out = await runWorker<Array<{ mime: 'image/png' | 'image/jpeg'; data: Uint8Array }>>({ op: 'textures', file: glbPath, max }, 60_000);
  return out.map((t) => ({ mime: t.mime, data: Buffer.from(t.data) }));
}

/**
 * Brand and product names that turn up in model libraries (cameras, phones, drinks, cars, sportswear…), and
 * trademark signs. A model carrying someone's brand is a poor stand-in in an ad or a generic product shot.
 */
const BRANDS = /\b(leica|canon|nikon|sony|fujifilm|olympus|pentax|hasselblad|polaroid|kodak|zeiss|apple|iphone|ipad|macbook|airpods|samsung|huawei|xiaomi|microsoft|xbox|playstation|nintendo|coca[- ]?cola|pepsi|sprite|fanta|red bull|monster energy|starbucks|nescaf[eé]|heineken|budweiser|nike|adidas|converse|gucci|chanel|prada|louis vuitton|rolex|casio|lego|ikea|bmw|mercedes|audi|porsche|ferrari|lamborghini|toyota|honda|tesla|ford|volkswagen|vw|jeep|vespa|harley|ducati|dyson|bose|jbl|marshall|fender|gibson|yamaha|zippo|jack daniel'?s|absolut|heinz|kellogg'?s|nutella|oreo|pringles|lay'?s|tabasco|makita|dewalt|bosch|husqvarna|stihl)\b|[™®]/i;

/** Whether a candidate's name or description names a brand (see BRANDS). */
export function namesBrand(c: Pick<ModelCandidate, 'title' | 'depicts'>) {
  return BRANDS.test(`${c.title} ${c.depicts}`);
}

if (!isMainThread && (workerData as { tag?: string } | null)?.tag === WORKER_TAG) {
  const job = (workerData as { job: Job }).job;
  (job.op === 'optimise' ? optimise(job) : job.op === 'textures' ? textures(job.file, job.max) : stats(job.file)).then(
    (result) => parentPort!.postMessage({ ok: true, result }),
    (e: unknown) => parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
}
