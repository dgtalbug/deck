import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GroomForm } from '../../src/ui/slices/board/GroomForm.tsx';
import type { GroomInput } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';

// Requirement: minimal groom marks research optional — the form says a
// minimal spec is valid (title + tasks alone), and accepting with empty
// findings/deltas produces exactly that minimal GroomInput.
const mountedContainers: HdomDiv[] = [];

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
});

async function mountForm(onAccept: (input: GroomInput) => void): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  render(<GroomForm noteTitle="scratch note" onAccept={onAccept} onReject={() => {}} />, container);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return win;
}

describe('minimal groom marks research optional', () => {
  test('the form states the minimal spec is valid', async () => {
    const win = await mountForm(() => {});
    const hint = win.document.querySelector('[data-testid="minimal-spec-hint"]');
    expect(hint?.textContent).toContain('title + tasks');
    expect(hint?.textContent).toContain('empty');
  });

  test('accepting with only a title + tasks yields empty findings and deltas', async () => {
    let accepted: GroomInput | undefined;
    const win = await mountForm((input) => {
      accepted = input;
    });
    const title = win.document.querySelector('#groom-title') as unknown as HTMLInputElement;
    title.value = 'tiny fix';
    title.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    const tasks = win.document.querySelector('#groom-tasks') as unknown as HTMLTextAreaElement;
    tasks.value = 'ship it';
    tasks.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));

    (win.document.querySelector('.dialog-actions .btn-primary') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted).toBeDefined();
    expect(accepted!.refinedTitle).toBe('tiny fix');
    expect(accepted!.research.codebaseFindings).toEqual([]);
    expect(accepted!.specDeltas).toEqual([]);
    expect(accepted!.tasks).toEqual(['ship it']);
  });
});
