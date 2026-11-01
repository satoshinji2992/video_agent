import { resolve } from 'node:path';

export type Aspect = '9:16' | '16:9' | '1:1';

/**
 * Output resolution. 480p is the rule for now; 720p and 1080p are wired up but only honoured when
 * ENABLE_HD=true (code shots render at this size too, and Seedance is asked for the same resolution).
 */
export const RESOLUTION = (process.env.ENABLE_HD === 'true' && ['720p', '1080p'].includes(process.env.VIDEO_RESOLUTION ?? '')
  ? process.env.VIDEO_RESOLUTION : '480p') as '480p' | '720p' | '1080p';
const SHORT = { '480p': 480, '720p': 720, '1080p': 1080 }[RESOLUTION];
const LONG = Math.round((SHORT * 16) / 9 / 2) * 2;

export const FRAME_SIZE: Record<Aspect, { width: number; height: number }> = {
  '9:16': { width: SHORT, height: LONG },
  '16:9': { width: LONG, height: SHORT },
  '1:1': { width: SHORT, height: SHORT },
};

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dataDir: resolve(env.DATA_DIR ?? 'data'),
  model: env.VIDEO_AGENT_MODEL ?? 'claude-opus-5-5',
  effort: (env.VIDEO_AGENT_EFFORT ?? 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  /** Model for the opening line; the fastest one available, since it only writes one sentence. */
  openerModel: env.OPENER_MODEL ?? 'claude-sonnet-4-6',
  /** Write each turn's opening line with a short separate call, so it reaches the user within seconds. */
  fastFirstReply: (env.FAST_FIRST_REPLY ?? 'true') !== 'false',
  maxBudgetUsdPerSession: Number(env.VIDEO_AGENT_MAX_BUDGET_USD ?? 5),
  chromePath: env.CHROME_PATH ?? '/usr/bin/google-chrome',
  renderConcurrency: Number(env.RENDER_CONCURRENCY ?? 4),
  fps: 24,
  idleSessionMs: Number(env.IDLE_SESSION_MINUTES ?? 30) * 60_000,
  /** Deleted conversations stay restorable in data/trash for this many days, then are removed. */
  trashDays: Number(env.TRASH_DAYS ?? 7),
  /** The shared 3D model cache (data/model-cache) is trimmed back to this size, least recently used first. */
  modelCacheMaxMb: Number(env.MODEL_CACHE_MAX_MB ?? 2048),
  review: {
    /** Model for the background turn reviews and memory upkeep; defaults to the conversation model. */
    model: env.REVIEW_MODEL ?? env.VIDEO_AGENT_MODEL ?? 'claude-opus-5-5',
    effort: (env.REVIEW_EFFORT ?? 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  },
  seedance: {
    baseUrl: (env.SEEDANCE_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, ''),
    apiKey: env.SEEDANCE_API_KEY ?? '',
    model: env.SEEDANCE_MODEL ?? 'doubao-seedance-2-5-260628',
    draft: (env.SEEDANCE_DRAFT ?? 'true') === 'true',
    pollIntervalMs: Number(env.SEEDANCE_POLL_MS ?? 4000),
    /** Optional billing lookup returning { actual_amount, currency } for ?task_id=...; empty disables it. */
    usageUrl: env.SEEDANCE_USAGE_URL ?? '',
    timeoutMs: Number(env.SEEDANCE_TIMEOUT_MINUTES ?? 15) * 60_000,
    maxConcurrent: Number(env.SEEDANCE_MAX_CONCURRENT ?? 3),
    /** Longest clip the model accepts: Seedance 2.5 takes 4–30 s, the 2.0 series 4–15 s. */
    maxSeconds: Number(env.SEEDANCE_MAX_SECONDS ?? (/2[-.]5/.test(env.SEEDANCE_MODEL ?? 'doubao-seedance-2-5-260628') ? 30 : 15)),
  },
};

export const seedanceMocked = () => !config.seedance.apiKey || env.SEEDANCE_MOCK === 'true';

const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
const json = <T>(v: string | undefined, d: T): T => { try { return v ? (JSON.parse(v) as T) : d; } catch { return d; } };

/** The relay that also serves search, speech and other models; defaults to where Seedance goes. */
export const relay = {
  url: (env.RELAY_URL ?? (env.SEEDANCE_BASE_URL ? origin(env.SEEDANCE_BASE_URL) : '')).replace(/\/+$/, ''),
  apiKey: env.RELAY_API_KEY ?? env.SEEDANCE_API_KEY ?? '',
};
export const relayReady = () => Boolean(relay.url && relay.apiKey);

export interface ModelChoice { id: string; label: string; note: string }
/** Conversation models offered in the panel; ids as the endpoint expects them (override with VIDEO_AGENT_MODELS). */
export const CHAT_MODELS: ModelChoice[] = json(env.VIDEO_AGENT_MODELS, [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: '默认模型。实测极短调用约 6.5 秒；规划和动画质量最好，费用最高' },
  { id: 'claude-opus-5', label: 'Opus 5', note: '实测极短调用约 2.5 秒' },
  { id: 'claude-fable-5', label: 'Fable 5', note: '实测极短调用约 5.9 秒' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', note: '上一代旗舰，实测极短调用约 2.2 秒' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: '实测极短调用约 1.7 秒，费用最低；复杂动画质量可能下降' },
]);
export interface SeedanceChoice extends ModelChoice { maxSeconds: number }
/** Realistic-shot models (override with SEEDANCE_MODELS). Always 480p. */
export const SEEDANCE_MODELS: SeedanceChoice[] = json(env.SEEDANCE_MODELS, [
  { id: env.SEEDANCE_MODEL ?? 'doubao-seedance-2-5-260628', label: 'Seedance 2.5', note: '画质最好，单镜头 4–30 秒', maxSeconds: 30 },
  { id: 'doubao-seedance-2-0', label: 'Seedance 2.0', note: '单镜头 4–15 秒，费用低于 2.5', maxSeconds: 15 },
  { id: 'doubao-seedance-2-0-fast', label: 'Seedance 2.0 Fast', note: '生成更快、费用更低，画质略降', maxSeconds: 15 },
  { id: 'doubao-seedance-2-0-mini', label: 'Seedance 2.0 Mini', note: '费用最低，适合草稿', maxSeconds: 15 },
]);

/**
 * The voices on offer (MiniMax system voices for speech-2.8-hd that the relay accepts; a wrong id fails with error
 * 2054 rather than falling back). The user picked the Chinese ones by ear on 2026-11-01, newsreader voices left
 * out on purpose; the agent picks one per video by its tone, the settings hold the default. The English ones are
 * only used for English lines.
 */
export interface CatalogVoice { id: string; lang: 'zh' | 'en'; gender: 'male' | 'female'; label: string; fits: string }
export const VOICE_CATALOG: Record<string, CatalogVoice> = json(env.TTS_CATALOG, {
  zh_gentle_m: { id: 'Chinese (Mandarin)_Gentleman', lang: 'zh', gender: 'male', label: '温和男声', fits: '默认；小店、生活方式、温情叙事' },
  zh_radio_m: { id: 'Chinese (Mandarin)_Radio_Host', lang: 'zh', gender: 'male', label: '电台男声', fits: '活泼带货、促销、节目感' },
  zh_story_m: { id: 'audiobook_male_1', lang: 'zh', gender: 'male', label: '讲故事男声', fits: '纪录片、故事、长讲解' },
  zh_steady_m: { id: 'Chinese (Mandarin)_Reliable_Executive', lang: 'zh', gender: 'male', label: '稳重男声', fits: '科普讲解、科技、企业介绍' },
  zh_warm_f: { id: 'Chinese (Mandarin)_Warm_Girl', lang: 'zh', gender: 'female', label: '温暖女声', fits: '女声默认；温情、祝福、花店、亲子' },
  en_trust_m: { id: 'English_Trustworth_Man', lang: 'en', gender: 'male', label: '英文男声', fits: 'English lines' },
  en_calm_f: { id: 'English_CalmWoman', lang: 'en', gender: 'female', label: '英文女声', fits: 'English lines' },
});
export type VoiceKey = string;
/** Voices by catalogue key, for the settings panel. */
export const VOICES: Record<VoiceKey, { id: string; label: string }> = Object.fromEntries(Object.entries(VOICE_CATALOG).map(([k, v]) => [k, { id: v.id, label: v.label }]));
/** Keys the settings used before the catalogue, mapped to their nearest catalogue voice. */
export const LEGACY_VOICES: Record<string, string> = { zhMale: 'zh_gentle_m', zhFemale: 'zh_warm_f', enMale: 'en_trust_m', enFemale: 'en_calm_f' };
/** Voiceover speed when a line names none: a touch brisk, never slow (the user wants neither a newsreader nor a drawl). */
export const DEFAULT_VO_SPEED = 1.07;
export const tts = {
  model: env.TTS_MODEL ?? 'speech-2.8-hd',
  /** Estimate when no actual charge is returned: USD per 1000 characters. */
  usdPer1kChars: Number(env.TTS_USD_PER_1K_CHARS ?? 0.1),
};
/** Tavily: web search, page extraction and image search (https://docs.tavily.com). */
export const tavily = {
  apiKey: env.TAVILY_API_KEY ?? '',
  url: (env.TAVILY_URL ?? 'https://api.tavily.com').replace(/\/+$/, ''),
  /** USD per Tavily credit, to book the credits each call reports in the ledger. */
  usdPerCredit: Number(env.TAVILY_USD_PER_CREDIT ?? 0.008),
};
export const tavilyReady = () => Boolean(tavily.apiKey);
export const research = {
  geminiModel: env.RESEARCH_GEMINI_MODEL ?? 'gemini-3.5-flash',
  gptModel: env.RESEARCH_GPT_MODEL ?? 'gpt-5.5',
  /** Estimate per search call when the relay reports no usage. */
  usdPerCall: Number(env.RESEARCH_USD_PER_CALL ?? 0.02),
};
