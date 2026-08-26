import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';

// Lazy sanitized markdown: marked + DOMPurify load as a separate chunk on
// first render (D-UI-06). Everything passes through DOMPurify's default
// profile — script/onerror/javascript: payloads never survive.

type Render = (markdown: string) => Promise<string>;

let renderer: Render | null = null;

async function loadRenderer(): Promise<Render> {
  const [{ marked }, dompurify] = await Promise.all([
    import('marked'),
    import('dompurify'),
  ]);
  // In the browser the default export is a ready instance; in DOM-less
  // runtimes (Bun tests) it is a factory that binds to the global window.
  const purifier = typeof dompurify.default.sanitize === 'function'
    ? dompurify.default
    : dompurify.default(window);
  return (markdown: string) => Promise.resolve(purifier.sanitize(marked.parse(markdown, { async: false }) ?? ''));
}

export async function renderSpec(markdown: string): Promise<string> {
  renderer ??= await loadRenderer();
  return renderer(markdown);
}

export function SpecView({ markdown }: { markdown: string }): VNode {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    renderSpec(markdown)
      .then((sanitized) => {
        if (alive) setHtml(sanitized);
      })
      .catch(() => {
        if (alive) setHtml('<p>spec unavailable</p>');
      });
    return () => {
      alive = false;
    };
  }, [markdown]);

  if (html === null) return <p class="hint">loading spec…</p>;
  // Content is DOMPurify-sanitized before it ever reaches this sink.
  return <div class="spec-md" dangerouslySetInnerHTML={{ __html: html }}></div>;
}
