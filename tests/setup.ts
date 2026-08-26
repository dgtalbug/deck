// Test preload (bunfig.toml). Helpers live in tests/helpers.ts so tests can
// import them; this file only pins a throwaway DECK_HOME so no test ever
// touches the real ~/.deck registry.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DECK_HOME = mkdtempSync(join(tmpdir(), 'deck-home-'));
