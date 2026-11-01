// Switches the system panel can flip at runtime; stored in DATA_DIR/settings.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_MODELS, config, LEGACY_VOICES, SEEDANCE_MODELS, VOICE_CATALOG, type VoiceKey } from './config.ts';

export interface Settings {
  /** Score every finished turn in the background (one model call per turn). */
  reviewEnabled: boolean;
  /** Keep the shared preference memory up to date from turns and 👍/👎 feedback. */
  memoryAutoUpdate: boolean;
  /** Default conversation model; a conversation can override it. */
  chatModel: string;
  effort: 'low' | 'medium' | 'high';
  seedanceModel: string;
  /** Speak each script segment's voiceover with TTS and mix it under the picture. */
  voiceover: boolean;
  voiceZh: VoiceKey;
  voiceEn: VoiceKey;
  /** Default for Seedance shots' synced sound (people speaking on camera, ambience). */
  syncAudio: boolean;
}

const file = join(config.dataDir, 'settings.json');
const defaults: Settings = {
  reviewEnabled: true, memoryAutoUpdate: true,
  chatModel: config.model, effort: (['low', 'medium', 'high'].includes(config.effort) ? config.effort : 'medium') as Settings['effort'],
  seedanceModel: SEEDANCE_MODELS[0]!.id, voiceover: true, voiceZh: 'zh_gentle_m', voiceEn: 'en_trust_m', syncAudio: true,
};
const STRINGS: Record<string, (v: string) => boolean> = {
  chatModel: (v) => CHAT_MODELS.some((m) => m.id === v),
  effort: (v) => ['low', 'medium', 'high'].includes(v),
  seedanceModel: (v) => SEEDANCE_MODELS.some((m) => m.id === v),
  voiceZh: (v) => VOICE_CATALOG[v]?.lang === 'zh',
  voiceEn: (v) => VOICE_CATALOG[v]?.lang === 'en',
};

export const settings = {
  get(): Settings {
    try {
      const s: Settings = { ...defaults, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) };
      // Voices saved before the catalogue (zhMale…) map to their nearest catalogue voice; unknown ones to the default.
      for (const k of ['voiceZh', 'voiceEn'] as const) {
        s[k] = LEGACY_VOICES[s[k]] ?? s[k];
        if (!STRINGS[k]!(s[k])) s[k] = defaults[k];
      }
      return s;
    } catch {
      return { ...defaults };
    }
  },
  set(patch: Partial<Settings>): Settings {
    const next = { ...this.get() };
    for (const k of Object.keys(defaults) as Array<keyof Settings>) {
      const v = patch[k] as unknown;
      if (typeof defaults[k] === 'boolean' && typeof v === 'boolean') (next as Record<string, unknown>)[k] = v;
      else if (typeof v === 'string' && STRINGS[k]?.(v)) (next as Record<string, unknown>)[k] = v;
    }
    writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
    renameSync(file + '.tmp', file);
    return next;
  },
};

/** The realistic-shot model in use and its clip length limit. */
export function seedanceModel() {
  const id = settings.get().seedanceModel;
  return SEEDANCE_MODELS.find((m) => m.id === id) ?? SEEDANCE_MODELS[0]!;
}
