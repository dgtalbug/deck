import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { CapabilityPreviewView, CapabilityStatementView } from './api.ts';

export function CapabilityView(props: {
  project: string;
  fetchCapabilities: (project: string) => Promise<{ statements: CapabilityStatementView[] }>;
  fetchCapabilityPreview?: (project: string, previewId: string) => Promise<CapabilityPreviewView>;
}): VNode {
  const [statements, setStatements] = useState<CapabilityStatementView[] | null>(null);
  const [previewId, setPreviewId] = useState('');
  const [preview, setPreview] = useState<CapabilityPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStatements(null);
    props.fetchCapabilities(props.project)
      .then((result) => {
        if (alive) setStatements(result.statements);
      })
      .catch(() => {
        if (alive) setStatements([]);
      });
    return () => {
      alive = false;
    };
  }, [props.project]);

  const loadPreview = () => {
    if (props.fetchCapabilityPreview === undefined || previewId.trim() === '') return;
    setPreview(null);
    setPreviewError(null);
    props.fetchCapabilityPreview(props.project, previewId.trim())
      .then((result) => setPreview(result))
      .catch(() => setPreviewError('preview unavailable'));
  };

  return (
    <div class="capability-panel">
      <div class="row-meta" style="align-items:center;margin-bottom:10px">
        <strong class="label">capabilities</strong>
        <span class="hint" style="margin:0">local derived view</span>
      </div>
      {statements === null ? (
        <p class="hint">loading capabilities…</p>
      ) : statements.length === 0 ? (
        <p class="hint">no applied capability statements</p>
      ) : (
        <div>
          {statements.map((statement) => (
            <div class="story-row" key={`${statement.capabilityId}:${statement.statementId}`}>
              <div class="row-meta" style="margin-bottom:4px">
                <span class="badge b-primary">{statement.state}</span>
                <span class="mono">{statement.capabilityId}</span>
                <span class={`badge${statement.sourceDrift === 'none' ? '' : ' b-warning'}`}>{statement.sourceDrift}</span>
              </div>
              <div>{statement.text}</div>
              <div class="hint" style="margin-top:4px">
                {statement.sourceCardId} / {statement.sourceCriterionId} r{statement.sourceScopeRevision} · {statement.evidenceId} · {statement.deliveryId}
              </div>
            </div>
          ))}
        </div>
      )}
      {props.fetchCapabilityPreview !== undefined ? (
        <div style="margin-top:12px">
          <div class="row-meta" style="align-items:end">
            <label style="display:flex;flex:1;flex-direction:column;gap:4px">
              <span class="label">preview id</span>
              <input class="input" value={previewId} onInput={(event) => setPreviewId((event.currentTarget as HTMLInputElement).value)} />
            </label>
            <button class="btn btn-outline" type="button" onClick={loadPreview}>Load preview</button>
          </div>
          {previewError !== null ? <p class="hint">{previewError}</p> : null}
          {preview !== null ? (
            <div style="margin-top:10px">
              <div class="row-meta">
                <span class="badge">{preview.preview.changes.length} changes</span>
                <span class={`badge${preview.preview.conflicts.length > 0 ? ' b-warning' : ' b-primary'}`}>
                  {preview.preview.conflicts.length} conflicts
                </span>
              </div>
              {preview.preview.conflicts.map((conflict) => (
                <div class="callout c-warn" key={conflict.deltaId} style="margin-top:8px">
                  <div>
                    <strong class="label">{conflict.deltaId}</strong>
                    {conflict.reason}
                  </div>
                </div>
              ))}
              {preview.preview.changes.map((change) => (
                <div class="story-row" key={change.deltaId}>
                  <div class="row-meta">
                    <span class="badge">{change.op}</span>
                    <span class="mono">{change.statementId}</span>
                  </div>
                  <div class="hint" style="margin-top:4px">{change.after ?? change.before ?? 'removed'}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
