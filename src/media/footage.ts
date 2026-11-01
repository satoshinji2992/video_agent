// Real footage from free libraries: the NASA Image and Video Library and Wikimedia Commons. Science and news
// explainers need the actual spacecraft, launch or galaxy, not a generated look-alike, and every clip must carry
// its source and licence into the video's source label and end credits. Only licences that allow reuse in an
// edited video are let through (public domain, CC0, CC BY, CC BY-SA). NASA's library also hosts company, partner-
// agency and university pictures that are not NASA works: an item is public domain only when its creator fields
// and credit lines name NASA or a person; ESA/Hubble and ESA/Webb items keep their CC BY 4.0 licence and credit,
// and anything else credited to an outside organization is dropped. Files land in the project's assets/ folder
// and are listed in assets_manifest.json (written by the caller) so credits can be built later. Artist's concepts,
// renderings, animations and data visualizations are flagged as artwork and credited as such ("艺术想象图（NASA）"),
// so the video never passes a picture of what something might look like off as a photograph of it.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { atomicOutput } from '../core/ffmpeg.ts';

export type FootageSource = 'nasa' | 'commons';

export interface FootageCandidate {
  /** 'nasa:<nasa_id>' or 'commons:<File:Title.ext>'; stable, passed back to fetchFootage. */
  id: string;
  source: FootageSource;
  kind: 'image' | 'video';
  title: string;
  /** Short plain text, at most ~200 characters. */
  description: string;
  /** https URL of a small preview image. */
  thumb: string;
  /** Human page for attribution. */
  pageUrl: string;
  /** Short form: 'Public domain (NASA)', 'Public domain', 'CC0', 'CC BY 4.0', 'CC BY-SA 3.0 IGO' ... */
  license: string;
  /**
   * For the on-screen source label and end credits, printed verbatim: 'NASA/JHU-APL', 'NASA', '<Artist> / Wikimedia
   * Commons'. Artwork says so: '艺术想象图（NASA/JPL-Caltech）', '艺术想象动画（ESA/Hubble, M. Kornmesser）', '示意图（NASA）'.
   */
  credit: string;
  /** True for CC BY / BY-SA: the credit must be shown. */
  needsAttribution: boolean;
  /**
   * True when the picture is not a photograph or real footage: an illustration, artist's concept or impression,
   * rendering, CGI or animation, simulation, infographic or data visualization. Its credit is labelled as artwork.
   */
  artwork?: boolean;
  /** The library's own credit line, without the artwork label (set only when artwork is true). */
  sourceCredit?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface ManifestEntry {
  /** File name inside the project's assets/ folder. */
  file: string;
  id: string;
  /** Archive footage, or a 3D model from a model library (src/render/models.ts). */
  source: FootageSource | 'polyhaven' | 'nasa3d' | 'svs';
  kind: 'image' | 'video' | 'model';
  title: string;
  pageUrl: string;
  license: string;
  credit: string;
  needsAttribution: boolean;
  /** As in FootageCandidate. Written as true or false; missing in manifests from before artwork was detected. */
  artwork?: boolean;
  sourceCredit?: string;
  fetchedAt: string;
  usedFor?: string[];
  /** 3D models: what the model depicts, and whether it is the measured shape of that very object. */
  depicts?: string;
  realShape?: boolean;
}

const UA = 'video-agent-demo/0.1 (footage search)';
const HEADERS = { 'User-Agent': UA };
const SEARCH_TIMEOUT = 20_000;
const MB = 1024 * 1024;
const IMAGE_CAP = 15 * MB;
const VIDEO_CAP = 80 * MB;
const PNG_KEEP_MAX = 8 * MB;
/** How long one ffmpeg transcode of a downloaded file may run before it is killed. */
const IMAGE_TRANSCODE_MS = 120_000;
const VIDEO_TRANSCODE_MS = 600_000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIMES = new Set(['video/webm', 'video/ogg', 'video/mp4']);
const SOURCE_NAME: Record<FootageSource, string> = { nasa: 'NASA 素材库', commons: 'Wikimedia Commons' };

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML (or plain text) to one line of plain text. */
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

/** A long author list cut at a comma so it still reads as a credit line; otherwise cut after a word or a '/'. */
function shortCredit(s: string, n = 60): string {
  if (s.length <= n) return s;
  const head = s.slice(0, n - 7);
  const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf(' and '), head.lastIndexOf('; '));
  if (cut >= 12) return `${head.slice(0, cut).trimEnd()} et al.`;
  // "NASA's Scientific Visualization Studio - Marit Jentoft-Nilsen …", never "… Jentoft-Ni…".
  const words = s.slice(0, n);
  const end = Math.max(words.lastIndexOf(' '), words.lastIndexOf('/'));
  return end >= n / 2 ? `${words.slice(0, end).replace(/[\s/,;:&-]+$/, '')}…` : clip(s, n);
}

/** https, percent-encoded (NASA hrefs contain raw spaces), without Wikimedia's tracking parameters. */
function cleanUrl(href: string): string {
  try {
    const u = new URL(href.replace(/^http:\/\//, 'https://'));
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
    return u.href;
  } catch {
    return '';
  }
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** The only hosts footage is fetched from. Every URL, and every redirect hop, must be one of them, over https. */
const FOOTAGE_HOSTS = new Set(['images-api.nasa.gov', 'images-assets.nasa.gov', 'commons.wikimedia.org', 'upload.wikimedia.org', 'thumb.wikimedia.org']);

/** An allowed https URL (http on an allowed host is upgraded), or null. */
export function footageUrl(raw: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol === 'http:') u.protocol = 'https:';
  return u.protocol === 'https:' && FOOTAGE_HOSTS.has(u.hostname) ? u.toString() : null;
}

/** fetch() that follows redirects itself, at most 5, checking the host of each hop. */
export async function safeFetch(raw: string, init: RequestInit): Promise<Response> {
  let url = footageUrl(raw);
  for (let hop = 0; url && hop < 6; hop++) {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) return res;
    await res.body?.cancel().catch(() => {});
    url = footageUrl(next, url);
  }
  throw new Error('素材地址不在允许的来源里');
}

async function getJson<T>(url: string, ms: number, who: string): Promise<T> {
  let res: Response;
  try {
    res = await safeFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new Error(isTimeout(e) ? `${who}响应超时` : `${who}连接失败`);
  }
  if (res.status === 429) throw new Error(`${who}请求太频繁，稍后再试`);
  if (!res.ok) throw new Error(`${who}返回错误 ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new Error(isTimeout(e) ? `${who}响应超时` : `${who}返回的数据无法解析`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Artwork or real imagery

// Libraries mix artist's concepts with photographs under one mission name (a rover's selfies sit next to renderings
// of its landing, a telescope's deep fields next to artist's impressions of the planets it found), and a credit like
// "NASA/JPL-Caltech" on an illustration reads as a photo credit. Which one an item is shows in its title, its tags
// (NASA keywords, Commons categories) and the opening words of its description, where "This illustration depicts
// ..." is said.

/** "Artist's", "artists'", and "artist?s" as old NASA records print the apostrophe. */
const ARTIST = String.raw`artist(?:['’?]?s|s['’]?)?`;
/** Words that name a made picture: illustration, artist's concept, rendering, CGI, painting. */
const ART_WORDS = String.raw`${ARTIST}\s+(?:concept(?:ion)?s?|impressions?|renderings?|illustrations?|depictions?|interpretations?|drawings?|representations?|animations?|views?)|illustrations?|artworks?|space\s+art|concept\s+art|(?<!of[\s-]the[\s-])art\s+concepts?|conceptual\s+(?:images?|illustrations?|art|designs?|drawings?|views?|renderings?)|(?<!(?:false|true|enhanced|natural|represent\w*)[\s-]colou?r\s)renderings?|3D\s+(?:render|model)\w*|computer[\s-]generated|CGI|paintings?\s+(?:of|by)|(?:painted|drawn|sketched)\s+by|(?:oil|acrylic|watercolou?r)\s+paintings?|oil\s+on\s+(?:canvas|panel|board)`;
/** Animation in a title or tag: usually CGI. Not an "animated GIF", which is a file format for real frames too. */
const ANIM_RE = /\banimat\w*\b(?!\s+gifs?\b)/i;
/** Explanatory pictures that are not photographs either: infographics, diagrams, data visualizations. */
const DIAGRAM_WORDS = String.raw`infographics?|diagrams?|visuali[sz]ations?(?!\s+Studio)`;
/** Charts, named in a tag ("Exoplanet charts", "star chart") or as "this chart": in a title or prose "charts" is often
 * a verb ("Webb charts ..."). */
const CHART_RE = /\bcharts?\b/i;
/** Computed pictures, unless the item is about crew training or an analog mission (see TRAINING). */
const SIM_WORDS = String.raw`simulations?\s+(?:of|shows?|showing|depicts?|depicting|reveals?|illustrates?)|(?:computer|numerical|supercomputer|hydrodynamic|impact|model)\s+simulations?|simulated\s+(?:views?|images?|pictures?|footage|impacts?|flyovers?|flights?)`;
const ART_RE = new RegExp(String.raw`\b(?:${ART_WORDS})\b`, 'i');
const DIAGRAM_RE = new RegExp(String.raw`\b(?:${DIAGRAM_WORDS})\b`, 'i');
const SIM_RE = new RegExp(String.raw`\b(?:${SIM_WORDS})\b`, 'i');
/**
 * Names that mark a picture only in a title or tag: "Graphics" (in prose it is "real-time graphics" in a training
 * lab) and "mission profile" (in prose a flight can "fly a mission profile").
 */
const GRAPHIC_RE = /\bgraphics?\b|\bmission\s+profiles?\b/i;
/** Categories that file the item itself as art: "Art from NASA", "Space art", "1834 paintings from Russia". */
const ART_CATEGORY = /^art\b|\bart (?:from|by|of)\b|\bpaintings\b/i;
/**
 * Explicit phrases that count anywhere in a description, not only at its start ("... This illustration is of ...",
 * "This video illustrates what that collision might look like").
 */
const ART_ANYWHERE = new RegExp(String.raw`\b${ARTIST}\s+(?:concept|conception|impression|rendering|illustration|depiction|interpretation|drawing)s?\b|\bcomputer[\s-]generated\b|\bCGI\b|\b(?:illustration|animation|rendering)\s+credits?\s*:|\bth(?:is|ese)\s+(?:[\w'’-]+\s+){0,2}?(?:illustrations?|(?<!colou?r(?:-coded)?\s)renderings?|artworks?)\b|\b(?:illustrates?|shows?|depicts?|portrays?|imagines?|envisions?)\s+(?:how|what)\s+(?:[\w'’-]+\s+){0,6}?(?:might|could|would|may)\s+(?:have\s+)?(?:look|looked|appear|appeared)\b`, 'i');
/** A sentence that starts by naming the picture: "... run out of fuel. Illustration depicting the Kepler spacecraft". */
const ART_SENTENCE = /(?:^|[.!?:]\s+)(?:Illustration|Artist(?:['’?]?s)?\s+(?:concept|impression|illustration|rendering)|Rendering)\s+(?:of|depicting|showing)\b/;
const DIAGRAM_ANYWHERE = /\bth(?:is|ese)\s+(?:[\w'’-]+\s+){0,2}?(?:infographics?|diagrams?|charts?|graphics?|visuali[sz]ations?)\b/i;
const ANIM_ANYWHERE = /\bth(?:is|ese)\s+(?:[\w'’-]+\s+){0,2}?animations?\b/i;
/** A sentence that starts with the animation: "Animation of the Zhurong rover landing.", "An animated view of ...". */
const ANIM_LEAD = /(?:^|[.!?:]\s+)(?:(?:an?|the)\s+)?(?:[\w'’-]+\s+){0,2}?(?:animations?\s+(?:of|shows?|showing|depicts?|depicting|illustrat\w+|portray\w*)|animated\s+(?:views?|depictions?|renderings?|sequences?))\b/i;
/** "This animation depicts ...", "This simulation shows ...": the item says what it is, whatever else it mentions. */
const ANIM_SELF = /\bth(?:is|ese)\s+(?:[\w'’-]+\s+){0,2}?animations?\s+(?:depicts?|shows?|illustrates?|portrays?|visuali[sz]es?)\b/i;
const SIM_SELF = /\bth(?:is|ese)\s+(?:[\w'’-]+\s+){0,2}?simulations?\s+(?:depicts?|shows?|illustrates?|reveals?|visuali[sz]es?)\b/i;
/**
 * "taken by Curiosity", "images captured by Hubble", "time-lapse", "maps ... made from observations": the pictures
 * are real, so "animation" is a slideshow or a globe wrapped in real images.
 */
const PHOTO_CUE = /\b(?:taken|obtained|acquired|returned|recorded|photographed|imaged|observed)\b|\bcaptured\s+(?:by|with|in\s+this|this\s+image)\b|\bseen\s+by\b|\btime[\s-]?lapse\b|\b(?:photos?|photographs?)\s+(?:of|from|by)\b|\b(?:made|created|assembled|compiled|composed|produced)\s+(?:entirely\s+)?from\s+(?:[\w'’-]+\s+){0,4}?(?:images|photos|photographs|frames|observations|maps|mosaics)\b|\b(?:images|photos|photographs|frames|observations|maps)\s+(?:were|was)\s+used\s+to\s+(?:create|make|produce|build)\b/i;
/** A self-described animation is still a slideshow of real frames when that same sentence says so. */
const FRAMES = /\b(?:images?|frames?|photos?|photographs?|footage)\b/i;
/**
 * Commons categories of photographs ("Photos by the Perseverance rover Mastcams", "Photographs by Bill Ingalls",
 * "Taken with Hasselblad 500EL"). Not the date categories "Photographs taken on 2024-07-25" and "<Country>
 * photographs taken on ...": Commons adds those from a file's date, to posters and graphics too.
 */
const PHOTO_CATEGORY = /^(?:photos?|photographs?)\b(?!\s+taken\s+on\b)|\b(?:photos?|photographs?)\s+(?:by|of|taken\s+(?:by|with|from|in)\b)|\btaken with\b/i;
/** Artist or creator fields of animations and visualizations: "Adriana Manrique Gutierrez (Visualizations)". */
const ART_CREATOR = /\(visuali[sz]ations?\)|\banimators?\b|\banimation\s*:|\bconceptual image lab\b/i;
/** "Simulation" in a title or keyword is a computed picture, unless it is crew training in a simulator. */
const SIMULATION = /\bsimulat(?:ion|ions|ed)\b/i;
/**
 * Crew training, launch-team rehearsals and analog missions (HERA, HI-SEAS, CHAPEA: their records say "analog",
 * "habitat", "crew"): "simulation" there is people practising, photographed.
 */
const TRAINING = /\b(?:astronauts?|cosmonauts?|crews?|training|trainers?|simulators?|EVA|spacewalks?|exercises?|rehears\w*|drills?|participat\w*|mock-?ups?|recovery|countdown|firing room|launch\s+teams?|pilots?|analog(?:ue)?s?|habitats?|HI[\s-]?SEAS|CHAPEA)\b/i;
/** Categories about where a file was used ("Illustrations used in Salute, Jonathan!"), not about what it is. */
const USAGE_CATEGORY = /\bused (?:in|on|by)\b/i;
/**
 * A poster as the item itself: "Commercial Crew Poster.", "Crew-5 poster with mission patch", a "Posters" category,
 * "This is a printable poster with ...". Not "Expedition 27 Crew with HTV2 Poster" (people with a poster).
 */
const POSTER = /\bposters?\b(?!\s+sessions?)/i;
const POSTER_WITH = /\bwith\s+(?:[\w'’-]+\s+){0,3}?posters?\b/i;
const POSTER_SELF = /\b(?:this|a|an|the)\s+(?:is\s+(?:a|an|the)\s+)?(?:[\w'’-]+\s+){0,3}?posters?\s+(?:depicts?|depicting|shows?|showing|highlights?|features?|featuring|celebrates?|commemorates?|for|of|with)\b/i;
/** People with a poster ("pictured with", "sign posters", "pose with"): a photograph of a poster, not the poster. */
const PEOPLE_CUE = /\b(?:pictured|pos(?:e|es|ed|ing)\s+(?:with|for|beside|next)|stand(?:s|ing)?\s+(?:before|beside|next\s+to|in\s+front\s+of)|sign(?:s|ed|ing)?|hold(?:s|ing)?|held|with\s+the\s+crew|unveil\w*|(?:present|display)(?:s|ed|ing)?\s+(?:a|the|their|his|her)\s+(?:[\w'’-]+\s+)?posters?)\b/i;
/**
 * A person holding, showing or standing by a made picture: "An engineer holds a rendering of ...", "Smith, lead
 * engineer, shows a CAD rendering of ...", "... stand before a painting of a Saturn V". The photograph is of them.
 */
const PERSON_WITH = new RegExp(String.raw`\b(?:shows?|showing|holds?|holding|held|displays?|displaying|presents?|presenting|points?\s+(?:to|at)|pointing\s+(?:to|at)|looks?\s+at|looking\s+at|views?|viewing|examines?|examining|reviews?|reviewing|signs?|signing|signed|(?:stands?|standing|pos(?:e|es|ed|ing))\s+(?:before|beside|by|next\s+to|in\s+front\s+of|with))\s+(?:an?|the|his|her|their|its)\s+(?:[\w'’-]+\s+){0,3}?(?:${ART_WORDS})\b`, 'i');
/** A subject that is the picture itself, so the sentence describes it: "This image shows an artist's rendering". */
const PICTURE_NOUN = /\b(?:th(?:is|ese)|images?|pictures?|photos?|graphics?|illustrations?|frames?|views?|videos?|animations?|movies?|figures?|concepts?|renderings?|impressions?|artworks?|posters?|maps?|diagrams?|infographics?|visuali[sz]ations?)\b/i;
/** NASA ids of photographs: KSC-20230322-PH-..., iss027e007888, S69-19983, AS11-40-5903 (not jsc...e..., which
 * numbers graphics as well). */
const PHOTO_ID = /-PH-|^iss\d{3}e\d|^S\d{2,3}-|^AS\d{2}-/i;
/** Web addresses, whose words ("…/details.cgi?…", "…/nasa-visualization-shows-…") say nothing about the picture. */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)+\/\S*/gi;
const noUrls = (s: string) => s.replace(URL_RE, ' ');

/** The text without the sentences in which a made picture is something a person holds, shows or stands by. */
function withoutArtInHand(s: string): string {
  return s.split(/(?<=[.!?])\s+/).filter((x) => {
    const m = PERSON_WITH.exec(x);
    return !m || PICTURE_NOUN.test(x.slice(0, m.index));
  }).join(' ');
}

type ArtKind = 'art' | 'diagram';

/**
 * Whether a library item is artwork ('art': illustration, rendering, CGI, animation, painting, poster; 'diagram':
 * infographic, chart, simulation, visualization) or, as null, a photograph or real footage. `creators` is the Artist
 * and Credit fields (Commons) or the creator fields (NASA); `id` the library's id, which for NASA tells photographs.
 */
function artworkKind(o: { title: string; description: string; tags: string[]; photoTags?: boolean; creators?: string; id?: string }): ArtKind | null {
  const title = noUrls(o.title);
  const d = noUrls(o.description);
  // The subject of the first words: "This illustration depicts ...", "SLS launch rendering showing ...". Art named
  // as something a person holds or stands by is left out: the picture is a photograph of that person.
  const head = [title, d.slice(0, 200)];
  const artText = withoutArtInHand(d);
  const artHead = [title, artText.slice(0, 200)];
  const tags = o.tags.filter((t) => !USAGE_CATEGORY.test(t));
  // Tags alone (a keyword, a category) give way to a photo cue: "Aldrin photographed this bootprint".
  const photo = !!o.photoTags || PHOTO_CUE.test(d);
  const tagged = (re: RegExp) => !photo && tags.some((t) => re.test(t));
  // Simulations and graphics in a training or analog-mission item are people practising: the Apollo Mission
  // Simulator, a launch team rehearsing in the Firing Room, an analog habitat. Checked over everything the item says.
  const all = [title, d, ...tags].join(' \n ');
  const training = TRAINING.test(all) && !SIM_SELF.test(d);
  const diagramIn = (s: string) => DIAGRAM_RE.test(s) || (!training && SIM_RE.test(s));
  const graphic = !training && [title, ...tags].some((s) => GRAPHIC_RE.test(s));
  const simulated = !training && [title, ...tags].some((s) => SIMULATION.test(s));
  // "This animation depicts the motion of ..." outweighs an "observed" elsewhere; not "This animation shows images
  // taken by the rover". A title marked "(Animation)" counts the same unless its opening words speak of real frames.
  const animSelf = d.split(/(?<=[.!?])\s+/).some((s) => ANIM_SELF.test(s) && !PHOTO_CUE.test(s) && !FRAMES.test(s))
    || (/\(animation\)/i.test(title) && !head.some((s) => PHOTO_CUE.test(s) || FRAMES.test(s)));
  // A poster counts when the item is the poster, not people signing or posing with one.
  const poster = ((POSTER.test(title) && !POSTER_WITH.test(title)) || POSTER_SELF.test(d.slice(0, 200)) || tags.some((t) => POSTER.test(t)))
    && !photo && !PEOPLE_CUE.test(`${title} ${d}`) && !PHOTO_ID.test(o.id ?? '');
  // An infographic that a category also files under "Illustrations of ..." is still an infographic.
  if (head.some(diagramIn) && !artHead.some((s) => ART_RE.test(s))) return 'diagram';
  // Commons categories such as "Art from NASA" or "Space art" name the art itself.
  if (artHead.some((s) => ART_RE.test(s)) || ART_ANYWHERE.test(artText) || ART_SENTENCE.test(artText) || tagged(ART_RE) || tagged(ART_CATEGORY)) return 'art';
  if (poster || animSelf || (!photo && ART_CREATOR.test(noUrls(o.creators ?? '')))) return 'art';
  if (DIAGRAM_ANYWHERE.test(d) || tags.some((t) => !photo && (diagramIn(t) || CHART_RE.test(t))) || graphic || simulated) return 'diagram';
  if ((ANIM_RE.test(title) || ANIM_LEAD.test(d) || ANIM_ANYWHERE.test(d) || tags.some((t) => ANIM_RE.test(t))) && !photo) return 'art';
  return null;
}

/** The credit for artwork: '艺术想象图（NASA/JPL-Caltech）', '艺术想象动画（…）' for videos, '示意图（…）' for diagrams. */
function artworkCredit(kind: ArtKind, media: 'image' | 'video', who: string): string {
  const label = kind === 'art' ? (media === 'video' ? '艺术想象动画' : '艺术想象图') : (media === 'video' ? '示意动画' : '示意图');
  return `${label}（${who}）`;
}

// ---------------------------------------------------------------------------------------------------------------
// NASA Image and Video Library

interface NasaData {
  nasa_id?: string; title?: string; description?: string; center?: string; media_type?: string;
  photographer?: string; secondary_creator?: string; keywords?: unknown;
}
interface NasaItem { data?: NasaData[]; links?: Array<{ href?: string; rel?: string; render?: string }> }
interface NasaSearch { collection?: { items?: NasaItem[] } }

const NASA_CENTERS: Record<string, string> = {
  JPL: 'NASA/JPL-Caltech', GSFC: 'NASA/Goddard', HQ: 'NASA', JSC: 'NASA/JSC', MSFC: 'NASA/MSFC', KSC: 'NASA/KSC',
  ARC: 'NASA/Ames', LRC: 'NASA/Langley', LARC: 'NASA/Langley', AFRC: 'NASA/Armstrong', GRC: 'NASA/Glenn', SSC: 'NASA/Stennis',
};
// A copyright or courtesy notice anywhere in the record: the item is not NASA's to give away.
const THIRD_PARTY = /©|copyright|courtesy/i;
// Rights holders whose pictures sit in NASA's library without being NASA works: companies, partner agencies,
// news agencies, universities. Acronyms are matched case-sensitively so "AP" does not hit "map" or "apogee".
const OUTSIDE_ORG = new RegExp(`\\b(${[
  'SpaceX', 'Boeing', 'Blue Origin', 'Axiom', 'Toyota', 'Roscosmos', 'Lockheed', 'Northrop', 'Sierra', 'Getty',
  'Reuters', 'Univ\\w*', 'College', 'Firefly', 'Intuitive Machines', 'Astrobotic', 'Rocket Lab', 'United Launch Alliance',
  'Airbus', 'Thales', 'Bigelow', 'Maxar', 'Aerojet', 'Orbital ATK', 'Raytheon', 'Honeywell', 'Max Planck', 'Virgin', 'Agency',
].join('|')})\\b`, 'i');
const OUTSIDE_ACRONYM = /\b(AP|AFP|CSA|JAXA|DLR|CNES|ESO|ISRO|CNSA|ULA|UKSA|ASI|KARI|GCTC|RSC)\b/;
// Words that make a creator string an organization rather than a NASA staff photographer's name.
const ORG_WORD = /\b(Inc|Corp|Corporation|LLC|Ltd|Co|Company|Aerospace|Space|Spaceflight|Agency|Lab|Labs|Laboratory|Laboratories|Medialab|Team|Center|Centre|Office|Program|Programme|Wing|Force|Army|Navy|Telescope|Observatory|Technologies|Technology|Systems|Industries|Media|News|Press|Images|Photos?|Studios?|Museum|Foundation|Society|Group|School|Academy|Administration|Department|Dept|Ministry|Government|Network|Station|Mission|Project|Consortium|Association|Council|Services|Launch|Rocket|Satellite|Science|Image|Video|Animation)\b/i;
const NAME_WORD = /^(?:\p{Lu}[\p{L}'’-]*\.?|\p{Lu}\.(?:\p{Lu}\.)*|de|da|di|del|van|von|der|den|la|le|du|bin|al)$/u;

// ESA missions and partners other than Hubble and Webb: their pictures are CC BY-SA or ESA-only, not CC BY 4.0.
const ESA_OTHER_MISSION = /\b(Herschel|Planck|Rosetta|Philae|Gaia|XMM|Integral|SOHO|Cluster|Huygens|Mars Express|Venus Express|Solar Orbiter|BepiColombo|Juice|ExoMars|Euclid|OSIRIS|NAVCAM|DLR|FU[\s-]?Berlin|Airbus|ATG)\b/i;
// "Credit:", "Image credits:", "Credit for Hubble Image:", "Hubble image cred:".
const CREDIT_LABEL = String.raw`(?:(?:image|photo|video|animation|illustration|graphic)s?\s+)?cred(?:it)?s?(?:\s+for\s+[^:.]{1,30})?\s*:`;
const JHU_APL = /JHU[\s/-]*APL|Johns Hopkins (University )?(Applied Physics Laboratory|Applied Physics Lab|Applied Physics|APL)/i;

/** Credit strings in one spelling: agencies by acronym, JHU-APL as one token, no labels or trailing prose. */
function normHolder(s: string): string {
  return untilUnmatchedParen(s.replace(/^[\s([]+/, ''))
    .replace(/\s*\((the )?(European Space Agency|National Aeronautics and Space Administration)\)/gi, '')
    .replace(/National\s*Aeronautics\s*and\s*Space\s*Administration/gi, 'NASA')
    .replace(/(the )?European\s*Space\s*Agency/gi, 'ESA')
    .replace(/\bNASA or NASA\b/g, 'NASA')
    .replace(new RegExp(JHU_APL.source, 'gi'), 'JHU-APL')
    // Leading labels: "Credit: Image credit: ...", "Acknowledgement: Judy Schmidt", "HST image: NASA/ESA/...".
    .replace(/^(?:[\p{L}\s-]{1,25}:\s*)+/u, '')
    // What follows the credit in a flattened description: another credit, the usage-policy link, "To learn more".
    .replace(new RegExp(String.raw`\s+${CREDIT_LABEL}.*$|\s*NASA image use policy.*$|\s+(?:To (?:learn|read)|Read more|Learn more|For more|More info)\b.*$|\s+#\S.*$`, 'i'), '')
    .replace(/[\s\].,:;]+$/, '')
    .trim();
}

/** `s` up to its first unmatched ')' (where a credit phrase written inside parentheses ends). */
function untilUnmatchedParen(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth < 0) return s.slice(0, i);
  }
  return s;
}

/** "Bill Ingalls", "AUSTIN LOWERY", "Joy Ng, Sarah L. Jones and Kathalina Tran": NASA staff, not an organization. */
function personalNames(s: string): boolean {
  if (/\//.test(s) || ORG_WORD.test(s)) return false;
  const names = s.split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean);
  return names.length > 0 && names.every((n) => {
    const words = n.split(/\s+/);
    // A lone all-caps word ("GCTC") is an acronym, not a person; "AUSTIN LOWERY" is a person.
    const lone = words.length === 1 && !/\p{Ll}/u.test(n);
    return !lone && words.length <= 5 && words.every((w) => NAME_WORD.test(w)) && words.some((w) => /\p{L}{2}/u.test(w));
  });
}

/**
 * Who a NASA record says holds the rights: the photographer and secondary_creator fields and every
 * credit line in the title or description ("Image credit: ...", or a bare "ESA/..." credit), split at ';'.
 */
function nasaHolders(d: NasaData, title: string, description: string): string[] {
  const out = [plain(d.photographer), plain(d.secondary_creator)];
  const text = `${title} ${description}`;
  // Credit lines: after a label, or a bare "ESA/Hubble & NASA, ..." / "ESA/Rosetta/NAVCAM" with no label at all.
  const lines = [
    ...[...text.matchAll(new RegExp(String.raw`\b${CREDIT_LABEL}\s*([^|\]]{1,160})`, 'gi'))].map((m) => m[1]!),
    ...[...text.matchAll(/(?<![\w/])((?:NASA\s*[,/&]\s*)?ESA\s*\/\s*[\w-][^|\]]{0,120})/g)].map((m) => m[1]!),
  ];
  // Each up to the end of its sentence; a period after a lone capital is an initial ("M. Werner"), not an end.
  for (const l of lines) out.push(untilUnmatchedParen(l.split(/(?<!(?:^|[\s.(/])\p{Lu})\.(?:\s|$)/u)[0]!));
  return out
    .flatMap((s) => s.split(/\s*;\s*/))
    .map(normHolder)
    .filter((s) => s && !/^(n\/?a|none|unknown|not applicable)$/i.test(s));
}

/** 'nasa' for NASA itself or its staff, 'esa' for an ESA credit, 'outside' for any other organization. */
function holderKind(h: string): 'nasa' | 'esa' | 'outside' {
  if (/\bESA\b/.test(h)) return 'esa';
  if (OUTSIDE_ORG.test(h) || OUTSIDE_ACRONYM.test(h)) return 'outside';
  if (/^(NASA|JPL)(?![A-Za-z])/.test(h.split('/')[0]!.trim())) return 'nasa'; // JPL is a NASA centre
  return personalNames(h) ? 'nasa' : 'outside';
}

function nasaCandidate(item: NasaItem): FootageCandidate | null {
  const d = item.data?.[0];
  if (!d?.nasa_id || (d.media_type !== 'image' && d.media_type !== 'video')) return null;
  const title = plain(d.title) || d.nasa_id;
  const description = plain(d.description);
  const creators = [d.photographer, d.secondary_creator].map(plain).join(' ');
  if (THIRD_PARTY.test(`${title} ${description} ${creators}`)) return null;
  // NASA hosts company, partner-agency and university pictures next to its own; only NASA's are public domain.
  const holders = nasaHolders(d, title, description);
  const kinds = holders.map(holderKind);
  if (kinds.includes('outside')) return null;
  // ESA/Hubble and ESA/Webb pictures are CC BY 4.0 and must carry ESA's credit line. Other ESA missions
  // (Rosetta OSIRIS/NAVCAM, Mars Express ...) use varying CC BY-SA terms: leave those to their Commons copies.
  const esa = holders.find((_, i) => kinds[i] === 'esa');
  if (esa && (!/\b(Hubble|Webb|JWST|HST)\b/i.test(`${esa} ${title}`) || ESA_OTHER_MISSION.test(esa))) return null;
  const link = item.links?.find((l) => l.render === 'image') ?? item.links?.[0];
  const thumb = link?.href ? cleanUrl(link.href) : '';
  if (!thumb) return null;
  const sourceCredit = esa
    ? shortCredit(esa)
    : holders.some((h) => h.includes('JHU-APL')) || JHU_APL.test(description)
      ? 'NASA/JHU-APL'
      : NASA_CENTERS[(d.center ?? '').toUpperCase()] ?? 'NASA';
  const keywords = (Array.isArray(d.keywords) ? d.keywords : typeof d.keywords === 'string' ? d.keywords.split(/[,;]/) : [])
    .map(plain).filter(Boolean);
  const art = artworkKind({ title, description, tags: keywords, creators, id: d.nasa_id });
  return {
    id: `nasa:${d.nasa_id}`,
    source: 'nasa',
    kind: d.media_type,
    title: clip(title, 120),
    description: clip(description, 200),
    thumb,
    pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
    license: esa ? 'CC BY 4.0' : 'Public domain (NASA)',
    credit: art ? artworkCredit(art, d.media_type, sourceCredit) : sourceCredit,
    needsAttribution: !!esa,
    artwork: !!art,
    ...(art ? { sourceCredit } : {}),
  };
}

async function searchNasa(query: string, kind: 'image' | 'video' | 'any'): Promise<FootageCandidate[]> {
  const mediaType = kind === 'any' ? 'image,video' : kind;
  const deadline = Date.now() + SEARCH_TIMEOUT;
  const run = async (q: string) => {
    const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=${mediaType}&page_size=60`;
    const j = await getJson<NasaSearch>(url, Math.max(3000, deadline - Date.now()), SOURCE_NAME.nasa);
    const items = j.collection?.items ?? [];
    for (const it of items) { const id = it.data?.[0]?.nasa_id; if (id) rememberNasa(id, it); }
    return items.map(nasaCandidate).filter((c): c is FootageCandidate => c !== null);
  };
  const found = await run(query);
  // NASA matches every word, so "ISS earth timelapse" finds nothing; with few hits, also try each query that
  // leaves one word out and mix those results in after the exact ones.
  const words = query.split(' ');
  if (found.length >= 6 || words.length < 2 || words.length > 6) return found;
  const relaxed = await Promise.allSettled(words.map((_, i) => run(words.filter((__, j) => j !== i).join(' '))));
  const lists = relaxed.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const ids = new Set(found.map((c) => c.id));
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const l of lists) {
      const c = l[i];
      if (c && !ids.has(c.id)) {
        ids.add(c.id);
        found.push(c);
      }
    }
  }
  return found;
}

/** NASA records from recent searches, by id (bounded). */
const nasaSeen = new Map<string, NasaItem>();
function rememberNasa(id: string, item: NasaItem) {
  nasaSeen.delete(id);
  nasaSeen.set(id, item);
  if (nasaSeen.size > 500) nasaSeen.delete(nasaSeen.keys().next().value!);
}

/**
 * The record of one NASA item, without its files. `ms` is the time each request may take: SEARCH_TIMEOUT when
 * fetching, less when only relabelling (refreshManifestArtwork). A lookup that fails throws.
 */
async function lookupNasa(nasaId: string, ms = SEARCH_TIMEOUT): Promise<FootageCandidate> {
  const who = SOURCE_NAME.nasa;
  // Records seen in a search are reused: the search-by-id endpoint answers 400 for ids with an apostrophe,
  // and several NASA ids have one. Otherwise look it up by id, or by its words (punctuation removed).
  let item = nasaSeen.get(nasaId);
  let failed: unknown = null;
  if (!item) {
    const byId = await getJson<NasaSearch>(`https://images-api.nasa.gov/search?nasa_id=${encodeURIComponent(nasaId)}`, ms, who).catch(() => null);
    item = (byId?.collection?.items ?? []).find((i) => i.data?.[0]?.nasa_id === nasaId);
  }
  if (!item) {
    const words = nasaId.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const byWords = await getJson<NasaSearch>(`https://images-api.nasa.gov/search?q=${encodeURIComponent(words)}&page_size=100`, ms, who).catch((e) => { failed = e; return null; });
    item = (byWords?.collection?.items ?? []).find((i) => i.data?.[0]?.nasa_id === nasaId);
  }
  // Not found only when the last lookup answered; a lookup that could not connect says so.
  if (!item) throw failed instanceof Error ? failed : new Error(`NASA 素材库里找不到 ${nasaId}`);
  const cand = nasaCandidate(item);
  if (!cand) throw new Error(`NASA 素材 ${nasaId} 的版权属于 NASA 以外的机构（公司、合作航天机构或大学），或不是图片/视频，不能使用`);
  return cand;
}

/** The record and the downloadable renditions of one NASA item, best first. */
async function resolveNasa(nasaId: string): Promise<{ cand: FootageCandidate; urls: string[] }> {
  const who = SOURCE_NAME.nasa;
  const cand = await lookupNasa(nasaId);
  const asset = await getJson<{ collection?: { items?: Array<{ href?: string }> } }>(
    `https://images-api.nasa.gov/asset/${encodeURIComponent(nasaId)}`, SEARCH_TIMEOUT, who);
  const hrefs = [...new Set((asset.collection?.items ?? []).map((i) => i.href ?? '').filter(Boolean))];
  // ~mobile.mp4 is 320x180 at 15 fps, too small for a 1080p frame, so it only comes after the sharper ones.
  const order = cand.kind === 'image'
    ? [/~large\.jpe?g$/i, /~medium\.jpe?g$/i, /~orig\.(jpe?g|png)$/i, /~small\.jpe?g$/i]
    : [/~medium\.mp4$/i, /~small\.mp4$/i, /~large\.mp4$/i, /~mobile\.mp4$/i, /~orig\.mp4$/i, /\.(mp4|m4v|mov)$/i];
  const urls = [...new Set(order.flatMap((re) => hrefs.filter((h) => re.test(h)).map(cleanUrl)))].filter(Boolean);
  if (!urls.length) throw new Error(`NASA 素材 ${nasaId} 没有可下载的${cand.kind === 'image' ? '图片' : '视频'}文件`);
  return { cand, urls };
}

// ---------------------------------------------------------------------------------------------------------------
// Wikimedia Commons

interface CommonsInfo {
  url?: string; descriptionurl?: string; thumburl?: string; mime?: string; size?: number;
  width?: number; height?: number; duration?: number;
  extmetadata?: Record<string, { value?: unknown }>;
}
interface CommonsPage { title?: string; index?: number; missing?: boolean; imageinfo?: CommonsInfo[] }
interface CommonsQuery { query?: { pages?: CommonsPage[] }; error?: { info?: string } }

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
/** Commons files that are screenshots of broadcasts, or whose own page doubts their copyright information. */
const DOUBTFUL = /screenshot|screen ?cap|tagesschau|broadcast|fernseh|urheberrecht|falsche|copyright violation|possibly unfree/i;

const EXTMETA = 'LicenseShortName|Artist|Credit|ImageDescription|ObjectName|NonFree|Categories';

/** Commons' LicenseShortName in short form, or null when the licence does not allow reuse in an edited video. */
function commonsLicense(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\b(nc|nd)\b|fair[\s-]?use|non-?free/i.test(s)) return null;
  if (/public domain|^pd\b|^pd-/i.test(s)) return 'Public domain';
  if (/\bcc0\b|cc-zero/i.test(s)) return 'CC0';
  const m = s.match(/\bcc[-\s]by(?:[-\s](sa))?[-\s]?(\d(?:\.\d)?)(?:[-\s]([a-z]{2,3})\b)?/i);
  if (m) return `CC BY${m[1] ? '-SA' : ''} ${m[2]}${m[3] ? ` ${m[3].toUpperCase()}` : ''}`;
  return null; // GFDL-only, "Attribution", unknown ...
}

/**
 * How long the maker's name in a Commons credit may be. One budget for the labelled and the plain form, so an
 * artwork credit names the same holder as its sourceCredit: '艺术想象动画（<52>） / Wikimedia Commons' fits in 80.
 */
const COMMONS_WHO_MAX = 52;

/** Who made a Commons file, short ('' when unknown); `n` caps its length. */
function commonsWho(meta: Record<string, { value?: unknown }>, n: number): string {
  const artist = plain(meta.Artist?.value)
    .replace(/\s*\b(acknowledge?ment|uploaded by)\b.*$/i, '')
    // "from <place>; Authors of the study: A, B, ..." -> "A, B, ...": drop clauses that are not names, then labels.
    .split(/;\s*/).filter((part, _, all) => all.length < 2 || !/^\p{Ll}/u.test(part)).join('; ')
    .replace(/^[^:,;]{1,30}:\s*/, '')
    // "Artwork NASA, ESA, CSA, L. Hustak", "Illustration NASA, ..." (a label without its colon), "/Hubble, ...".
    .replace(/^(?:[Aa]rtwork|[Ii]llustration|[Aa]nimation|[Rr]endering)s?\s+(?:by\s+)?(?=\p{Lu})/u, '')
    .replace(/^[\s/,;]+/, '')
    .replace(/[,;]?\s*\bCC[\s-]BY\b.*$/i, '')
    .replace(/National\s*Aeronautics\s*and\s*Space\s*Administration/gi, 'NASA')
    .replace(/(the )?European\s*Space\s*Agency/gi, 'ESA')
    .replace(/[\s;,.]+$/, '')
    .trim();
  const credit = plain(meta.Credit?.value);
  // A web address is no name: "https://www.nasa.gov/marshall/" (seen here as "www.nasa.gov/marshall/" once the
  // "https:" label is gone).
  const unknown = (s: string) => !s || /^(unknown|own work|anonymous)\b/i.test(s) || /^(?:https?:\/\/|www\.|[\w-]+(?:\.[\w-]+)+\/)/i.test(s);
  const who = !unknown(artist) ? artist : !unknown(credit) ? credit : '';
  if (!who) return '';
  const short = shortCredit(who, n);
  return /\bESA\b/.test(who) && !/\bESA\b/.test(short) ? shortCredit(`ESA, ${who}`, n) : short;
}

/**
 * The credit line for a Commons file: '<Artist> / Wikimedia Commons'. Artwork is labelled inside, before the
 * ' / Wikimedia Commons' tail that the corner label drops: '艺术想象图（NASA/JPL-Caltech） / Wikimedia Commons'.
 */
function commonsCredit(meta: Record<string, { value?: unknown }>, art: ArtKind | null, media: 'image' | 'video'): string {
  const who = commonsWho(meta, COMMONS_WHO_MAX);
  if (!art) return who ? `${who} / Wikimedia Commons` : 'Wikimedia Commons';
  return who ? `${artworkCredit(art, media, who)} / Wikimedia Commons` : artworkCredit(art, media, 'Wikimedia Commons');
}

function commonsCandidate(p: CommonsPage): FootageCandidate | null {
  const ii = p.imageinfo?.[0];
  if (!p.title || !ii) return null;
  const mime = (ii.mime ?? '').toLowerCase();
  const kind = IMAGE_MIMES.has(mime) ? 'image' : VIDEO_MIMES.has(mime) ? 'video' : null;
  if (!kind) return null;
  const meta = ii.extmetadata ?? {};
  if (/^true$/i.test(plain(meta.NonFree?.value))) return null;
  const license = commonsLicense(plain(meta.LicenseShortName?.value));
  const thumb = ii.thumburl ? cleanUrl(ii.thumburl) : '';
  if (!license || !thumb) return null;
  // Screenshots of broadcasts and files flagged for wrong copyright information carry rights the licence
  // tag does not cover.
  if (DOUBTFUL.test(`${p.title} ${plain(meta.ImageDescription?.value)} ${plain(meta.Credit?.value)}`)) return null;
  const fileName = p.title.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
  // Categories arrive as one '|'-separated string, without the "Category:" prefix.
  const categories = plain(meta.Categories?.value).split('|').map((c) => c.trim()).filter(Boolean);
  const art = artworkKind({
    title: `${fileName} ${plain(meta.ObjectName?.value)}`,
    description: plain(meta.ImageDescription?.value),
    tags: categories,
    photoTags: categories.some((c) => PHOTO_CATEGORY.test(c)),
    creators: `${plain(meta.Artist?.value)} ${plain(meta.Credit?.value)}`,
  });
  return {
    id: `commons:${p.title}`,
    source: 'commons',
    kind,
    title: clip(plain(meta.ObjectName?.value) || fileName, 120),
    description: clip(plain(meta.ImageDescription?.value), 200),
    thumb,
    pageUrl: (ii.descriptionurl && cleanUrl(ii.descriptionurl)) || `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
    license,
    credit: commonsCredit(meta, art, kind),
    needsAttribution: license.startsWith('CC BY'),
    artwork: !!art,
    ...(art ? { sourceCredit: commonsCredit(meta, null, kind) } : {}),
    ...(ii.width ? { width: ii.width } : {}),
    ...(ii.height ? { height: ii.height } : {}),
    ...(kind === 'video' && ii.duration ? { duration: Math.round(ii.duration * 10) / 10 } : {}),
  };
}

const commonsUrl = (params: Record<string, string>) =>
  `${COMMONS_API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params })}`;

async function searchCommons(query: string, kind: 'image' | 'video' | 'any'): Promise<FootageCandidate[]> {
  const filter = kind === 'image' ? 'filetype:bitmap' : kind === 'video' ? 'filetype:video' : '-filetype:drawing -filetype:audio -filetype:office';
  const j = await getJson<CommonsQuery>(commonsUrl({
    generator: 'search', gsrsearch: `${query} ${filter}`, gsrnamespace: '6', gsrlimit: '40',
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size|mediatype', iiurlwidth: '320',
    iiextmetadatafilter: EXTMETA, iiextmetadatalanguage: 'en',
  }), SEARCH_TIMEOUT, SOURCE_NAME.commons);
  if (j.error) throw new Error(`${SOURCE_NAME.commons}查询出错`);
  return (j.query?.pages ?? [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(commonsCandidate)
    .filter((c): c is FootageCandidate => c !== null);
}

/** The page and record of one Commons file; `ms` as in lookupNasa. */
async function lookupCommons(title: string, ms = SEARCH_TIMEOUT): Promise<{ cand: FootageCandidate; ii: CommonsInfo }> {
  const j = await getJson<CommonsQuery>(commonsUrl({
    titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size|mediatype', iiurlwidth: '1920',
    iiextmetadatafilter: EXTMETA, iiextmetadatalanguage: 'en',
  }), ms, SOURCE_NAME.commons);
  const page = j.query?.pages?.[0];
  if (!page || page.missing || !page.imageinfo?.[0]) throw new Error(`Wikimedia Commons 上找不到 ${title}`);
  const cand = commonsCandidate(page);
  if (!cand) throw new Error(`Commons 文件 ${title} 的授权不允许使用，或格式不支持`);
  return { cand, ii: page.imageinfo[0] };
}

/** The record and the URLs to try for one Commons file, best first. */
async function resolveCommons(title: string): Promise<{ cand: FootageCandidate; urls: string[] }> {
  const who = SOURCE_NAME.commons;
  const { cand, ii } = await lookupCommons(title);
  const original = ii.url ? cleanUrl(ii.url) : '';
  const scaled = ii.thumburl ? cleanUrl(ii.thumburl) : '';
  if (cand.kind === 'image') {
    const big = (ii.size ?? 0) > IMAGE_CAP || (ii.width ?? 0) > 3000;
    return { cand, urls: (big ? [scaled, original] : [original, scaled]).filter(Boolean) };
  }
  const urls = [original];
  if ((ii.size ?? 0) > VIDEO_CAP) {
    // Too big to download whole: use Commons' own transcode of at most 720 lines instead.
    const v = await getJson<{ query?: { pages?: Array<{ videoinfo?: Array<{ derivatives?: Array<{ src?: string; type?: string; height?: number }> }> }> } }>(
      commonsUrl({ titles: title, prop: 'videoinfo', viprop: 'derivatives' }), SEARCH_TIMEOUT, who);
    const derivs = (v.query?.pages?.[0]?.videoinfo?.[0]?.derivatives ?? [])
      .filter((d) => d.src && (d.height ?? 0) <= 720 && /webm|mp4/.test(d.type ?? ''))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    urls.unshift(...derivs.map((d) => cleanUrl(d.src!)));
  }
  return { cand, urls: urls.filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------------------------
// Search

/**
 * Searches NASA and Wikimedia Commons in parallel for reusable footage (English keywords work best). Results come
 * interleaved by source, de-duplicated, and only with licences that allow reuse: public domain, CC0, CC BY,
 * CC BY-SA. A source that fails is skipped; throws only when every selected source fails.
 */
export async function searchFootage(
  query: string,
  opts: { kind?: 'image' | 'video' | 'any'; limit?: number; sources?: FootageSource[] } = {},
): Promise<FootageCandidate[]> {
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) throw new Error('素材搜索词不能为空');
  const kind = opts.kind ?? 'any';
  const limit = Math.min(12, Math.max(1, Math.round(opts.limit ?? 8)));
  const sources = [...new Set(opts.sources?.length ? opts.sources : (['nasa', 'commons'] as FootageSource[]))];
  const settled = await Promise.allSettled(sources.map((s) => (s === 'nasa' ? searchNasa(q, kind) : searchCommons(q, kind))));
  const lists: FootageCandidate[][] = [];
  const errors: string[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') lists.push(r.value.filter((c) => kind === 'any' || c.kind === kind));
    else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  if (!lists.length) throw new Error(`素材库暂时连不上（${errors.join('；')}），稍后再试`);

  const out: FootageCandidate[] = [];
  const seen = new Set<string>();
  const longest = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c || out.length >= limit) continue;
      // The same picture is often uploaded under several ids with one title (NASA photo series, Commons copies).
      const titleKey = `t:${c.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;
      if (seen.has(c.id) || (titleKey.length > 6 && seen.has(titleKey))) continue;
      seen.add(c.id);
      seen.add(titleKey);
      out.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Download and normalise

class TooLarge extends Error {
  constructor(cap: number) {
    super(`素材文件超过 ${Math.round(cap / MB)} MB 上限`);
  }
}

/** Streams `url` into `dest`, aborting once more than `cap` bytes arrive. */
async function download(url: string, dest: string, cap: number, ms: number): Promise<void> {
  let res: Response;
  try {
    res = await safeFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new Error(isTimeout(e) ? '素材下载超时' : e instanceof Error && e.message.includes('允许') ? e.message : '素材下载失败（网络错误）');
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(res.status === 429 ? '素材下载请求太频繁，稍后再试' : `素材下载失败（${res.status}）`);
  }
  if (Number(res.headers.get('content-length')) > cap) {
    await res.body.cancel().catch(() => {});
    throw new TooLarge(cap);
  }
  const fh = await open(dest, 'w');
  let n = 0;
  try {
    for await (const chunk of res.body) {
      n += chunk.byteLength;
      if (n > cap) throw new TooLarge(cap);
      await fh.write(chunk);
    }
  } catch (e) {
    if (e instanceof TooLarge) throw e;
    throw new Error(isTimeout(e) ? '素材下载超时' : '素材下载中断');
  } finally {
    await fh.close();
  }
  if (n === 0) throw new Error('素材下载失败（文件为空）');
}

/** Tries each URL in turn; a rendition that is too big or missing falls through to the next one. */
async function downloadFirst(urls: string[], dest: string, cap: number, ms: number): Promise<void> {
  let last: Error = new Error('素材没有可下载的文件');
  for (const url of urls) {
    try {
      await download(url, dest, cap, ms);
      return;
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      await rm(dest, { force: true });
      if (!(e instanceof TooLarge) && !/（(403|404|410)）/.test(last.message)) throw last;
    }
  }
  throw last;
}

function imageType(head: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

interface ProbeJson {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }>;
  format?: { duration?: string };
}

/**
 * The first video stream's size and frame rate, whether there is audio, and the duration; null when there is no
 * picture. ffprobe runs asynchronously and is killed after 30 s: a synchronous call would stall the server's event
 * loop for as long as a slow or hostile file takes to read. Only local files and pipes may be opened.
 */
function probeVideo(file: string): Promise<{ width: number; height: number; fps: number; audio: boolean; duration: number } | null> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate:format=duration',
      '-of', 'json', '-protocol_whitelist', 'file,pipe', '-i', file,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      let j: ProbeJson;
      try { j = JSON.parse(Buffer.concat(chunks).toString()) as ProbeJson; } catch { return resolve(null); }
      const s = j.streams?.find((x) => x.codec_type === 'video');
      if (code !== 0 || !s?.width || !s.height) return resolve(null);
      const rate = (r?: string) => {
        const [a, b] = (r ?? '').split('/').map(Number);
        return a && b ? a / b : 0;
      };
      resolve({
        width: s.width, height: s.height, fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate),
        audio: !!j.streams?.some((x) => x.codec_type === 'audio'), duration: Number(j.format?.duration) || 0,
      });
    });
  });
}

class TranscodeTimeout extends Error {}

/**
 * Runs ffmpeg on a downloaded file, asynchronously, killed with SIGKILL after `ms`: a hostile or broken download
 * must not keep a transcode running for ever. Rejects with the end of ffmpeg's stderr, or a TranscodeTimeout once
 * the killed process has exited (so the caller can delete its output file).
 */
function transcode(args: string[], ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, ms);
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new TranscodeTimeout(`ffmpeg killed after ${ms / 1000} s`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}

async function finishImage(src: string, assetsDir: string, stem: string): Promise<string> {
  const fh = await open(src, 'r');
  const head = Buffer.alloc(16);
  try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
  const type = imageType(head);
  if (!type) throw new Error('下载的文件不是 JPEG/PNG/WebP 图片');
  if (!(await probeVideo(src))) throw new Error('下载的图片无法解码');
  if (type === 'jpeg' || (type === 'png' && statSync(src).size <= PNG_KEEP_MAX)) {
    const name = `${stem}.${type === 'jpeg' ? 'jpg' : 'png'}`;
    await rename(src, join(assetsDir, name));
    return name;
  }
  const name = `${stem}.jpg`;
  try {
    await atomicOutput(join(assetsDir, name), (tmp) => transcode([
      '-protocol_whitelist', 'file,pipe', '-i', src, '-frames:v', '1',
      '-vf', "scale=w='min(3840,iw)':h='min(3840,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
      '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2', '-update', '1', tmp,
    ], IMAGE_TRANSCODE_MS));
  } catch (e) {
    throw new Error(e instanceof TranscodeTimeout ? '素材图片转换超时，文件可能已损坏' : '素材图片转换失败，文件可能已损坏', { cause: e });
  }
  return name;
}

async function finishVideo(src: string, assetsDir: string, stem: string, maxSeconds: number): Promise<string> {
  const v = await probeVideo(src);
  if (!v) throw new Error('下载的视频里没有画面，无法使用');
  const audio = v.audio;
  const vf = [
    "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    ...(v.fps > 30.5 || v.fps === 0 ? ['fps=30'] : []),
    'setsar=1', 'format=yuv420p',
  ].join(',');
  const name = `${stem}.mp4`;
  try {
    await atomicOutput(join(assetsDir, name), (tmp) => transcode([
      '-t', String(maxSeconds), '-protocol_whitelist', 'file,pipe', '-i', src,
      '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []),
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
      '-movflags', '+faststart', '-f', 'mp4', tmp,
    ], VIDEO_TRANSCODE_MS));
  } catch (e) {
    throw new Error(e instanceof TranscodeTimeout ? '素材视频转码超时（超过 10 分钟），换一个短一些的素材' : '素材视频转码失败，文件可能已损坏', { cause: e });
  }
  return name;
}

/** An item's record from its library, without its files (enough to label it). */
async function lookupMeta(source: FootageSource, key: string, ms = SEARCH_TIMEOUT): Promise<FootageCandidate> {
  return source === 'nasa' ? await lookupNasa(key, ms) : (await lookupCommons(key, ms)).cand;
}

/** Only footage entries come here (looked up by a footage id), never a 3D model's. */
function metaFromEntry(e: ManifestEntry): FootageCandidate {
  return {
    id: e.id, source: e.source as FootageSource, kind: e.kind as FootageCandidate['kind'], title: e.title, description: '', thumb: '', pageUrl: e.pageUrl,
    license: e.license, credit: e.credit, needsAttribution: e.needsAttribution,
    ...(e.artwork !== undefined ? { artwork: e.artwork } : {}), ...(e.sourceCredit ? { sourceCredit: e.sourceCredit } : {}),
  };
}

/**
 * Downloads one search result into `assetsDir` as ft-<source>-<hash>.<ext> (jpg/png for images, H.264/AAC mp4
 * of at most 1280 px, 30 fps and `maxSeconds` (default 60) for videos). A file already fetched for the same id
 * is reused as it is. Returns the file name inside assetsDir, its size, the video's duration, and the manifest
 * entry the caller should pass to recordManifest (with usedFor); this function does not write the manifest.
 */
export async function fetchFootage(
  id: string,
  assetsDir: string,
  opts: { maxSeconds?: number } = {},
): Promise<{ file: string; kind: 'image' | 'video'; width: number; height: number; duration?: number; entry: ManifestEntry }> {
  const m = id.match(/^(nasa|commons):(.+)$/);
  if (!m) throw new Error(`素材编号格式不对：${clip(id, 60)}（应为 nasa:… 或 commons:File:…）`);
  const source = m[1] as FootageSource;
  const key = m[2]!.trim();
  if (source === 'commons' && !/^File:/i.test(key)) throw new Error('Commons 素材编号应为 commons:File:文件名');
  const maxSeconds = Number.isFinite(opts.maxSeconds) && opts.maxSeconds! > 0 ? Math.min(opts.maxSeconds!, 600) : 60;
  const stem = `ft-${source}-${createHash('sha1').update(id).digest('hex').slice(0, 10)}`;
  await mkdir(assetsDir, { recursive: true });

  let cand: FootageCandidate;
  let file = ['mp4', 'jpg', 'png'].map((e) => `${stem}.${e}`).find((f) => existsSync(join(assetsDir, f)));
  if (file) {
    // Already here: take the licence from the project's manifest when it has it, otherwise ask the library again.
    // Entries written before artwork was detected (no artwork field) are asked again too, so an illustration
    // fetched back then is relabelled; when the library cannot be reached the old entry still serves.
    const known = readManifest(dirname(assetsDir)).find((e) => e.file === file && e.id === id);
    const resolve = () => lookupMeta(source, key);
    cand = !known ? await resolve() : known.artwork !== undefined ? metaFromEntry(known) : await resolve().catch(() => metaFromEntry(known));
  } else {
    const r = source === 'nasa' ? await resolveNasa(key) : await resolveCommons(key);
    cand = r.cand;
    const raw = join(assetsDir, `.${stem}.${randomUUID().slice(0, 8)}.part`);
    try {
      if (cand.kind === 'image') {
        await downloadFirst(r.urls, raw, IMAGE_CAP, 90_000);
        file = await finishImage(raw, assetsDir, stem);
      } else {
        await downloadFirst(r.urls, raw, VIDEO_CAP, 300_000);
        file = await finishVideo(raw, assetsDir, stem, maxSeconds);
      }
    } finally {
      await rm(raw, { force: true });
    }
  }

  const path = join(assetsDir, file);
  const kind: 'image' | 'video' = file.endsWith('.mp4') ? 'video' : 'image';
  const dims = await probeVideo(path);
  if (!dims) throw new Error(`素材文件 ${file} 无法解码`);
  const duration = kind === 'video' ? Math.round(dims.duration * 100) / 100 : undefined;
  const entry: ManifestEntry = {
    file, id, source, kind, title: cand.title, pageUrl: cand.pageUrl, license: cand.license, credit: cand.credit,
    needsAttribution: cand.needsAttribution, artwork: !!cand.artwork,
    ...(cand.artwork && cand.sourceCredit ? { sourceCredit: cand.sourceCredit } : {}),
    fetchedAt: new Date().toISOString(),
  };
  return { file, kind, width: dims.width, height: dims.height, ...(duration !== undefined ? { duration } : {}), entry };
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest

const manifestPath = (projectDir: string) => join(projectDir, 'assets_manifest.json');

/** The project's footage manifest (<projectDir>/assets_manifest.json); [] when it is missing or unreadable. */
export function readManifest(projectDir: string): ManifestEntry[] {
  try {
    const j: unknown = JSON.parse(readFileSync(manifestPath(projectDir), 'utf8'));
    if (!Array.isArray(j)) return [];
    return j.filter((e): e is ManifestEntry => !!e && typeof e === 'object' && typeof e.file === 'string' && typeof e.id === 'string');
  } catch {
    return [];
  }
}

/**
 * Adds or replaces the entry for `entry.file` in the project's manifest. usedFor lists are merged, so a file used
 * by several shots keeps every use. Written to a temp file and renamed, so a reader never sees half a file.
 */
export function recordManifest(projectDir: string, entry: ManifestEntry): void {
  const list = readManifest(projectDir);
  const i = list.findIndex((e) => e.file === entry.file);
  const usedFor = [...new Set([...(i >= 0 ? list[i]!.usedFor ?? [] : []), ...(entry.usedFor ?? [])])];
  const next: ManifestEntry = { ...entry, ...(usedFor.length ? { usedFor } : {}) };
  if (!usedFor.length) delete next.usedFor;
  if (i >= 0) list[i] = next;
  else list.push(next);
  writeManifest(projectDir, list);
}

/** Writes the whole manifest through a temp file and a rename, so a reader never sees half a file. */
function writeManifest(projectDir: string, list: ManifestEntry[]): void {
  mkdirSync(projectDir, { recursive: true });
  const file = manifestPath(projectDir);
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(list, null, 1));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`素材清单写入失败：${basename(file)}${e instanceof Error && 'code' in e ? `（${String(e.code)}）` : ''}`);
  }
}

/** How long refreshManifestArtwork may take in all, and each of its requests. */
const REFRESH_BUDGET = 8_000;
const REFRESH_REQUEST = 5_000;

/**
 * Labels the artwork in a manifest written before artwork was detected. Every entry without an `artwork` field is
 * looked up again in its library (the record only, nothing is downloaded) and gets `artwork`, `credit` and, for
 * artwork, `sourceCredit` written back, so a video assembled from an old project credits an illustration as one.
 * Entries that already have `artwork` are never asked again. Takes at most about 8 s; an entry whose library cannot
 * be reached in time stays as it was (and is tried again next time). Never throws. Returns how many entries changed.
 */
/**
 * Items already looked up by refreshManifestArtwork in this process, found or not: one that cannot be resolved
 * (gone from the library, or the library down) is not waited on again at every assembly.
 */
const refreshTried = new Set<string>();

export async function refreshManifestArtwork(projectDir: string): Promise<number> {
  try {
    const stale = readManifest(projectDir).filter((e) => e.artwork === undefined && !refreshTried.has(e.id));
    if (!stale.length) return 0;
    const deadline = Date.now() + REFRESH_BUDGET;
    const ids = [...new Set(stale.map((e) => e.id))];
    const found = new Map<string, FootageCandidate>();
    // Four at a time, so a project with many files does not hit the libraries' rate limits.
    let next = 0;
    const worker = async () => {
      while (next < ids.length && Date.now() < deadline - 500) {
        const id = ids[next++]!;
        refreshTried.add(id);
        const m = id.match(/^(nasa|commons):(.+)$/);
        if (!m) continue;
        const ms = Math.min(REFRESH_REQUEST, deadline - Date.now());
        const cand = await lookupMeta(m[1] as FootageSource, m[2]!.trim(), ms).catch(() => null);
        if (cand) found.set(id, cand);
      }
    };
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker)),
      new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
    // Lookups still running past the deadline are dropped: what they find is never written.
    const done = new Map(found);
    if (!done.size) return 0;
    // Read again just before writing, so an entry recorded meanwhile is kept.
    const list = readManifest(projectDir);
    let changed = 0;
    for (const [i, e] of list.entries()) {
      const c = done.get(e.id);
      if (e.artwork !== undefined || !c) continue;
      const { sourceCredit: _old, ...rest } = e;
      list[i] = { ...rest, artwork: !!c.artwork, credit: c.credit, ...(c.artwork && c.sourceCredit ? { sourceCredit: c.sourceCredit } : {}) };
      changed++;
    }
    if (changed) writeManifest(projectDir, list);
    return changed;
  } catch {
    return 0;
  }
}
