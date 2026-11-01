// Voiceover synthesis for the plan: lines grouped into takes per script segment, cut back into lines.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { ledger } from '../core/ledger.ts';
import { ffmpeg, probeDuration } from '../core/ffmpeg.ts';
import { hashInputs } from '../media/project.ts';
import { DEFAULT_VO_SPEED, relayReady, tts as ttsConfig } from '../core/config.ts';
import { settings } from '../core/settings.ts';
import { estimateSeconds, LINE_PAUSE, speak, stripPauses, takeCuts, ttsEstimateUsd, voiceFor } from '../providers/tts.ts';
import { createLimiter } from '../core/limiter.ts';
import { type Ctx } from './shared.ts';

/** Voiceover lines are spoken a few at a time. */
const voLimit = createLimiter(4);

export function createVoiceover(ctx: Ctx) {
  /**
   * Speaks every shot's voiceover (cached by text, voice and speed); returns file and length per shot id.
   * Consecutive lines of one script segment (or, without a script, up to three in a row) are spoken in one take,
   * joined by short pause marks, and cut apart at those pauses: read together they keep one intonation across
   * the sentences, where lines spoken one by one each start fresh and end flat. A take that cannot be cut
   * cleanly falls back to one line at a time. Grouping by segment keeps a revision from re-voicing (and
   * re-timing) lines nobody changed.
   */
  async function voiceover(shots: Array<{ id: string; vo?: string; vo_tts?: string; vo_speed?: number; segment?: string; role?: string }>, lang?: string) {
    const out = new Map<string, { file: string; seconds: number }>();
    if (!settings.get().voiceover) return out;
    const lines = shots.filter((n) => n.vo?.trim()).map((n) => {
      // What the voice reads: the spoken form when one is given (acronyms, numbers, pauses), else the line itself.
      const line = (n.vo_tts?.trim() || n.vo!).trim();
      return { n, line, voice: voiceFor(stripPauses(line), lang, ctx.store.project.voice), speed: n.vo_speed ?? DEFAULT_VO_SPEED };
    });
    type Line = (typeof lines)[number];
    const main = (l: Line) => !l.n.role || l.n.role === 'main';
    const groups: Line[][] = [];
    for (const l of lines) {
      const g = groups.at(-1);
      const last = g?.at(-1);
      const together = last && main(l) && main(last) && last.voice === l.voice && last.speed === l.speed
        && (l.n.segment ? last.n.segment === l.n.segment : !last.n.segment && g!.length < 3);
      if (together) g!.push(l);
      else groups.push([l]);
    }
    const book = (l: { n: { id: string }; line: string }) => {
      const warning = ledger.record({ session: ctx.sessionId, item: `配音 / ${l.n.id}`, model: ttsConfig.model, usage: `${l.line.length} chars`, usd: ttsEstimateUsd(l.line), basis: 'estimate' });
      if (warning) ctx.emit({ type: 'toast', level: 'warn', text: warning });
    };
    const one = async (l: Line) => {
      const file = `vo/${hashInputs('vo', l.line, l.voice, ttsConfig.model, !relayReady(), ...(l.speed !== 1 ? [l.speed] : []))}.mp3`;
      if (existsSync(ctx.store.path(file))) return void out.set(l.n.id, { file, seconds: probeDuration(ctx.store.path(file)) });
      const r = await speak(l.line, l.voice, ctx.store.path(file), { speed: l.speed });
      if (!r.mock) book(l);
      out.set(l.n.id, { file, seconds: r.seconds });
    };
    const together = async (g: Line[]) => {
      // Each line ends on a stop so the voice closes it; the pause marks give the cuts, and they are kept clearly
      // longer than any pause marked inside a line, so the longest silences are the ones between lines.
      const inside = Math.max(0, ...g.flatMap((l) => [...l.line.matchAll(/<#(\d+(?:\.\d+)?)#>/g)].map((m) => Number(m[1]))));
      const pause = Math.round(Math.max(LINE_PAUSE, inside + 0.4) * 10) / 10;
      const text = g.map((l) => (/[。！？!?…,，、；;.]$/.test(l.line) ? l.line : `${l.line}。`)).join(`<#${pause}#>`);
      const hash = hashInputs('vo-take', text, g[0]!.voice, ttsConfig.model, g[0]!.speed);
      const pieces = g.map((_, i) => `vo/${hash}-${i}.mp3`);
      if (pieces.every((f) => existsSync(ctx.store.path(f)))) {
        g.forEach((l, i) => out.set(l.n.id, { file: pieces[i]!, seconds: probeDuration(ctx.store.path(pieces[i]!)) }));
        return true;
      }
      const take = ctx.store.path(`vo/${hash}.take.mp3`);
      if (!existsSync(take)) {
        const r = await speak(text, g[0]!.voice, take, { speed: g[0]!.speed });
        if (r.mock) return false;
        book({ n: { id: g.map((l) => l.n.id).join('+') }, line: text });
      }
      const gaps = await takeCuts(take, g.length, pause);
      if (!gaps) return false;
      const total = probeDuration(take);
      const bounds = g.map((_, i) => [i === 0 ? 0 : Math.max(0, gaps[i - 1]![1] - 0.08), i === g.length - 1 ? total : gaps[i]![0] + 0.15] as [number, number]);
      // A piece far off the length its words need means a cut fell inside a line: not trusted.
      if (bounds.some(([a, b], i) => { const r = (b - a) * g[i]!.speed / estimateSeconds(g[i]!.line); return r < 0.35 || r > 2.5; })) return false;
      for (const [i, [a, b]] of bounds.entries()) {
        await ffmpeg(['-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', take, '-c:a', 'libmp3lame', '-q:a', '2', ctx.store.path(pieces[i]!)]);
      }
      g.forEach((l, i) => out.set(l.n.id, { file: pieces[i]!, seconds: probeDuration(ctx.store.path(pieces[i]!)) }));
      return true;
    };
    await mkdir(ctx.store.path('vo'), { recursive: true });
    await Promise.all(groups.map((g) => voLimit(async () => {
      if (g.length > 1 && relayReady() && await together(g).catch(() => false)) return;
      for (const l of g) await one(l);
    })));
    return out;
  }
  return voiceover;
}
export type Voiceover = ReturnType<typeof createVoiceover>;
