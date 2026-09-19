import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { FileSearch, ListChecks, Target } from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import { VerbIcon } from './verbIcon.tsx';
import { EvidenceView } from './EvidenceView.tsx';
import { CapabilityView } from './CapabilityView.tsx';
import type { EpicTreeStory } from './api.ts';

export function EpicDetail(props: {
  tree: { epic: { id: string; title: string }; stories: EpicTreeStory[] };
  onOpenStory(id: string): void;
  onClose(): void;
  project?: string;
  fetchEvidenceBundle?: Parameters<typeof EvidenceView>[0]['fetchEvidenceBundle'];
  fetchCapabilities?: Parameters<typeof CapabilityView>[0]['fetchCapabilities'];
  fetchCapabilityPreview?: Parameters<typeof CapabilityView>[0]['fetchCapabilityPreview'];
}): VNode {
  const { tree } = props;
  const done = tree.stories.filter((story) => story.lane === 'done').length;
  const [showEvidence, setShowEvidence] = useState(false);
  const [showCapabilities, setShowCapabilities] = useState(false);
  return (
    <Dialog open onClose={props.onClose} label={`epic detail: ${tree.epic.title}`}>
      <DialogHead
        title={tree.epic.title}
        meta={
          <span>
            <span class="type-epic"><Target size={12} /> epic</span>
            <span class="badge b-primary">{done}/{tree.stories.length} stories done</span>
          </span>
        }
        onClose={props.onClose}
      />
      <div style="margin-top:14px">
        {props.fetchEvidenceBundle !== undefined && props.project !== undefined ? (
          <button class="btn btn-outline" style="margin-bottom:12px" onClick={() => setShowEvidence(!showEvidence)}>
            <FileSearch size={13} /> Evidence
          </button>
        ) : null}
        {props.fetchCapabilities !== undefined && props.project !== undefined ? (
          <button class="btn btn-outline" style="margin-bottom:12px;margin-left:8px" onClick={() => setShowCapabilities(!showCapabilities)}>
            <ListChecks size={13} /> Capabilities
          </button>
        ) : null}
        {showEvidence && props.fetchEvidenceBundle !== undefined && props.project !== undefined ? (
          <div style="margin-bottom:14px">
            <EvidenceView project={props.project} epicId={tree.epic.id} fetchEvidenceBundle={props.fetchEvidenceBundle} />
          </div>
        ) : null}
        {showCapabilities && props.fetchCapabilities !== undefined && props.project !== undefined ? (
          <div style="margin-bottom:14px">
            <CapabilityView
              project={props.project}
              fetchCapabilities={props.fetchCapabilities}
              {...(props.fetchCapabilityPreview !== undefined ? { fetchCapabilityPreview: props.fetchCapabilityPreview } : {})}
            />
          </div>
        ) : null}
        {tree.stories.length === 0 ? (
          <p class="hint">no stories yet — deck story <span class="mono">{tree.epic.id}</span> &quot;&lt;title&gt;&quot; adds one</p>
        ) : (
          tree.stories.map((story: EpicTreeStory) => (
            <button
              key={story.id}
              class="story-row"
              style="display:flex;width:100%;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:8px;cursor:pointer"
              onClick={() => props.onOpenStory(story.id)}
            >
              {story.verb !== undefined ? (
                <span class="verb-chip"><VerbIcon verb={story.verb} size={12} /> {story.verb}</span>
              ) : (
                <span class="type-note">note</span>
              )}
              <span class="badge">{story.lane}</span>
              <span style="flex:1;overflow-wrap:anywhere">{story.title}</span>
              <span class="hint" style="margin:0">{story.tasks.done}/{story.tasks.total}</span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
