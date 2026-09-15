import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { CardDetail, type DetailActions } from '../../src/ui/slices/board/CardDetail.tsx';
import { EpicDetail } from '../../src/ui/slices/board/CardDetail.tsx';
import { GroomForm } from '../../src/ui/slices/board/GroomForm.tsx';
import type { GroomInput, UiCard } from '../../src/ui/slices/board/api.ts';
import { installDom } from './dom.ts';

const VERB_CARD: UiCard = {
  id: 'feat-engine-core',
  title: 'engine core — feat+fix end-to-end',
  lane: 'groomed',
  verb: 'feat',
  specPath: 'specs/changes/feat-engine-core/',
  tasks: [
    { title: 'store: schema', done: true },
    { title: 'lanes: guard', done: false },
  ],
  progress: '1/2',
  research: { codebaseFindings: ['found the store'], rca: 'missing guard', blastRadius: ['lanes'] },
};

const TWEAK_CARD: UiCard = { id: 'tw-1', title: 'bump port hint copy', lane: 'todo', requirement: 'one line' };

function actionsLog(log: string[]): DetailActions {
  return {
    onClose: () => log.push('close'),
    onMoveToTodo: (id) => log.push(`move:${id}`),
    onBlock: (id, reason) => log.push(`block:${id}:${reason}`),
    onUnblock: (id) => log.push(`unblock:${id}`),
    onTweak: (id) => log.push(`tweak:${id}`),
    onDemote: (id) => log.push(`demote:${id}`),
    onNext: () => log.push('next'),
    onEditTitle: (id) => log.push(`editTitle:${id}`),
    onEditGroom: (id) => log.push(`editGroom:${id}`),
    onDelete: (id) => log.push(`delete:${id}`),
  };
}

async function renderDetail(card: UiCard): Promise<{ win: ReturnType<typeof installDom>; log: string[] }> {
  const win = installDom();
  const log: string[] = [];
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  render(<CardDetail card={card} actions={actionsLog(log)} specMarkdown="# spec\n\nbody" />, container);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { win, log };
}

describe('CardDetail (task 6.4)', () => {
  test('groomed card: tasks/progress/research render; actions fire the right callbacks', async () => {
    const { win, log } = await renderDetail(VERB_CARD);
    const dialog = win.document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('1/2');
    expect(dialog.querySelectorAll('.task').length).toBe(2);

    ( [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Move to todo')) as unknown as HTMLButtonElement).click();
    ( [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('deck next')) as unknown as HTMLButtonElement).click();
    ( [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Undo groom')) as unknown as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual(['move:feat-engine-core', 'next', 'demote:feat-engine-core']);
  });

  test('block flow: reason captured and sent', async () => {
    const { win, log } = await renderDetail(VERB_CARD);
    const dialog = win.document.querySelector('[role="dialog"]')!;
    const blockButton = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Block…')) as unknown as HTMLButtonElement;
    blockButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const input = win.document.getElementById('block-reason') as HTMLInputElement | null;
    if (input !== null) {
      input.value = 'waiting on migration';
      input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    }
    await new Promise((resolve) => setTimeout(resolve, 30)); // state flush
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Block card')) as unknown as HTMLButtonElement;
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toContain('block:feat-engine-core:waiting on migration');
  });

  test('tweak card shows the fast-lane action', async () => {
    const { win, log } = await renderDetail(TWEAK_CARD);
    const dialog = win.document.querySelector('[role="dialog"]')!;
    const fast = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Fast lane')) as unknown as HTMLButtonElement;
    fast.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual(['tweak:tw-1']);
  });
});

describe('CardDetail tabs (task 3.2/4.3)', () => {
  function tabsOf(win: ReturnType<typeof installDom>): HTMLElement[] {
    return [...win.document.querySelectorAll('[role="tablist"] [role="tab"]')] as unknown as HTMLElement[];
  }

  function press(win: ReturnType<typeof installDom>, el: HTMLElement, key: string): void {
    el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event);
  }

  test('tabs and panel carry stable id/aria associations with roving tabindex', async () => {
    const { win } = await renderDetail(VERB_CARD);
    const tabs = tabsOf(win);
    expect(tabs.map((tab) => tab.getAttribute('id'))).toEqual(['detail-tab-tasks', 'detail-tab-spec', 'detail-tab-research']);
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-controls')).toBe('detail-tabpanel');
    }
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1');
    expect(tabs[2]!.getAttribute('tabindex')).toBe('-1');
    const panel = win.document.querySelector('#detail-tabpanel')!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('detail-tab-tasks');
    expect(panel.textContent).toContain('1/2 tasks'); // selected panel content
  });

  test('ArrowRight/ArrowLeft move focus and selection, wrapping at the ends', async () => {
    const { win } = await renderDetail(VERB_CARD);
    const tabs = tabsOf(win);
    tabs[0]!.focus();
    expect(win.document.activeElement as unknown as HTMLElement).toBe(tabs[0]!);

    press(win, tabs[0]!, 'ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.activeElement?.id).toBe('detail-tab-spec');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    const panel = win.document.querySelector('#detail-tabpanel')!;
    expect(panel.getAttribute('aria-labelledby')).toBe('detail-tab-spec');
    expect(panel.textContent).toContain(VERB_CARD.specPath!); // panel follows selection

    press(win, win.document.activeElement as unknown as HTMLElement, 'ArrowLeft');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.activeElement?.id).toBe('detail-tab-tasks');

    // wrap: ArrowLeft from the first tab lands on the last
    press(win, win.document.activeElement as unknown as HTMLElement, 'ArrowLeft');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.activeElement?.id).toBe('detail-tab-research');
  });

  test('Home/End jump to the first/last tab', async () => {
    const { win } = await renderDetail(VERB_CARD);
    const tabs = tabsOf(win);
    tabs[0]!.focus();
    press(win, tabs[0]!, 'End');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.activeElement?.id).toBe('detail-tab-research');
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    press(win, win.document.activeElement as unknown as HTMLElement, 'Home');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.activeElement?.id).toBe('detail-tab-tasks');
    expect(win.document.querySelector('#detail-tabpanel')?.getAttribute('aria-labelledby')).toBe('detail-tab-tasks');
  });
});

describe('GroomForm (task 6.5)', () => {
  test('accept converts with exactly the GroomProposal fields; open questions gate', async () => {
    const win = installDom();
    const accepted: GroomInput[] = [];
    const rejects: number[] = [];
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(
      <GroomForm
        noteTitle="ui: empty states feel dead"
        onAccept={(input) => accepted.push(input)}
        onReject={() => rejects.push(1)}
      />,
      container,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    const set = (id: string, value: string) => {
      const field = win.document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (field !== null) {
        field.value = value;
        field.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
      }
    };
    set('groom-title', 'lane empty states — affordance + copy');
    set('groom-findings', 'lanes render bare when empty');
    set('groom-deltas', 'ADDED: board ui :: lanes with no cards render a dashed ghost cell');
    set('groom-tasks', 'add .lane-empty to spade 13\nwire per-lane copy in Lane');
    set('groom-questions', 'should done cap its history?');

    const acceptButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Accept')) as unknown as HTMLButtonElement;

    // unanswered question blocks the accept
    acceptButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted).toEqual([]);
    expect(win.document.body.textContent).toContain('unanswered');

    set('answer-0', 'no — keep it simple');
    await new Promise((resolve) => setTimeout(resolve, 30)); // state flush
    acceptButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted.length).toBe(1);
    expect(accepted[0]).toMatchObject({
      proposedVerb: 'feat',
      refinedTitle: 'lane empty states — affordance + copy',
      research: { codebaseFindings: ['lanes render bare when empty'] },
      specDeltas: [{ op: 'ADDED', requirement: 'board ui', text: 'lanes with no cards render a dashed ghost cell' }],
      tasks: ['add .lane-empty to spade 13', 'wire per-lane copy in Lane'],
      openQuestions: [], // answered questions never ride the wire
    });
    expect(rejects).toEqual([]);
  });

  test('reject is inert — no request, note untouched', async () => {
    const win = installDom();
    const accepted: GroomInput[] = [];
    let rejects = 0;
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(
      <GroomForm noteTitle="docs: write README" onAccept={(input) => accepted.push(input)} onReject={() => { rejects += 1; }} />,
      container,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rejectButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject')) as unknown as HTMLButtonElement;
    rejectButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejects).toBe(1);
    expect(accepted).toEqual([]);
  });
});

describe('EpicDetail evidence view', () => {
  test('loads evidence on demand and renders sanitized bundle markdown', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    let calls = 0;
    render(
      <EpicDetail
        tree={{ epic: { id: 'epic-1', title: 'Portable evidence' }, stories: [] }}
        project="deck"
        fetchEvidenceBundle={async () => {
          calls += 1;
          return {
            schema: 'deck.evidence-bundle',
            version: '1.0.0',
            project: { id: 'project:deck', name: 'deck <unsafe>' },
            snapshot: { digest: 'a'.repeat(64), createdAt: null },
            epics: [],
            stories: [],
            decisions: [],
            evidence: [],
            deliveries: [],
            omissions: [{ field: 'links', reason: 'unsafe-link', note: 'javascript link omitted' }],
            extensions: {},
          };
        }}
        onOpenStory={() => undefined}
        onClose={() => undefined}
      />,
      container,
    );

    expect(calls).toBe(0);
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('Evidence')) as unknown as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 10 && !container.textContent?.includes('Evidence Bundle: deck'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    expect(calls).toBe(1);
    expect(container.textContent).toContain('Evidence Bundle: deck');
    expect(container.innerHTML).not.toContain('<unsafe>');
    expect(container.textContent).toContain('unsafe-link');
  });
});

describe('EpicDetail capability view', () => {
  test('loads current capabilities and keeps conflicted preview separate', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(
      <EpicDetail
        tree={{ epic: { id: 'epic-1', title: 'Living capabilities' }, stories: [] }}
        project="deck"
        fetchCapabilities={async () => ({
          statements: [{
            capabilityId: 'capability:evidence',
            statementId: 'statement:lineage',
            text: 'Applied capability text.',
            digest: 'a'.repeat(64),
            state: 'current',
            sourceCardId: 'card:story',
            sourceCriterionId: 'criterion:c-1',
            sourceScopeRevision: 1,
            evidenceId: 'evidence:ev-1',
            deliveryId: 'delivery:dl-1',
            sourceDrift: 'none',
          }],
        })}
        fetchCapabilityPreview={async () => ({
          id: 'cap-prev-conflict',
          batchId: 'batch:conflict',
          preview: {
            changes: [{
              op: 'add',
              deltaId: 'delta:conflict',
              capabilityId: 'capability:evidence',
              statementId: 'statement:conflict',
              before: null,
              after: 'Conflicted capability text.',
            }],
            conflicts: [{ deltaId: 'delta:conflict', reason: 'cannot add an existing current statement' }],
            statements: [],
          },
          resolution: null,
        })}
        onOpenStory={() => undefined}
        onClose={() => undefined}
      />,
      container,
    );

    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('Capabilities')) as unknown as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 10 && !container.textContent?.includes('Applied capability text.'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(container.textContent).toContain('Applied capability text.');
    expect(container.textContent).not.toContain('Conflicted capability text.');

    const input = container.querySelector('input') as unknown as HTMLInputElement;
    input.value = 'cap-prev-conflict';
    input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const load = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('Load preview')) as unknown as HTMLButtonElement;
    load.click();
    for (let i = 0; i < 10 && !container.textContent?.includes('cannot add an existing current statement'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    expect(container.textContent).toContain('cannot add an existing current statement');
    expect(container.textContent).toContain('Conflicted capability text.');
  });
});
