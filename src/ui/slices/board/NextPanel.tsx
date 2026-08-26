import { useEffect } from 'preact/hooks';
import type { VNode } from 'preact';
import { Gauge, Send } from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import type { BoardStore } from './store.ts';

// deck next panel: calls GET /<project>/next and renders the NextDigest —
// or its wipBlockedBy outcome (the most-advanced active card's remaining
// tasks) without leaving the board.

export function NextPanel(props: { store: BoardStore; open: boolean; onClose(): void }): VNode {
  const { store } = props;

  useEffect(() => {
    if (props.open) void store.fetchNext();
  }, [props.open, store]);

  if (!props.open) return <></>;
  const digest = store.next.value;

  return (
    <Dialog open onClose={props.onClose} label="deck next digest">
      <DialogHead title="deck next" meta={<span class="badge b-primary"><Send size={11} /> context digest</span>} onClose={props.onClose} />
      {digest === null ? (
        <p class="hint" style="margin-top:12px">nothing next — the queue is empty or the server is unreachable</p>
      ) : (
        <div style="margin-top:12px">
          {digest.wipBlockedBy !== undefined ? (
            <div class="callout c-warn">
              <Gauge size={15} />
              <div>
                <strong class="label">WIP limit reached</strong>
                deck next returns the remaining tasks of the most-advanced active card instead of starting new work —
                finish <code>{digest.wipBlockedBy}</code> first.
              </div>
            </div>
          ) : null}
          <p style="margin:10px 0 4px">
            <strong>{digest.title}</strong>{' '}
            {digest.verb !== undefined ? <span class="verb-chip">{digest.verb}</span> : null}{' '}
            <span class="hint mono">{digest.cardId}</span>
          </p>
          <pre class="code" style="max-height:46vh;overflow:auto">{digest.context}</pre>
        </div>
      )}
    </Dialog>
  );
}
