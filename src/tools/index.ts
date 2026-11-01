// The studio: the agent's tools for one session, registered as one in-process MCP server. Each group of tools
// lives in its own file; they share the session context and, where noted, the shot notes and voiceover.
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { type Ctx } from './shared.ts';
import { createNotes } from './notes.ts';
import { createVoiceover } from './voiceover.ts';
import { codeShotTools } from './code-shot.ts';
import { assembleTools } from './assemble.ts';
import { mediaTools } from './media.ts';
import { footageTools } from './footage.ts';
import { imageTools } from './images.ts';
import { planTools } from './plan.ts';
import { seedanceTools } from './seedance.ts';
import { modelTools } from './models.ts';
import { researchTools } from './research.ts';
import { webImageTools } from './web-image.ts';

export type { Emit, JobEvent } from './shared.ts';
export { hasPendingSeedance, pendingSeedanceCount, pendingShotIds, resumeSeedanceJobs } from './seedance.ts';
export const STUDIO = 'studio';
export const STUDIO_TOOLS = ['save_plan', 'render_code_shot', 'generate_seedance_shot', 'assemble_video', 'present_script', 'ask_user', 'research', 'generate_image', 'render_image_shot', 'find_footage', 'use_footage', 'render_footage_shot', 'save_release_notes', 'list_media', 'inspect_media', 'read_document', 'render_clip_shot', 'preview_footage', 'find_model', 'use_model', 'find_web_image', 'use_web_image'].map(
  (t) => `mcp__${STUDIO}__${t}`,
);

export function createStudio(ctx: Ctx) {
  const notes = createNotes(ctx);
  const voiceover = createVoiceover(ctx);
  const code = codeShotTools(ctx, notes);
  const assemble = assembleTools(ctx, notes);
  const media = mediaTools(ctx, notes);
  const footage = footageTools(ctx, notes);
  const images = imageTools(ctx, notes);
  const plan = planTools(ctx, voiceover);
  const seedance = seedanceTools(ctx);
  const models = modelTools(ctx);
  const research = researchTools(ctx);
  const web = webImageTools(ctx);

  return createSdkMcpServer({
    name: STUDIO,
    version: '1.0.0',
    timeout: 25 * 60_000,
    tools: [plan.savePlan, code.renderCodeShot, seedance.generateSeedanceShot, assemble.assembleVideo, plan.presentScript, plan.askUser, research.researchTool, images.generateImage, images.renderImageShot, footage.findFootage, footage.useFootage, footage.renderFootageShot, assemble.saveReleaseNotes, media.listMedia, media.inspectMedia, media.readDocument, media.renderClipShot, footage.previewFootage, models.findModel, models.useModel, web.findWebImage, web.useWebImage],
  });
}
