import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, type EvaluationManifest } from './schema.ts';
import type { ControlTranscript } from './score.ts';

// Host-neutral import: a run directory holds a manifest.json plus transcript
// files produced by whatever host adapter executed the trials. Nothing here
// knows a specific provider; receipts and transcripts are plain JSON.
export interface ImportedRun {
  directory: string;
  manifest: EvaluationManifest;
  transcripts: ControlTranscript[];
  issues: string[];
}

// Redaction applied to everything that enters a local report: absolute local
// paths collapse to their basename and credential-shaped strings are masked.
export function redact(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[\w.-]+\/(?:[^\s"']*)/g, (match) => match.split('/').pop() ?? '<path>')
    .replace(/\b(?:sk|api[-_]?key|token)[-_\w]{12,}\b/gi, '<redacted>');
}

export function importRunDirectory(directory: string): ImportedRun {
  const issues: string[] = [];
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest.json in ${directory}`);
  }
  let manifest: EvaluationManifest;
  try {
    manifest = validateManifest(JSON.parse(redact(readFileSync(manifestPath, 'utf8'))));
  } catch (error) {
    issues.push(`manifest failed validation: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const transcripts: ControlTranscript[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.startsWith('transcript-') || !entry.endsWith('.json')) continue;
    try {
      transcripts.push(JSON.parse(readFileSync(join(directory, entry), 'utf8')) as ControlTranscript);
    } catch (error) {
      issues.push(`${entry} unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (manifest.attempts.some((attempt) => attempt.accounting === null)) {
    issues.push('accounting unavailable for at least one attempt — run cannot satisfy promotion');
  }
  return { directory, manifest, transcripts, issues };
}
