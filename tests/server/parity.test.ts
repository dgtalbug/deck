import { describe, expect, test } from 'bun:test';
import * as crud from '../../src/core/board/crud.ts';
import * as publish from '../../src/core/board/publish.ts';
import * as engineVerbs from '../../src/core/engine/verbs.ts';
import * as gitIssues from '../../src/core/git/issues.ts';
import * as engineVerify from '../../src/core/engine/verify.ts';
import * as engineDelivery from '../../src/core/engine/delivery.ts';
import * as engineDeliveryCleanup from '../../src/core/engine/delivery-cleanup.ts';
import * as engineHooks from '../../src/core/engine/hooks.ts';
import * as boardMemory from '../../src/core/board/memory.ts';
import * as projectsHarness from '../../src/core/projects/harness.ts';
import * as serverMcp from '../../src/server/mcp.ts';
import * as specstore from '../../src/core/board/specstore.ts';
import * as git from '../../src/core/git/digest.ts';
import * as gitops from '../../src/core/git/ops.ts';
import * as groom from '../../src/core/board/groom.ts';
import * as lanes from '../../src/core/board/lanes.ts';
import * as next from '../../src/core/board/next.ts';
import * as verify from '../../src/core/board/verify.ts';
import * as views from '../../src/core/board/views.ts';
import * as boardSummaries from '../../src/core/board/summaries.ts';
import * as outbox from '../../src/core/events/outbox.ts';
import * as summary from '../../src/core/projects/summary.ts';
import * as projectsInit from '../../src/core/projects/init.ts';
import * as projectsDoctor from '../../src/core/projects/doctor.ts';
import * as typesRegistry from '../../src/core/board/types-registry.ts';
import * as boardRules from '../../src/core/board/rules.ts';
import * as evidenceBundle from '../../src/core/board/evidence-bundle.ts';
import * as capabilityProjection from '../../src/core/board/capability-projection.ts';
import * as graphIndex from '../../src/core/graph/index.ts';
import * as planning from '../../src/core/board/planning.ts';
import * as taskPatches from '../../src/core/board/task-patches.ts';
import * as scopeInspect from '../../src/core/board/scope-inspect.ts';
import * as impactSnapshots from '../../src/core/board/impact-snapshots.ts';
import * as engineApply from '../../src/core/engine/apply.ts';
import * as engineHandoffs from '../../src/core/engine/handoffs.ts';
import * as projectsWorkspaces from '../../src/core/projects/workspaces.ts';
import * as sourceBaselines from '../../src/core/board/source-baselines.ts';
import { DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { parity as cliParity } from '../../src/cli/main.ts';
import { parity as boardParity } from '../../src/server/routes/board.ts';
import { parity as cardsParity } from '../../src/server/routes/cards.ts';
import { parity as specsParity } from '../../src/server/routes/specs.ts';
import { parity as engineParity } from '../../src/server/routes/engine.ts';
import { parity as gitParity } from '../../src/server/routes/git.ts';
import { parity as homeParity } from '../../src/server/routes/home.ts';
import { parity as notesParity } from '../../src/server/routes/notes.ts';
import { parity as sseParity } from '../../src/server/sse.ts';
import { parity as epicsParity } from '../../src/server/routes/epics.ts';
import { parity as typesParity } from '../../src/server/routes/types.ts';
import { parity as deliveryParity } from '../../src/server/routes/delivery.ts';
import { parity as capabilitiesParity } from '../../src/server/routes/capabilities.ts';

// Route → core parity (epic rule): every route maps to exactly one core
// function with the same name — endpoint tests double as CLI tests.
const functions: Record<string, unknown> = {
  ...sourceBaselines,
  ...taskPatches,
  ...scopeInspect,
  ...impactSnapshots,
  ...engineApply,
  ...engineHandoffs,
  ...projectsWorkspaces,
  ...crud,
  ...publish,
  ...specstore,
  ...engineVerbs,
  ...gitIssues,
  ...engineVerify,
  ...engineDelivery,
  ...engineDeliveryCleanup,
  ...engineHooks,
  ...boardMemory,
  ...projectsHarness,
  ...serverMcp,
  registerUserVerb: DocumentStore.prototype.registerUserVerb,
  addEpic: DocumentStore.prototype.addEpic,
  listEpics: DocumentStore.prototype.listEpics,
  getEpic: DocumentStore.prototype.getEpic,
  epicStories: DocumentStore.prototype.epicStories,
  setEpic: DocumentStore.prototype.setEpic,
  isRegisteredVerb: DocumentStore.prototype.isRegisteredVerb,
  listUserVerbs: DocumentStore.prototype.listUserVerbs,
  ...git,
  ...gitops,
  ...groom,
  ...lanes,
  ...next,
  ...verify,
  ...views,
  ...boardSummaries,
  ...summary,
  ...projectsInit,
  ...projectsDoctor,
  ...typesRegistry,
  ...boardRules,
  ...evidenceBundle,
  ...capabilityProjection,
  ...graphIndex,
  ...planning,
  ...outbox,
  addNote: DocumentStore.prototype.addNote,
  reorder: DocumentStore.prototype.reorder,
  setBlocked: DocumentStore.prototype.setBlocked,
  list: ProjectRegistry.prototype.list,
};

const parityTables = [homeParity, boardParity, notesParity, cardsParity, specsParity, engineParity, deliveryParity, gitParity, sseParity, epicsParity, typesParity, capabilitiesParity];

describe('route-to-core parity', () => {
  test('every declared route maps to an existing core function', () => {
    const entries = parityTables.flatMap((table) => Object.entries(table));
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const [route, fnName] of entries) {
      expect(typeof functions[fnName!], route).toBe('function');
    }
  });

  test('every CLI command maps to an existing core function', () => {
    for (const [command, fnName] of Object.entries(cliParity)) {
      expect(typeof functions[fnName!], command).toBe('function');
    }
  });
});
