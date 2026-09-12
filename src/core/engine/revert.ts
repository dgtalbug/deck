// The revert door (hold law): done cards have no hold — the way back is a
// NEW reviewed change, never a direct main mutation. `deck revert
// <done-card-id>` materializes a groomed revert-verb card whose story,
// tasks, and spec deltas re-derive from the archived merge commit. The
// merge is found by SUBJECT match (`merge: <branch> — <title>`), never by
// branchFor — legacy cards used id-shaped branch names.
import { DeckError } from '../board/errors.ts';
import { convertToVerbItem } from '../board/groom.ts';
import { newestSpecVersion } from '../board/specstore.ts';
import type { VerbItem } from '../board/types.ts';
import { parseRequirementNames } from './verify.ts';
import { runGit } from '../git/digest.ts';
import type { DocumentStore } from '../board/store.ts';

export interface RevertDoorOutcome {
  card: VerbItem;
  mergeSha: string;
  mergeSubject: string;
}

async function findMergeCommit(projectPath: string, title: string): Promise<{ sha: string; subject: string }> {
  const log = await runGit(projectPath, ['log', '--merges', '--format=%H%x09%s', '-F', '--grep=merge: '], 10_000);
  if (log.code !== 0) {
    throw new DeckError(`revert door: git log --merges refused — ${log.stderr.trim()}`, { title });
  }
  const suffix = ` — ${title}`;
  for (const line of log.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (subject.endsWith(suffix)) return { sha, subject };
  }
  throw new DeckError(
    `revert door: no merge commit found for "${title}" — ` +
      `looked for a merge subject ending in " — ${title}" (git log --merges)`,
    { title },
  );
}

export async function openRevertDoor(
  store: DocumentStore,
  projectPath: string,
  doneId: string,
): Promise<RevertDoorOutcome> {
  const done = store.getVerbItem(doneId);
  if (done.lane !== 'done') {
    throw new DeckError(
      `revert door: card ${doneId} is in ${done.lane} — it runs on done cards ` +
        `(hold is not allowed there; deck revert <done-card-id> is the way back)`,
      { cardId: doneId, lane: done.lane },
    );
  }
  const merge = await findMergeCommit(projectPath, done.title);
  const short = merge.sha.slice(0, 10);

  // Spec honesty: the revert REMOVES every requirement the archived change
  // added — same names, so the review gate's slug pairing holds against the
  // files the revert diff touches (the original change's own files).
  const version = newestSpecVersion(store, doneId);
  const requirements = version !== undefined ? parseRequirementNames(version.markdown) : [];
  const specDeltas = requirements.map((requirement) => ({
    op: 'REMOVED' as const,
    requirement: `Requirement: ${requirement}`,
    text: `Reverts the archived change (merge ${short}) that delivered this requirement.`,
  }));
  const tasks = [
    ...requirements.map((requirement) => `Revert "${requirement}" — covered by git revert -m 1 ${short}`),
    `Run git revert -m 1 ${merge.sha} on the revert branch`,
    'Push the revert branch and run the full gates',
    'Review and archive the revert card to close the loop',
  ];

  const note = store.addNote(`revert ${done.title}`);
  const card = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'revert',
    refinedTitle: `revert ${done.title}`,
    research: {
      codebaseFindings: [
        `archived change: card ${done.id}, merge commit ${merge.sha} ("${merge.subject}")`,
        `revert command: git revert -m 1 ${merge.sha} on the revert branch`,
        'the revert itself is a reviewed change — never a direct main mutation',
      ],
      rca: `The archived change "${done.title}" needs to come back: this card re-derives its undo from the recorded merge commit so the loop stays closed-loop.`,
      blastRadius: [`merge ${short} (re-derivable from research if this card is re-groomed)`],
      story: `Revert the archived change "${done.title}" (card ${done.id}) through a reviewed change: git revert -m 1 ${merge.sha} on the revert branch, then push, verify, and archive through the normal engine loop.`,
    },
    specDeltas,
    tasks,
    openQuestions: [],
  });
  if (done.epicId !== undefined) store.setEpic(card.id, done.epicId);
  return { card: store.getVerbItem(card.id), mergeSha: merge.sha, mergeSubject: merge.subject };
}
