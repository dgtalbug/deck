import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const OUT_DIR = join(process.cwd(), 'dist', 'ui');
const LIMIT_BYTES = 100 * 1024;

function gzipSize(path: string): number {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

function staticImportsOf(source: string): string[] {
  return [...source.matchAll(/from"\.\/([^"]+\.js)"|import"\.\/([^"]+\.js)"/g)]
    .map((match) => match[1] ?? match[2])
    .filter((name): name is string => name !== undefined);
}

function main(): void {
  if (!existsSync(OUT_DIR)) {
    console.error('check-ui-budget: dist/ui not found — run `bun run build:ui` first');
    process.exit(1);
  }
  const jsFiles = readdirSync(OUT_DIR).filter((name) => name.endsWith('.js'));
  const entry = 'app.js';
  if (!jsFiles.includes(entry)) {
    console.error(`check-ui-budget: ${entry} missing from dist/ui (found: ${jsFiles.join(', ')})`);
    process.exit(1);
  }

  const sources = new Map(jsFiles.map((name) => [name, readFileSync(join(OUT_DIR, name), 'utf8')]));
  const core = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const imported of staticImportsOf(sources.get(current) ?? '')) {
      if (!core.has(imported)) {
        core.add(imported);
        queue.push(imported);
      }
    }
  }
  const lazy = jsFiles.filter((name) => !core.has(name));

  const total = [...core].reduce((sum, name) => sum + gzipSize(join(OUT_DIR, name)), 0);
  for (const name of [...core].sort()) {
    console.log(`  core   ${name}  ${(gzipSize(join(OUT_DIR, name)) / 1024).toFixed(1)} kB gz`);
  }
  for (const name of lazy.sort()) {
    console.log(`  lazy   ${name}  ${(gzipSize(join(OUT_DIR, name)) / 1024).toFixed(1)} kB gz (excluded)`);
  }
  console.log(`  core total: ${(total / 1024).toFixed(1)} kB gz / ${(LIMIT_BYTES / 1024).toFixed(0)} kB budget`);

  const coreText = [...core].map((name) => sources.get(name) ?? '').join('\n');
  const sanitizerInCore = coreText.includes('DOMPurify');
  if (sanitizerInCore) {
    console.error('check-ui-budget: DOMPurify leaked into the core bundle — the spec renderer must stay a lazy chunk');
    process.exit(1);
  }
  if (total > LIMIT_BYTES) {
    console.error(`check-ui-budget: core bundle ${total} B exceeds the ${LIMIT_BYTES} B budget`);
    process.exit(1);
  }
  console.log('check-ui-budget: PASS');
}

main();
