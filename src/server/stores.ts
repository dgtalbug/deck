// Lazy store-open moved to the shared helper (core) so the CLI door opens
// project stores exactly like the server door (cli-board-init design D1).
export { getStore, projectStore } from '../core/projects/stores.ts';
