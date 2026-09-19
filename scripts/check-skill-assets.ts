// Non-writing reproducibility check: the shipped embedded assets must equal a
// fresh generation from the tracked authored source. Run in CI or before
// release; exits 1 with the drift when they differ.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const skillsDir = join(root, 'src', 'skills');
if (!existsSync(skillsDir)) {
  console.error('check-skill-assets: src/skills not found');
  process.exit(1);
}
const fresh: Record<string, string> = {};
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('deck-')) continue;
  const file = join(skillsDir, entry.name, 'SKILL.md');
  if (existsSync(file)) fresh[`${entry.name}/SKILL.md`] = readFileSync(file, 'utf8');
}
const { skillAssets } = await import(join(root, 'src', 'core', 'projects', 'skill-assets.ts'));
const shipped = Object.keys(skillAssets).sort().join(',');
const generated = Object.keys(fresh).sort().join(',');
if (shipped !== generated) {
  console.error(`check-skill-assets: asset set drifted — shipped [${shipped}] vs source [${generated}]`);
  console.error('run: bun run scripts/embed-skills.ts');
  process.exit(1);
}
for (const [rel, content] of Object.entries(fresh)) {
  if (skillAssets[rel] !== content) {
    console.error(`check-skill-assets: ${rel} drifted from the authored source — run bun run scripts/embed-skills.ts`);
    process.exit(1);
  }
}
console.log(`check-skill-assets: ${generated.split(',').length} skill(s) reproduce byte-for-byte`);
