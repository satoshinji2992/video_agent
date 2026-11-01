// Live check of src/media/footage.ts against the real NASA and Wikimedia Commons APIs (both free and keyless): search
// results carry a usable licence, thumb and credit; downloads decode at the promised size and length and are
// reused on a second fetch; NASA items credited to companies, partner agencies or ESA never pass as NASA public
// domain; artist's concepts, renderings, paintings, animations, charts and infographics are flagged as artwork and
// credited as such while real imagery (rover selfies and frames, telescope deep fields, the EHT black hole, eclipse
// photographs, Apollo, crew training, launch simulations, analog missions, people with posters or renderings) is
// not; an old manifest is relabelled without downloading, within its time limit, and left alone when the libraries cannot be
// reached; the manifest round-trips. Everything is written under a fresh os.tmpdir() folder.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFootage, readManifest, recordManifest, refreshManifestArtwork, searchFootage, type FootageCandidate, type ManifestEntry } from '../../src/media/footage.ts';

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const ACCEPTED = /^(Public domain \(NASA\)|Public domain|CC0|CC BY(-SA)? \d(\.\d)?( [A-Z]{2,3})?)$/;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

function table(rows: FootageCandidate[]) {
  for (const r of rows) {
    console.log(`  ${cut(r.id, 46)} ${cut(r.kind, 5)} ${r.artwork ? 'art' : '   '} ${cut(r.license, 20)} ${cut(r.credit, 36)} ${cut(r.title, 40)}`);
  }
}

type Probe = { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration?: string } };
/** ffprobe of a downloaded file: async, local files only, killed after 30 s. */
function probe(file: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', '-protocol_whitelist', 'file,pipe', '-i', file], { stdio: ['ignore', 'pipe', 'inherit'] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffprobe exited ${code} on ${file}`));
      resolve(JSON.parse(Buffer.concat(out).toString()) as Probe);
    });
  });
}

/** Runs a library call again, after a pause, when the library answers "too many requests" (HTTP 429). */
async function patient<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 3 || !/请求太频繁/.test(e instanceof Error ? e.message : String(e))) throw e;
      console.log(`  (rate-limited, retrying in ${15 * (i + 1)} s)`);
      await new Promise((r) => setTimeout(r, 15_000 * (i + 1)));
    }
  }
}

const ART_CREDIT = /^(艺术想象图|艺术想象动画|示意图|示意动画)（/;
const holder = (s: string) => s.replace(/ \/ Wikimedia Commons$/, '');
/** A holder without its shortening mark: "NASA, ESA, J. Li et al." and "NASA/Johns Hopkins…" name a longer list. */
const stem = (s: string) => s.replace(/(?: et al\.|…)$/, '');
/**
 * Artwork carries its label and names the same holder as the library's credit, whole or shortened at a word, a
 * comma or a slash; real imagery carries neither.
 */
const artworkConsistent = (r: FootageCandidate) => {
  if (!r.artwork) return !ART_CREDIT.test(r.credit) && r.sourceCredit === undefined;
  const inner = holder(r.credit).match(/^[^（]+（(.*)）$/)?.[1];
  if (!ART_CREDIT.test(r.credit) || !r.sourceCredit || !inner) return false;
  const src = holder(r.sourceCredit);
  if (inner === src) return true;
  const shortened = inner !== stem(inner) || src !== stem(src);
  return shortened && (stem(src).startsWith(stem(inner)) || stem(inner).startsWith(stem(src)));
};

const dir = await mkdtemp(join(tmpdir(), 'footage-check-'));
const assets = join(dir, 'assets');
try {
  // 1. Search
  const searches: Array<[string, Parameters<typeof searchFootage>[1]]> = [
    ['James Webb Space Telescope', { kind: 'any' }],
    ['Hubble galaxy', { kind: 'image', sources: ['commons'] }],
    ['ISS earth timelapse', { kind: 'video', sources: ['nasa'] }],
  ];
  const found: Record<string, FootageCandidate[]> = {};
  for (const [q, opts] of searches) {
    const t0 = performance.now();
    const rows = await patient(() => searchFootage(q, opts));
    found[q] = rows;
    console.log(`\nsearch "${q}" ${JSON.stringify(opts)}: ${rows.length} results in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    table(rows);
    check(rows.length > 0, `"${q}" returns results`);
    check(rows.length <= 8, `"${q}" respects the default limit of 8`);
    check(rows.every((r) => ACCEPTED.test(r.license)), `"${q}" every licence accepted`);
    check(rows.every((r) => /^https:\/\//.test(r.thumb)), `"${q}" every result has an https thumb`);
    check(rows.every((r) => r.credit.length > 0 && r.credit.length <= 80), `"${q}" every result has a short credit`);
    check(rows.every((r) => /^https:\/\//.test(r.pageUrl)), `"${q}" every result has a page URL`);
    check(rows.every((r) => r.needsAttribution === r.license.startsWith('CC BY')), `"${q}" needsAttribution matches licence`);
    check(new Set(rows.map((r) => r.id)).size === rows.length, `"${q}" no duplicate ids`);
    check(rows.every((r) => r.description.length <= 200 && !/[<>]/.test(r.description)), `"${q}" descriptions short plain text`);
    check(rows.every((r) => typeof r.artwork === 'boolean' && artworkConsistent(r)), `"${q}" artwork flag and credit label agree`);
    if (opts?.kind && opts.kind !== 'any') check(rows.every((r) => r.kind === opts.kind), `"${q}" all ${opts.kind}`);
    if (opts?.sources) check(rows.every((r) => opts.sources!.includes(r.source)), `"${q}" only ${opts.sources.join(',')}`);
  }
  const webb = found['James Webb Space Telescope']!;
  check(new Set(webb.map((r) => r.source)).size === 2, 'Webb search mixes both sources');
  check(webb[0]?.source !== webb[1]?.source, 'Webb results interleaved by source');
  const more = await patient(() => searchFootage('Hubble galaxy', { kind: 'image', sources: ['commons'], limit: 50 }));
  check(more.length <= 12, `limit capped at 12 (got ${more.length})`);
  const esa = await patient(() => searchFootage('ESA Hubble galaxy CC BY', { kind: 'image', sources: ['commons'], limit: 12 }));
  const esaCc = esa.filter((r) => r.needsAttribution && /ESA/.test(r.credit));
  console.log(`\nCC BY with ESA credit: ${esaCc.length ? `${esaCc[0]!.license} | ${esaCc[0]!.credit}` : 'none in this result set'}`);

  // 1b. NASA rights. The library hosts company, partner-agency and ESA pictures next to NASA's own; those must not
  // come back as 'Public domain (NASA)'. Each query is scanned raw (100 records) with a separate, simpler rule, and
  // no record it flags may appear in the search results under a public-domain label.
  console.log('\nNASA rights');
  const OUTSIDE = /SpaceX|Boeing|Blue Origin|Axiom|JAXA|Toyota|Roscosmos|Lockheed|Northrop|\bESA\b|European Space Agency/i;
  const rightsQueries: Array<[string, RegExp]> = [
    ['Blue Origin booster', /Blue Origin/], ['Boeing Starliner', /Boeing/], ['Axiom Prada spacesuit', /Axiom/],
    ['SpaceX Dragon', /SpaceX/], ['Rosetta comet 67P', /ESA/], ['Hubble ESA', /ESA/],
  ];
  for (const [q, who] of rightsQueries) {
    const raw = await (await fetch(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image,video&page_size=100`)).json() as
      { collection?: { items?: Array<{ data?: Array<{ nasa_id?: string; description?: string; photographer?: string; secondary_creator?: string }> }> } };
    const flagged = new Set((raw.collection?.items ?? []).flatMap((i) => {
      const d = i.data?.[0];
      const credits = [...(d?.description ?? '').matchAll(/credits?\s*:\s*([^.<]{0,80})/gi)].map((m) => m[1]).join(' ');
      return d?.nasa_id && OUTSIDE.test(`${d.photographer ?? ''} ${d.secondary_creator ?? ''} ${credits}`) ? [`nasa:${d.nasa_id}`] : [];
    }));
    const rows = await searchFootage(q, { sources: ['nasa'], limit: 12 });
    const leaked = rows.filter((r) => flagged.has(r.id) && r.license === 'Public domain (NASA)');
    console.log(`  "${q}": ${flagged.size} of ${raw.collection?.items?.length ?? 0} raw records name an outside holder; ${rows.length} results`);
    table(rows);
    check(leaked.length === 0, `"${q}" no outside-credited item labelled public domain${leaked.length ? ` (${leaked.map((r) => r.id).join(', ')})` : ''}`);
    check(rows.every((r) => !who.test(r.credit) || r.needsAttribution), `"${q}" no ${who.source} credit without attribution`);
    check(rows.every((r) => !/ESA/.test(r.credit) || (r.license === 'CC BY 4.0' && r.needsAttribution)), `"${q}" every ESA-credited result is CC BY 4.0 with attribution`);
  }
  const rightsDir = join(dir, 'rights-assets');
  for (const id of [
    'nasa:jaxa-pr-concept-1-credit-jaxa-toyota', 'nasa:KSC-20161017-PH_BOE01_0001', 'nasa:Blue Origin Booster',
    'nasa:axemu-prada-spacesuit-mockup-20241007-085', 'nasa:PIA21068', 'nasa:PIA18823',
  ]) {
    let msg = '';
    try { await fetchFootage(id, rightsDir); } catch (e) { msg = (e as Error).message; }
    check(/NASA 以外的机构/.test(msg), `fetch ${id} refused: ${msg || 'downloaded!'}`);
  }
  const { readdirSync: listDir } = await import('node:fs');
  check(listDir(rightsDir).length === 0, 'refused fetches left no files behind');
  const hubble = await fetchFootage('nasa:potw1903a', rightsDir);
  console.log(`  nasa:potw1903a -> ${hubble.file} | ${hubble.entry.license} | ${hubble.entry.credit}`);
  check(hubble.entry.license === 'CC BY 4.0' && hubble.entry.needsAttribution && /^ESA\/Hubble/.test(hubble.entry.credit),
    'ESA/Hubble item fetched as CC BY 4.0 with ESA/Hubble credit');

  // 1c. Artwork or real imagery, across subjects. Known items, looked up live through search: artist's concepts,
  // renderings, landing animations, simulations, diagrams and a poster are artwork; rover selfies, an orbiter frame
  // "from an animation", an animated GIF of real frames, Webb's deep field, the EHT image of M87, a person showing a
  // CAD rendering and launch-team or crew simulations are not.
  console.log('\nartwork');
  const known: Array<[string, Parameters<typeof searchFootage>[1], string, RegExp | false]> = [
    ['exoplanet artist impression', { sources: ['nasa'] }, 'nasa:PIA22082', /^艺术想象图（NASA\/JPL-Caltech）$/],
    ['Orion spacecraft rendering', { sources: ['nasa'] }, 'nasa:jsc2022e046379', /^艺术想象图（NASA\/JSC）$/],
    ['Mars rover landing animation', { sources: ['nasa'] }, 'nasa:JPL-20201221-M2020f-0002-EDL Full Version w SFX', /^艺术想象动画（NASA\/JPL-Caltech）$/],
    ['black hole', { sources: ['nasa'] }, 'nasa:GSFC_20181002_SMBH_m13043_Simulation', /^示意动画（NASA\/Goddard）$/],
    ['solar eclipse diagram', { sources: ['commons'] }, 'commons:File:Types of solar eclipse ESA521436.png', /^示意图（ESA） \/ Wikimedia Commons$/],
    ['James Webb artist concept', { sources: ['commons'] }, 'commons:File:PDS 70 (artist concept) (weic2318a).jpg', /^艺术想象图（NASA, ESA, CSA, J\. Olmsted \(STScI\)） \/ Wikimedia Commons$/],
    ['Artemis II crew', { sources: ['commons'] }, 'commons:File:Artemis II Crew Poster.png', /^艺术想象图（NASA Headquarters/],
    ['Curiosity rover selfie', { sources: ['nasa'] }, 'nasa:PIA23240', false],
    ['Mars rover landing animation', { sources: ['nasa'] }, 'nasa:PIA16014', false],
    ['Mars rover landing animation', { sources: ['nasa'] }, 'nasa:PIA16087', false],
    ['Webb deep field', { sources: ['commons'] }, "commons:File:Webb's First Deep Field.jpg", false],
    ['Event Horizon Telescope black hole', { sources: ['commons'] }, 'commons:File:Black hole - Messier 87.jpg', false],
    ['ISS rendering', { sources: ['nasa'] }, 'nasa:1400496', false],
    ['Artemis simulation', { sources: ['nasa'] }, 'nasa:KSC-20230720-PH-KLS01_0160', false],
    ['astronaut training simulation', { sources: ['nasa'] }, 'nasa:S70-34412', false],
  ];
  const cache = new Map<string, FootageCandidate[]>();
  const searchCached = async (q: string, opts: Parameters<typeof searchFootage>[1]) => {
    const key = `${q}|${JSON.stringify(opts)}`;
    if (!cache.has(key)) cache.set(key, await patient(() => searchFootage(q, { ...opts, limit: 12 })));
    return cache.get(key)!;
  };
  for (const [q, opts, id, label] of known) {
    const c = (await searchCached(q, opts)).find((r) => r.id === id);
    console.log(`  ${cut(id, 60)} ${c ? `${c.artwork ? 'art' : '   '} ${c.credit}${c.sourceCredit ? ` (source: ${c.sourceCredit})` : ''}` : 'not in results'}`);
    check(!!c && (label ? c.artwork === true && label.test(c.credit) : c.artwork === false && !ART_CREDIT.test(c.credit)),
      `${id} ${label ? `is artwork, credit ${label.source}` : 'is real imagery'}`);
  }
  // Sweeps over whole result sets: no real observation in them may be called artwork, and every artist's impression
  // must be.
  const sweeps: Array<[string, Parameters<typeof searchFootage>[1], RegExp, boolean]> = [
    ['Webb deep field', { sources: ['commons'] }, /^(?!.*diagram).*Deep Field/i, false],
    ['Curiosity rover selfie', { sources: ['nasa'] }, /selfie/i, false],
    ['total solar eclipse', { sources: ['commons'] }, /^(?!.*(?:diagram|map|infographic)).*eclipse/i, false],
    ['Event Horizon Telescope black hole', { sources: ['commons'] }, /Messier 87|Sagittarius A\*/, false],
    ['exoplanet artist impression', { sources: ['commons'] }, /artist/i, true],
  ];
  for (const [q, opts, re, art] of sweeps) {
    const rows = (await searchCached(q, opts)).filter((r) => re.test(r.title));
    const wrong = rows.filter((r) => r.artwork !== art);
    check(rows.length > 0 && wrong.length === 0,
      `"${q}": ${rows.length} titles matching ${re.source} all ${art ? 'artwork' : 'real imagery'}${wrong.length ? ` (${wrong.map((r) => r.id).join(', ')})` : ''}`);
  }
  const bootprint = (await patient(() => searchFootage('Apollo 11 moon landing', { sources: ['commons'], limit: 12 }))).filter((r) => /bootprint/i.test(r.title));
  check(bootprint.every((r) => !r.artwork), `Aldrin bootprint (category "Illustrations used in ...") is a photo${bootprint.length ? '' : ' (not in results)'}`);
  // The label reaches the manifest, and an entry written before artwork detection is relabelled on re-fetch.
  const artAssets = join(dir, 'art-project', 'assets');
  const art = await fetchFootage('nasa:PIA22082', artAssets);
  console.log(`  nasa:PIA22082 -> ${art.file} | ${art.entry.credit} | source ${art.entry.sourceCredit}`);
  check(art.entry.artwork === true && art.entry.credit === '艺术想象图（NASA/JPL-Caltech）' && art.entry.sourceCredit === 'NASA/JPL-Caltech', 'fetched artwork keeps label and source credit in its manifest entry');
  const { artwork: _a, sourceCredit: _s, ...legacy } = art.entry;
  recordManifest(join(dir, 'art-project'), { ...legacy, credit: 'NASA/JPL-Caltech' });
  const mtime = (await stat(join(artAssets, art.file))).mtimeMs;
  const again = await fetchFootage('nasa:PIA22082', artAssets);
  check(again.entry.artwork === true && again.entry.credit === '艺术想象图（NASA/JPL-Caltech）', `old manifest entry without artwork is relabelled on re-fetch (${again.entry.credit})`);
  check(again.file === art.file && (await stat(join(artAssets, art.file))).mtimeMs === mtime, 'relabelling does not download again');

  // Projects assembled from an old manifest are relabelled in place, without fetching anything: refreshManifestArtwork.
  const artProject = join(dir, 'art-project');
  const legacyOf = (e: ManifestEntry): ManifestEntry => {
    const { artwork: _x, sourceCredit: _y, ...old } = e;
    return { ...old, credit: e.sourceCredit ?? e.credit };
  };
  recordManifest(artProject, { ...legacyOf(again.entry), usedFor: ['s1'] });
  const t0 = performance.now();
  const n1 = await refreshManifestArtwork(artProject);
  const relabelled = readManifest(artProject).find((e) => e.id === 'nasa:PIA22082');
  console.log(`  refreshManifestArtwork: ${n1} changed in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${relabelled?.credit}`);
  check(n1 === 1 && relabelled?.artwork === true && relabelled.credit === '艺术想象图（NASA/JPL-Caltech）' && relabelled.sourceCredit === 'NASA/JPL-Caltech' && relabelled.usedFor?.[0] === 's1',
    'refreshManifestArtwork relabels an old entry for nasa:PIA22082 (keeps usedFor)');
  check((await stat(join(artAssets, art.file))).mtimeMs === mtime && listDir(artAssets).length === 1, 'refreshManifestArtwork downloads nothing');
  check(await refreshManifestArtwork(artProject) === 0, 'a second refreshManifestArtwork changes 0');
  check(listDir(artProject).every((f) => !f.endsWith('.tmp')), 'refreshManifestArtwork leaves no temp files');

  // Libraries out of reach: an id never searched (so no cached record) cannot be relabelled; the entry stays as it is
  // and the call still resolves, quickly when fetch fails and within its limit when fetch hangs.
  // (These ids are used nowhere else here: an id tried while offline is not asked again in this process.)
  const offline = join(dir, 'offline-project');
  const stale: ManifestEntry = { ...legacyOf(again.entry), file: 'ft-nasa-offline.jpg', id: 'nasa:PIA17000', credit: 'NASA/Ames/JPL-Caltech' };
  const staleCommons: ManifestEntry = { ...stale, file: 'ft-commons-offline.png', id: 'commons:File:Solar eclipse ESA521416.png', source: 'commons', credit: 'ESA / Wikimedia Commons' };
  recordManifest(offline, stale);
  recordManifest(offline, staleCommons);
  const before = JSON.stringify(readManifest(offline));
  const realFetch = globalThis.fetch;
  for (const [how, fake] of [
    ['failing', () => Promise.reject(new TypeError('fetch failed'))],
    ['hanging', () => new Promise<Response>(() => {})],
  ] as const) {
    globalThis.fetch = fake as typeof fetch;
    const t1 = performance.now();
    let n = -1;
    try { n = await refreshManifestArtwork(offline); } finally { globalThis.fetch = realFetch; }
    const secs = (performance.now() - t1) / 1000;
    check(n === 0 && JSON.stringify(readManifest(offline)) === before && secs < 10, `${how} libraries: refreshManifestArtwork resolves 0 in ${secs.toFixed(1)} s, entries untouched`);
  }

  // Items labelled through refreshManifestArtwork (records only, no search). Photographs: people with or signing
  // posters, people standing before a painting, a simulator, a VR lab's "graphics", the HERA analog habitat, a launch
  // team's simulation in the Firing Room, analog-mission photos on Commons, a lander photographed by its rover, a
  // Jupiter globe made from Hubble maps, a launch photo whose Commons author field is a web address. Artwork: "This
  // animation depicts ..." beside "observed", an "Illustration depicting ..." sentence late in the text, "artist's
  // interpretation", a "(Visualizations)" artist, "artist?s concept" as old records print it, "as painted by", "this
  // video illustrates what ... might look like", paintings by category or "oil on canvas", a chart category, a
  // mission-profile title. An item whose library does not answer in time is skipped, not failed.
  const named: Array<[string, RegExp | false]> = [
    ['nasa:iss027e007888', false], ['nasa:KSC-20230322-PH-KLS07_0061', false], ['nasa:S69-19983', false],
    ['nasa:jsc2018e087573', false], ['nasa:HERA_Groundlinks_Promo_7', false], ['nasa:KSC-20230720-PH-KLS01_0276', false],
    ['nasa:KSC-97pc115', false], ['nasa:GSFC_20171208_Archive_e000537', false],
    ['commons:File:M.A.R.S. Analog Simulation (34091939616).jpg', false], ['commons:File:HI SEAS Analogue suit test.jpg', false],
    ['commons:File:M.Musilova in a spacesuit outside the simulated Martian habitat.jpg', false],
    ['commons:File:ChangE-4 - PCAM.png', false], ['commons:File:Artemis II launch (SLS MAF 20260401 ArtemisIILaunch 02) crop.jpg', false],
    ['nasa:PIA26452', /^艺术想象图（NASA\/JPL-Caltech）$/], ['nasa:ACD18-0204-002', /^艺术想象图（NASA\/Ames）$/],
    ['nasa:GSFC_20171208_Archive_e000132', /^艺术想象图（NASA\/Goddard）$/],
    ['commons:File:James-Webb-Space-Telescope-Deployment-Sequence- Nominal.webm', /^艺术想象动画（NASA.*） \/ Wikimedia Commons$/],
    ['nasa:S70-31898', /^艺术想象图（NASA\/JSC）$/], ['nasa:ARC-2000-80-HC-251', /^艺术想象图（NASA\/Ames）$/],
    ['nasa:GSFC_20171208_Archive_e000415', /^艺术想象图（NASA\/Goddard）$/],
    ['commons:File:Armand Point, Apollo And Daphne, 1919.jpg', /^艺术想象图（Armand Point） \/ Wikimedia Commons$/],
    ['commons:File:The Challenger Crew, Brumidi Corridors (8435519559).jpg', /^艺术想象图（/],
    ['commons:File:Exoplanet detections per year.png', /^示意图（NASA Exoplanet Archive） \/ Wikimedia Commons$/],
    ["commons:File:Chang'e-5 mission profile-el.png", /^示意图（/],
  ];
  // Several small projects, so each refreshManifestArtwork call stays well inside its time budget.
  const labelled: ManifestEntry[] = [];
  for (let b = 0; b * 8 < named.length; b++) {
    const namedProject = join(dir, `named-project-${b}`);
    for (const [i, [id]] of named.slice(b * 8, b * 8 + 8).entries()) {
      recordManifest(namedProject, { ...legacyOf(again.entry), file: `named-${i}`, id, source: id.startsWith('nasa:') ? 'nasa' : 'commons', credit: 'old credit' });
    }
    for (let round = 0; round < 3 && readManifest(namedProject).some((e) => e.artwork === undefined); round++) await refreshManifestArtwork(namedProject);
    labelled.push(...readManifest(namedProject));
    await new Promise((r) => setTimeout(r, 2000)); // spread the lookups over time: Commons rate-limits bursts
  }
  for (const [id, label] of named) {
    const e = labelled.find((x) => x.id === id);
    console.log(`  ${cut(id, 60)} ${e?.artwork === undefined ? 'not reached' : `${e.artwork ? 'art' : '   '} ${e.credit}`}`);
    if (e?.artwork === undefined) {
      console.log(`  skip ${id} (library not reachable)`);
      continue;
    }
    check(label ? e.artwork && label.test(e.credit) && !!e.sourceCredit : !e.artwork && !ART_CREDIT.test(e.credit) && e.sourceCredit === undefined,
      `${id} ${label ? `is artwork, credit ${label.source}` : 'is real imagery'}`);
    check(!/^(?:https?:|\/\/|www\.)/.test(e.credit), `${id} credit is not a web address (${e.credit})`);
  }

  // 2. Fetch
  const nasaImage = (await searchFootage('Curiosity rover selfie', { kind: 'image', sources: ['nasa'] }))[0];
  const nasaVideo = found['ISS earth timelapse']![0];
  const commonsImage = found['Hubble galaxy']![0];
  check(!!nasaImage && !!nasaVideo && !!commonsImage, 'have one NASA image, NASA video and Commons image to fetch');

  console.log('\nfetch');
  for (const [c, maxSeconds] of [[nasaImage, undefined], [nasaVideo, 8], [commonsImage, undefined]] as const) {
    if (!c) continue;
    const t0 = performance.now();
    const r = await patient(() => fetchFootage(c.id, assets, maxSeconds ? { maxSeconds } : {}));
    const secs = (performance.now() - t0) / 1000;
    const path = join(assets, r.file);
    const size = (await stat(path)).size;
    const p = await probe(path);
    const v = p.streams.find((s) => s.codec_type === 'video');
    console.log(`  ${c.id}\n    -> ${r.file} ${r.width}x${r.height}${r.duration ? ` ${r.duration}s` : ''} ${(size / 1024 / 1024).toFixed(2)} MB in ${secs.toFixed(1)} s | ${r.entry.license} | ${r.entry.credit}`);
    check(r.file.startsWith(`ft-${c.source}-`) && !r.file.includes('/'), `${r.file} named ft-${c.source}-<hash>`);
    check(!!v && v.width === r.width && v.height === r.height, `${r.file} decodes at ${r.width}x${r.height}`);
    check(r.kind === c.kind && r.entry.kind === c.kind, `${r.file} kind ${c.kind}`);
    check(r.entry.id === c.id && r.entry.file === r.file && r.entry.license === c.license && r.entry.credit === c.credit && r.entry.artwork === !!c.artwork && !!Date.parse(r.entry.fetchedAt), `${r.file} manifest entry matches the candidate`);
    if (c.kind === 'image') {
      check(/\.(jpg|png)$/.test(r.file) && size <= 15 * 1024 * 1024, `${r.file} is jpg/png within 15 MB`);
      check(r.duration === undefined, `${r.file} has no duration`);
    } else {
      check(r.file.endsWith('.mp4') && v?.codec_name === 'h264', `${r.file} is H.264 mp4`);
      check(Math.max(r.width, r.height) <= 1280, `${r.file} long side <= 1280`);
      check(!!r.duration && r.duration > 1 && r.duration <= 8.2, `${r.file} cut to <= 8 s (${r.duration})`);
      console.log(`    audio: ${p.streams.some((s) => s.codec_type === 'audio') ? 'kept' : 'none in source'}`);
    }
    const t1 = performance.now();
    const again = await fetchFootage(c.id, assets, maxSeconds ? { maxSeconds } : {});
    const mtimeSame = (await stat(path)).mtimeMs;
    check(again.file === r.file && again.width === r.width, `${r.file} re-fetch reuses the file (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
    check(mtimeSame === (await stat(path)).mtimeMs, `${r.file} untouched by re-fetch`);
  }
  let badId = '';
  try { await fetchFootage('flickr:123', assets); } catch (e) { badId = (e as Error).message; }
  check(/素材编号/.test(badId), `bad id rejected in Chinese: ${badId}`);

  // 3. Manifest
  console.log('\nmanifest');
  const project = join(dir, 'project');
  check(readManifest(project).length === 0, 'missing manifest reads as []');
  const base = { id: 'nasa:x', source: 'nasa' as const, kind: 'image' as const, title: 'X', pageUrl: 'https://images.nasa.gov/details/x', license: 'Public domain (NASA)', credit: 'NASA', needsAttribution: false, fetchedAt: new Date().toISOString() };
  recordManifest(project, { ...base, file: 'a.jpg', usedFor: ['s1'] });
  recordManifest(project, { ...base, file: 'b.jpg' });
  recordManifest(project, { ...base, file: 'a.jpg', title: 'X2', usedFor: ['s2'] });
  const m = readManifest(project);
  check(m.length === 2, 'upsert by file keeps 2 entries');
  check(m.find((e) => e.file === 'a.jpg')?.title === 'X2', 'upsert replaces fields');
  check(JSON.stringify(m.find((e) => e.file === 'a.jpg')?.usedFor) === '["s1","s2"]', 'usedFor merged');
  const { writeFileSync, readdirSync } = await import('node:fs');
  check(readdirSync(project).every((f) => !f.endsWith('.tmp')), 'no temp files left behind');
  writeFileSync(join(project, 'assets_manifest.json'), '{not json');
  check(readManifest(project).length === 0, 'corrupt manifest reads as []');
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll footage checks passed');
