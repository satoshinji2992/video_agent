// Agent skills installed by an administrator under SKILLS_DIR/<name>/SKILL.md. The web UI can only
// enable or disable installed skills; installing goes through scripts/tools/skill-add.ts on the server.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.ts';

export const SKILLS_DIR = resolve(process.env.SKILLS_DIR ?? 'skills');
const STATE = join(config.dataDir, 'skills.json');

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  source?: string;
  commit?: string;
  installedAt?: string;
}

interface SkillState {
  skills: Record<string, { enabled?: boolean; source?: string; commit?: string; installedAt?: string }>;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function readState(): SkillState {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as SkillState;
  } catch {
    return { skills: {} };
  }
}

export function writeSkillMeta(name: string, patch: SkillState['skills'][string]) {
  const s = readState();
  s.skills[name] = { ...s.skills[name], ...patch };
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

export function listSkills(): SkillInfo[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const state = readState();
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => {
      const fm = parseFrontmatter(readFileSync(join(SKILLS_DIR, d.name, 'SKILL.md'), 'utf8'));
      const meta = state.skills[d.name] ?? {};
      return {
        name: d.name,
        description: fm.description ?? '',
        dir: join(SKILLS_DIR, d.name),
        enabled: meta.enabled ?? true,
        source: meta.source,
        commit: meta.commit,
        installedAt: meta.installedAt,
      };
    });
}

export const enabledSkills = () => listSkills().filter((s) => s.enabled);

export function skillReadme(name: string): string | null {
  const s = listSkills().find((x) => x.name === name);
  return s ? readFileSync(join(s.dir, 'SKILL.md'), 'utf8') : null;
}

/** Real path of the skills root, for containment checks on file tools. */
export const skillsRealRoot = () => (existsSync(SKILLS_DIR) ? realpathSync(SKILLS_DIR) : SKILLS_DIR);

/**
 * Exposes the enabled skills to a session as project skills: <session>/.claude/skills/<name> links to
 * the installed folder. The CLI loads them with settingSources ['project'] and the session dir as cwd.
 */
export function linkSkillsInto(sessionDir: string, names: string[]) {
  const dir = join(sessionDir, '.claude', 'skills');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    const target = join(SKILLS_DIR, n);
    const link = join(dir, n);
    if (existsSync(target) && !existsSync(link)) symlinkSync(target, link, 'dir');
  }
  return dir;
}
