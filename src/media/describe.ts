// What the user's footage shows, in words the agent can search and cut by: each shot's content, tags, and
// whether it is an accidental take (the floor, a pocket). Claude looks at the keyframes made during ingest
// (512 px), locally through the Claude Code login and on the server through the API, so what is measured in
// benchmarks is what users get.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/config.ts';
import { askStructured, type Img } from '../providers/llm.ts';
import { readIndex, updateMedia, type MediaItem } from './ingest.ts';
import { createLimiter } from '../core/limiter.ts';

const SYSTEM = `你在帮一位剪辑师整理用户上传的素材。每张图是素材里一个镜头段的中间帧，按顺序编号。逐段写一句具体的画面描述（谁、在做什么、什么场景、机位景别），给 2 到 6 个中文标签（人物、物品、动作、场景、景别），判断是不是误拍或废片（比如拍到地板、口袋、镜头被挡、对焦完全失败），再用一两句话总结整段素材。只写看得到的，不猜身份和品牌。只输出要求的 JSON。`;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          desc: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          misshot: { type: 'boolean' },
        },
        required: ['index', 'desc', 'tags', 'misshot'],
      },
    },
  },
  required: ['summary', 'segments'],
};

/**
 * Each call starts a Claude Code process: a batch of twenty clips must not start twenty at once (they starve
 * the ffmpeg work of the ingest still running and make it time out).
 */
const describeLimit = createLimiter(2);

/** At most this many segments per call (one image each); the rest of a very long clip keeps no description. */
const MAX_SEGMENTS = 24;

/**
 * Describes one ingested video or image item and stores the result in the media index (segment desc/tags,
 * '误拍' flag and usable=false for accidental takes, item summary). Returns the call's cost.
 */
export function describeMedia(projectDir: string, id: string): Promise<number> {
  return describeLimit(() => describeOne(projectDir, id));
}

async function describeOne(projectDir: string, id: string): Promise<number> {
  const item = readIndex(projectDir).find((m) => m.id === id);
  if (!item || item.status !== 'ready' || (item.kind !== 'video' && item.kind !== 'image') || !item.segments.length) return 0;
  const segs = item.segments.slice(0, MAX_SEGMENTS);
  const images: Img[] = [];
  for (const s of segs) {
    const f = s.frames[Math.floor(s.frames.length / 2)] ?? s.frames[0];
    if (f && existsSync(join(projectDir, f))) images.push({ mime: 'image/jpeg', data: readFileSync(join(projectDir, f)) });
  }
  if (!images.length) return 0;
  const lines = segs.map((s, i) => `${i + 1}. ${s.start.toFixed(1)}–${s.end.toFixed(1)} 秒${s.flags.length ? `，检测到：${s.flags.join('、')}` : ''}`);
  const text = `素材「${item.name}」（${item.kind === 'video' ? `视频 ${Math.round(item.duration ?? 0)} 秒，${item.width}x${item.height}` : '图片'}），共 ${segs.length} 段，图按顺序是：\n${lines.join('\n')}${item.transcript?.length ? `\n\n这段素材里说的话：${item.transcript.map((t) => t.text).join(' ').slice(0, 600)}` : ''}`;
  const { data, costUsd } = await askStructured<{ summary: string; segments: Array<{ index: number; desc: string; tags: string[]; misshot: boolean }> }>({
    model: config.review.model, system: SYSTEM, text, images, schema: SCHEMA,
  });
  // The index may have changed during the call (duplicate marks from another item's ingest): merge into
  // what is there now rather than writing back the copy read before it.
  const now = readIndex(projectDir).find((m) => m.id === id) ?? item;
  const segments = now.segments.map((s, i) => {
    const d = data.segments.find((x) => x.index === i + 1);
    if (!d) return s;
    const flags = d.misshot && !s.flags.includes('误拍') ? [...s.flags, '误拍'] : s.flags;
    return { ...s, desc: d.desc.slice(0, 200), tags: d.tags.slice(0, 8).map((t) => t.slice(0, 12)), flags, usable: s.usable && !d.misshot };
  });
  updateMedia(projectDir, id, { segments, summary: data.summary.slice(0, 400) } as Partial<MediaItem>);
  return costUsd;
}
