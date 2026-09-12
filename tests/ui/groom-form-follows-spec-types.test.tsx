// GroomForm renders the spec-type registry's section fields (spec-type-registry):
// required hints show, missing required sections block accept, and filled
// sections ride research.sections to the wire contract.
import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import type { VNode } from 'preact';
import { installDom, type TestWindow } from './dom.ts';
import { GroomForm } from '../../src/ui/slices/board/GroomForm.tsx';
import type { GroomInput, SpecTypeView } from '../../src/ui/slices/board/api.ts';

const FIX_TYPE: SpecTypeView = {
  id: 'fix',
  displayName: 'fix',
  icon: 'bug',
  sections: [
    { id: 'reproduce', label: 'Reproduce', alwaysRequired: true },
    { id: 'rca', label: 'Root cause', alwaysRequired: true },
  ],
  groomFields: ['story', 'findings', 'blast'],
  taskLaw: 'failing test first',
  gitConvention: {},
  hardRule: 'test-pairing',
};

const EMPTY_LIKE: GroomInput = {
  proposedVerb: 'fix',
  refinedTitle: '',
  research: { codebaseFindings: [] },
  specDeltas: [],
  tasks: [],
  openQuestions: [],
};

async function mountForm(onAccept: (input: GroomInput) => void): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  render(
    <GroomForm
      noteTitle="broken thing"
      types={[FIX_TYPE]}
      initial={{ ...EMPTY_LIKE, proposedVerb: 'fix' }}
      onAccept={onAccept}
      onReject={() => {}}
    /> as VNode,
    container,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return win;
}

function typeInto(win: TestWindow, selector: string, value: string): void {
  const field = win.document.querySelector(selector) as unknown as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
}

describe('GroomForm spec-type sections', () => {
  test('renders registry section fields with required hints', async () => {
    const win = await mountForm(() => {});
    const reproduce = win.document.querySelector('#groom-section-reproduce');
    expect(reproduce).not.toBeNull();
    const label = win.document.querySelector('label[for="groom-section-reproduce"]');
    expect(label?.textContent).toContain('Reproduce (required)');
    expect(win.document.querySelector('label[for="groom-section-rca"]')?.textContent).toContain('Root cause (required)');
  });

  test('accept is blocked until required sections are filled, then carries them', async () => {
    let accepted: GroomInput | undefined;
    const win = await mountForm((input) => {
      accepted = input;
    });
    typeInto(win, '#groom-title', 'fixed thing');
    (win.document.querySelector('.dialog-actions .btn-primary') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted).toBeUndefined(); // required sections empty

    typeInto(win, '#groom-section-reproduce', 'run the suite');
    typeInto(win, '#groom-section-rca', 'off by one');
    await new Promise((resolve) => setTimeout(resolve, 30));
    (win.document.querySelector('.dialog-actions .btn-primary') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted).toMatchObject({
      research: { sections: { reproduce: 'run the suite', rca: 'off by one' } },
    });
  });
});
