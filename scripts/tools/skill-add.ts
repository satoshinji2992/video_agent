// Installs an agent skill from a git repository: npm run skill:add <git-url> [name]
// Shallow-clones into SKILLS_DIR/<name>, strips .git/.github, validates SKILL.md and records the source
// URL and commit in DATA_DIR/skills.json. Skills that run shell commands at load time (!`...`) are refused.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Frontmatter a skill may carry; anything else (hooks, allowed-tools, shell, model, …) can change what runs. */
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'when_to_use']);

/** Refuses symlinks, submodules and inline shell commands anywhere in the skill. */
function checkTree(root: string) {
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`含有符号链接：${relative(root, p)}`);
      if (d.name === '.gitmodules') throw new Error('含有 git 子模块');
      if (st.isDirectory()) walk(p);
      else if (/\.md$/i.test(d.name)) {
        const t = readFileSync(p, 'utf8');
        if (t.includes('!`') || /^```!/m.test(t)) throw new Error(`${relative(root, p)} 含有加载时执行的命令（!\`），拒绝安装`);
      }
    }
  };
  walk(root);
}
import { SKILLS_DIR, parseFrontmatter, writeSkillMeta } from '../../src/core/skills.ts';

const [url, wanted] = process.argv.slice(2);
if (!url || !/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url)) {
  console.error('usage: npm run skill:add <git-url> [name]');
  process.exit(1);
}

mkdirSync(SKILLS_DIR, { recursive: true });
const tmp = join(SKILLS_DIR, `.incoming-${Date.now()}`);
try {
  execFileSync('git', ['clone', '--depth', '1', '--', url, tmp], { stdio: 'inherit' });
  const commit = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD']).toString().trim();
  const skillFile = join(tmp, 'SKILL.md');
  if (!existsSync(skillFile)) throw new Error('仓库根目录没有 SKILL.md');
  const text = readFileSync(skillFile, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm.name || !fm.description) throw new Error('SKILL.md 的 frontmatter 缺少 name 或 description');
  const keys = [...(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '').matchAll(/^([A-Za-z_-]+):/gm)].map((k) => k[1]!);
  const extra = keys.filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length) throw new Error(`SKILL.md 的 frontmatter 含有不允许的字段：${extra.join(', ')}（hooks、allowed-tools 等会改变可执行的内容），拒绝安装`);
  rmSync(join(tmp, '.git'), { recursive: true, force: true });
  checkTree(tmp);
  const name = (wanted ?? fm.name).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`技能名不合法：${name}`);
  rmSync(join(tmp, '.git'), { recursive: true, force: true });
  rmSync(join(tmp, '.github'), { recursive: true, force: true });
  const dest = join(SKILLS_DIR, name);
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
  writeSkillMeta(name, { enabled: true, source: url, commit, installedAt: new Date().toISOString() });
  console.log(`installed ${name} @ ${commit.slice(0, 7)} -> ${dest}`);
} catch (e) {
  rmSync(tmp, { recursive: true, force: true });
  console.error(`安装失败：${(e as Error).message}`);
  process.exit(1);
}
