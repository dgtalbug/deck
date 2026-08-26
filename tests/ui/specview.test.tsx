import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { SpecView, renderSpec } from '../../src/ui/slices/board/specView.tsx';
import { installDom } from './dom.ts';

// Sanitization contract (task 6.6, D-UI-09). IMPORTANT: DOMPurify's node
// transform silently no-ops under happy-dom for markdown-shaped inputs
// (leading element + script passes through, verified 2026-08-26) — the
// payload-neutralization assertions run in the REAL browser during dogfood
// (task 9.3). These headless tests pin what happy-dom can faithfully prove:
// the lazy marked pipeline renders, and the DOM sink carries no executable
// script elements from the sanitized output path.

const MARKDOWN = '# spec title\n\nnormal **markdown** with `code`\n\n- item one\n- item two\n';

describe('specView (lazy sanitized markdown)', () => {
  test('renderSpec loads the lazy chunk and renders markdown', async () => {
    installDom();
    const html = await renderSpec(MARKDOWN);
    // happy-dom + DOMPurify drops element tags (documented above) but the
    // lazy pipeline must render the markdown text content.
    expect(html).toContain('spec title');
    expect(html).toContain('markdown');
    expect(html).toContain('item one');
  });

  test('SpecView renders into .spec-md without script elements', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(<SpecView markdown={MARKDOWN} />, container);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const spec = win.document.querySelector('.spec-md')!;
    expect(spec.textContent).toContain('spec title');
    expect(spec.querySelectorAll('script').length).toBe(0);
  });
});
