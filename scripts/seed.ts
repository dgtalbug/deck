// Registers the current repo as a deck project (dogfood law) so it appears
// on the deck home. Run once per machine: `bun run seed`.
import { ProjectRegistry } from '../src/core/projects/registry.ts';

const projectPath = process.cwd();
const registry = new ProjectRegistry();
const info = registry.register(projectPath);
registry.close();
console.log(`registered deck project '${info.name}' → ${info.path}`);
