import { z } from 'zod';
import { join } from 'node:path';

const deckConfigSchema = z.object({
  server: z.object({ port: z.number().int().min(1).max(65535) }).optional(),
  board: z.object({ wipLimit: z.number().int().min(1) }).optional(),
});

export type DeckConfig = z.infer<typeof deckConfigSchema>;

export function parseDeckConfig(text: string): DeckConfig {
  const raw: unknown = Bun.YAML.parse(text);
  return deckConfigSchema.parse(raw);
}

export async function readDeckConfig(projectPath: string): Promise<DeckConfig> {
  const file = Bun.file(join(projectPath, 'deck.config.yaml'));
  if (!(await file.exists())) return {};
  const text = await file.text();
  if (text.trim().length === 0) return {};
  return parseDeckConfig(text);
}
