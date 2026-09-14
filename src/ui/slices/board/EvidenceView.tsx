import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { EvidenceBundle } from '../../../core/board/evidence-bundle-schema.ts';
import { SpecView } from './specView.tsx';

export function EvidenceView(props: {
  project: string;
  epicId: string;
  fetchEvidenceBundle: (project: string, epicId: string) => Promise<EvidenceBundle>;
}): VNode {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setMarkdown(null);
    props.fetchEvidenceBundle(props.project, props.epicId)
      .then(async (bundle) => {
        const { renderEvidenceBundleMarkdown } = await import('../../../core/board/evidence-bundle-render.ts');
        if (alive) setMarkdown(renderEvidenceBundleMarkdown(bundle));
      })
      .catch(() => {
        if (alive) setMarkdown('# Evidence unavailable\n\nThe local evidence bundle could not be loaded.');
      });
    return () => {
      alive = false;
    };
  }, [props.project, props.epicId]);

  if (markdown === null) return <p class="hint">loading evidence…</p>;
  return <SpecView markdown={markdown} />;
}
