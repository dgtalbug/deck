// architect-intake-navigation (UI): the epic drill-down — EpicDetail renders
// clickable story rows and opens them; CardDetail's epic chip navigates back.
import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { installDom, type TestWindow } from './dom.ts';
import { CardDetail, EpicDetail } from '../../src/ui/slices/board/CardDetail.tsx';
import type { EpicTreeStory, UiCard } from '../../src/ui/slices/board/api.ts';

const TREE = {
  epic: { id: 'code-intelligence', title: 'code intelligence', createdAt: '', type: 'epic' as const },
  stories: [
    { id: 'poc-research', title: 'poc research', lane: 'groomed', verb: 'feat', tasks: { done: 1, total: 2 } },
    { id: 'index-module', title: 'index module', lane: 'done', verb: 'feat', tasks: { done: 1, total: 1 } },
  ] satisfies EpicTreeStory[],
};

const STORY: UiCard = {
  id: 'poc-research',
  title: 'poc research',
  lane: 'groomed',
  verb: 'feat',
  specPath: '.deck/specs/stories/feat-poc-research/',
  tasks: [{ title: 'read code', done: true }, { title: 'write plan', done: false }],
  progress: '1/2',
  epicId: 'code-intelligence',
};

const NOOP_ACTIONS = {
  onClose: () => {},
  onMoveToTodo: () => {},
  onBlock: () => {},
  onUnblock: () => {},
  onTweak: () => {},
  onDemote: () => {},
  onNext: () => {},
  onEditTitle: () => {},
  onEditGroom: () => {},
  onDelete: () => {},
};

function textOf(win: TestWindow): string {
  return win.document.body.textContent ?? '';
}

describe('epic navigation UI', () => {
  test('EpicDetail lists stories with lane + progress; a row opens the story', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    const opened: string[] = [];
    render(
      <EpicDetail tree={TREE} onOpenStory={(id) => opened.push(id)} onClose={() => {}} />,
      container,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = textOf(win);
    expect(text).toContain('poc research');
    expect(text).toContain('index module');
    expect(text).toContain('1/2 stories done');
    const row = [...win.document.querySelectorAll('button.story-row')].find(
      (el) => el.textContent?.includes('poc research'),
    ) as unknown as HTMLElement;
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toEqual(['poc-research']);
  });

  test('EpicDetail empty epic hints at deck story', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(
      <EpicDetail tree={{ ...TREE, stories: [] }} onOpenStory={() => {}} onClose={() => {}} />,
      container,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(textOf(win)).toContain('deck story');
  });

  test('CardDetail epic chip is clickable back to the epic', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    const opened: string[] = [];
    render(
      <CardDetail
        card={STORY}
        actions={NOOP_ACTIONS}
        specMarkdown="# spec"
        epic={{ id: 'code-intelligence', title: 'code intelligence' }}
        onOpenEpic={(id) => opened.push(id)}
      />,
      container,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // story detail shows its task list with checkbox state
    const text = textOf(win);
    expect(text).toContain('read code');
    expect(text).toContain('write plan');
    const chip = win.document.querySelector('button.type-epic') as unknown as HTMLElement;
    expect(chip?.textContent).toContain('code intelligence');
    chip.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toEqual(['code-intelligence']);
  });
});
