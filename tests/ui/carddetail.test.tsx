import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { CardDetail, type DetailActions } from '../../src/ui/slices/board/CardDetail.tsx';
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
