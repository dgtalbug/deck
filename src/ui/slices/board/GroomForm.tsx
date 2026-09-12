import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { ArrowRight, Check, StickyNote, X } from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import { TextField } from '../../components/TextField.tsx';
import { VERBS, type GroomInput, type SpecTypeView, type Verb } from './api.ts';
import { VerbIcon } from './verbIcon.tsx';

// Manual groom form collecting EXACTLY the GroomProposal fields
// (proposedVerb/refinedTitle/research/specDeltas/tasks/openQuestions).
// Open questions gate the accept; reject is inert — no request, the note
// stays untouched in todo (the groom agent skill is a separate deliverable).

const EMPTY: GroomInput = {
  proposedVerb: 'feat',
  refinedTitle: '',
  research: { codebaseFindings: [] },
  specDeltas: [],
  tasks: [],
  openQuestions: [],
};

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// specDeltas textarea format: `ADDED|MODIFIED|REMOVED: requirement :: text`
function parseDeltas(text: string): GroomInput['specDeltas'] {
  return parseLines(text).flatMap((line) => {
    const match = /^(ADDED|MODIFIED|REMOVED):\s*([^:]+)::\s*(.+)$/.exec(line);
    if (match === null) return [];
    return [{ op: match[1] as 'ADDED' | 'MODIFIED' | 'REMOVED', requirement: match[2]!.trim(), text: match[3]!.trim() }];
  });
}

function stringifyDeltas(deltas: GroomInput['specDeltas']): string {
  return deltas.map((delta) => `${delta.op}: ${delta.requirement} :: ${delta.text}`).join('\n');
}

export function GroomForm(props: {
  noteTitle: string;
  initial?: GroomInput;
  /** 'groom' converts a note (POST); 'edit' re-edits a groomed item (PATCH) */
  mode?: 'groom' | 'edit';
  /** registry rows — the form's section fields follow the selected type */
  types?: SpecTypeView[];
  fetchTypes?: (project: string) => Promise<SpecTypeView[]>;
  project?: string;
  onAccept(input: GroomInput): void;
  onReject(): void;
}): VNode {
  const [input, setInput] = useState<GroomInput>(props.initial ?? EMPTY);
  const [types, setTypes] = useState<SpecTypeView[]>(props.types ?? []);
  // Registry rows arrive async when only the fetcher is wired — the form
  // stays usable without them (no sections = the pre-registry look).
  useEffect(() => {
    if (props.types !== undefined || props.fetchTypes === undefined || props.project === undefined) return;
    let alive = true;
    props.fetchTypes(props.project).then((rows) => alive && setTypes(rows)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [props.project]);
  const [sectionText, setSectionText] = useState<Record<string, string>>(props.initial?.research.sections ?? {});
  const selected = types.find((type) => type.id === input.proposedVerb);
  const sections = selected?.sections ?? [];
  const missingRequiredLabels = sections
    .filter((section) => section.alwaysRequired === true)
    .filter((section) => (sectionText[section.id] ?? '').trim() === '')
    .map((section) => section.label);
  const [story, setStory] = useState(props.initial?.research.story ?? '');
  const [findings, setFindings] = useState((props.initial?.research.codebaseFindings ?? []).join('\n'));
  const [blast, setBlast] = useState((props.initial?.research.blastRadius ?? []).join('\n'));
  const [deltas, setDeltas] = useState(stringifyDeltas(props.initial?.specDeltas ?? []));
  const [tasks, setTasks] = useState((props.initial?.tasks ?? []).join('\n'));
  const [questions, setQuestions] = useState((props.initial?.openQuestions ?? []).join('\n'));
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [touched, setTouched] = useState(false);

  const editing = props.mode === 'edit';
  const openQuestions = parseLines(questions);
  const unanswered = openQuestions.filter((_, index) => (answers[index] ?? '').trim() === '');
  const titleError = touched && input.refinedTitle.trim() === '' ? 'refined title is required' : undefined;
  const sectionError =
    touched && missingRequiredLabels.length > 0
      ? `fill the required section${missingRequiredLabels.length > 1 ? 's' : ''}: ${missingRequiredLabels.join(', ')}`
      : undefined;
  const gateError =
    !editing && touched && unanswered.length > 0
      ? `answer the open question${unanswered.length > 1 ? 's' : ''} to accept — ${unanswered.length} unanswered`
      : undefined;

  const accept = () => {
    setTouched(true);
    const filledSections: Record<string, string> = {};
    for (const section of sections) {
      const text = (sectionText[section.id] ?? '').trim();
      if (text !== '') filledSections[section.id] = text;
    }
    const missingRequired = sections
      .filter((section) => section.alwaysRequired === true)
      .filter((section) => (sectionText[section.id] ?? '').trim() === '')
      .map((section) => section.label);
    if (input.refinedTitle.trim() === '' || (!editing && unanswered.length > 0) || missingRequired.length > 0) return;
    props.onAccept({
      ...input,
      refinedTitle: input.refinedTitle.trim(),
      research: {
        codebaseFindings: parseLines(findings),
        ...(story.trim() !== '' ? { story: story.trim() } : {}),
        ...(props.initial?.research.rca !== undefined ? { rca: props.initial.research.rca } : {}),
        ...(blast.trim() !== '' ? { blastRadius: parseLines(blast) } : {}),
        ...(Object.keys(filledSections).length > 0 ? { sections: filledSections } : {}),
      },
      specDeltas: parseDeltas(deltas),
      tasks: parseLines(tasks),
      // the wire contract carries only UNANSWERED questions — the server
      // rejects any non-empty list, so answered ones drop out here
      openQuestions: [],
    });
  };

  return (
    <Dialog open onClose={props.onReject} label={`${editing ? 'edit' : 'groom'}: ${props.noteTitle}`}>
      <DialogHead
        title={editing ? `Edit: “${props.noteTitle}”` : `Groom: “${props.noteTitle}”`}
        meta={
          <span>
            <span class="badge" style="border:1px solid var(--border);color:var(--muted)">
              <StickyNote size={11} /> note
            </span>
            <ArrowRight size={12} class="ic-primary" />
            <span class="verb-chip">{input.proposedVerb}</span>
          </span>
        }
        onClose={props.onReject}
      />

      <div class="form-grid" style="margin-top:14px">
        <div>
          <label for="groom-verb">proposed verb</label>
          <div class="row-meta">
            <select
              id="groom-verb"
              value={input.proposedVerb}
              onChange={(event) => setInput({ ...input, proposedVerb: (event.target as HTMLSelectElement).value as Verb })}
            >
              {VERBS.map((verb) => (
                <option key={verb} value={verb}>
                  {verb}
                </option>
              ))}
            </select>
            <span class="verb-chip" aria-hidden="true">
              <VerbIcon verb={input.proposedVerb} size={13} /> {input.proposedVerb}
            </span>
          </div>
        </div>
        <TextField
          id="groom-title"
          label="refined title"
          value={input.refinedTitle}
          onInput={(value) => setInput({ ...input, refinedTitle: value })}
          error={titleError}
          placeholder="one line — what this becomes"
        />
        <TextField
          id="groom-story"
          label="story — what this is and why (epic-style narrative; ```mermaid fences welcome)"
          value={story}
          onInput={setStory}
          multiline
          placeholder={'A rider wants … so this card adds … GitHub renders any mermaid diagram below.'}
        />
        <TextField
          id="groom-findings"
          label="research — codebase findings (one per line)"
          value={findings}
          onInput={setFindings}
          multiline
          mono
          placeholder={'evidence-cited findings from the repo'}
        />
        <TextField
          id="groom-blast"
          label="blast radius — existing files/behaviors touched (one per line)"
          value={blast}
          onInput={setBlast}
          multiline
          mono
          placeholder={'src/core/board/groom.ts — materializeSpec template'}
        />
        {sections.map((section) => (
          <TextField
            id={`groom-section-${section.id}`}
            label={`${section.label}${section.alwaysRequired === true ? ' (required)' : section.requiredAboveRadius !== undefined ? ` (required at blast radius ${section.requiredAboveRadius}+)` : ''}`}
            value={sectionText[section.id] ?? ''}
            onInput={(value) => setSectionText((prev) => ({ ...prev, [section.id]: value }))}
            multiline
            placeholder={section.alwaysRequired === true ? 'required by the spec type — the groom refuses without it' : 'optional section from the spec type'}
          />
        ))}
        {sectionError !== undefined ? (
          <p role="alert" style="color:var(--warning);font-size:12.5px;margin:0">
            {sectionError}
          </p>
        ) : null}
        <TextField
          id="groom-deltas"
          label="spec deltas (ADDED|MODIFIED|REMOVED: requirement :: text)"
          value={deltas}
          onInput={setDeltas}
          multiline
          mono
          placeholder={'ADDED: board ui :: renders five lanes'}
        />
        <p class="hint" data-testid="minimal-spec-hint" style="margin:0">
          spec + research say <strong>what</strong> we are building and what we found; tasks stay the only
          technical part. Minimal spec (title + tasks) stays valid — story, findings, deltas may be empty.
        </p>
        <TextField
          id="groom-tasks"
          label="tasks — technical, code-level steps only (one per line)"
          value={tasks}
          onInput={setTasks}
          multiline
          mono
          placeholder={'extract helper in groom.ts\nextend renderCardSpec git block'}
        />
        {!editing ? (
          <TextField
            id="groom-questions"
            label="open questions (one per line — must be answered to accept)"
            value={questions}
            onInput={setQuestions}
            multiline
            placeholder={'should the done lane cap its history?'}
          />
        ) : null}
      </div>

      {!editing && openQuestions.length > 0 ? (
        <div style="margin-top:6px">
          {openQuestions.map((question, index) => (
            <div class="q-item" key={index} style="margin-bottom:8px">
              <div style="flex:1">
                {question}
                <TextField
                  id={`answer-${index}`}
                  label="answer"
                  value={answers[index] ?? ''}
                  onInput={(value) => setAnswers({ ...answers, [index]: value })}
                  placeholder="your answer unlocks accept"
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {gateError !== undefined ? (
        <p role="alert" style="color:var(--warning);font-size:12.5px;margin-top:4px">
          {gateError}
        </p>
      ) : null}

      <div class="dialog-actions">
        <button class="btn btn-primary" onClick={accept} aria-disabled={unanswered.length > 0}>
          <Check size={13} /> {editing ? 'Save changes' : 'Accept → groomed'}
        </button>
        <button class="btn btn-ghost" onClick={props.onReject}>
          <X size={13} /> {editing ? 'Cancel — keep as is' : 'Reject — leave note untouched'}
        </button>
      </div>
      <p class="hint" style="margin-top:10px">
        {editing
          ? 'saving rewrites the groomed item in place — same card, same spec path; task checkmarks survive by matching titles.'
          : <>
              accept converts this note into a <span class="mono">{input.proposedVerb}</span> item at the bottom of the groomed
              queue (same id); reject sends nothing.
            </>}
      </p>
    </Dialog>
  );
}
