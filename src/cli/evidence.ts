import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { collectEvidenceBundleSnapshot, serializeEvidenceBundle } from '../core/board/evidence-bundle.ts';
import { renderEvidenceBundleMarkdown } from '../core/board/evidence-bundle-render.ts';
import { parseEvidenceBundle } from '../core/board/evidence-bundle-schema.ts';
import { DeckError } from '../core/board/errors.ts';
import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { flagString, UsageError, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return value;
}

function writeExportDirectory(outDir: string, files: Record<string, string>): void {
  if (existsSync(outDir)) {
    throw new DeckError(`evidence export destination already exists: ${outDir}`, { outDir });
  }
  const parent = dirname(outDir);
  const staging = join(parent, `.${basename(outDir)}.tmp-${crypto.randomUUID()}`);
  try {
    mkdirSync(staging, { recursive: false });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(staging, name), content);
    }
    renameSync(staging, outDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function evidenceCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const subcommand = required(args.positionals[0], 'evidence export <epic-id> --out <directory>');
  if (subcommand === 'view') {
    const path = required(args.positionals[1], 'evidence view <bundle.json>');
    try {
      const parsed = parseEvidenceBundle(JSON.parse(readFileSync(path, 'utf8')));
      return renderEvidenceBundleMarkdown(parsed.bundle);
    } catch (error) {
      throw new DeckError(`invalid evidence bundle '${path}' — ${error instanceof Error ? error.message : String(error)}`, { path });
    }
  }
  if (subcommand !== 'export') {
    throw new UsageError('usage: deck evidence export <epic-id> --out <directory> | deck evidence view <bundle.json>');
  }
  const epicId = required(args.positionals[1], 'evidence export <epic-id> --out <directory>');
  const outDir = required(flagString(args.flags, 'out'), 'evidence export <epic-id> --out <directory>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const bundle = collectEvidenceBundleSnapshot(store, epicId, { createdAt: new Date().toISOString() });
  writeExportDirectory(outDir, {
    'bundle.json': serializeEvidenceBundle(bundle),
    'review.md': renderEvidenceBundleMarkdown(bundle),
  });
  return `evidence exported: ${outDir}`;
}
