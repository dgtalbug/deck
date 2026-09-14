import type { EvidenceBundle } from './evidence-bundle-schema.ts';

function text(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function anchor(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-');
}

function link(label: string, id: string): string {
  return `[${text(label)}](#${anchor(id)})`;
}

function statusWords(record: EvidenceBundle['evidence'][number]): string {
  return `result=${record.result}; freshness=${record.freshness}; assurance=${record.assurance}`;
}

export function renderEvidenceBundleMarkdown(bundle: EvidenceBundle): string {
  const lines: string[] = [
    `# Evidence Bundle: ${text(bundle.project.name)}`,
    '',
    `- schema: ${bundle.schema}@${bundle.version}`,
    `- project: ${text(bundle.project.id)}`,
    `- snapshot: ${bundle.snapshot.digest}`,
    '',
    '## Epics',
    '',
  ];

  for (const epic of bundle.epics) {
    lines.push(`### ${text(epic.title)}`, '');
    lines.push(`<a id="${anchor(epic.id)}"></a>`);
    lines.push(`- id: ${text(epic.id)}`);
    lines.push(`- historical: ${epic.historical ? 'yes' : 'no'}`);
    lines.push(`- stories: ${epic.storyIds.map((id) => link(id, id)).join(', ') || 'none'}`, '');
    if (epic.criteria.length > 0) {
      lines.push('#### Epic Criteria', '');
      for (const criterion of epic.criteria) {
        lines.push(`- ${link(criterion.id, criterion.id)} ${text(criterion.title)} (${criterion.state})`);
      }
      lines.push('');
    }
  }

  lines.push('## Stories', '');
  for (const story of bundle.stories) {
    lines.push(`### ${text(story.title)}`, '');
    lines.push(`<a id="${anchor(story.id)}"></a>`);
    lines.push(`- id: ${text(story.id)}`);
    lines.push(`- parent: ${story.parentEpicId === null ? 'none' : link(story.parentEpicId, story.parentEpicId)}`);
    lines.push(`- lane: ${story.lane}`);
    lines.push(`- historical: ${story.historical ? 'yes' : 'no'}`);
    lines.push(`- scope: revision ${story.scopeRevision}, digest ${story.scopeDigest ?? 'unknown'}`);
    lines.push(`- spec: ${story.specVersion === null ? 'unknown' : `version ${story.specVersion}, checksum ${story.specChecksum ?? 'unknown'}`}`, '');
    if (story.criteria.length > 0) {
      lines.push('#### Criteria', '');
      for (const criterion of story.criteria) {
        lines.push(`<a id="${anchor(criterion.id)}"></a>`);
        const records = bundle.evidence.filter((record) => record.source.criterionId === criterion.id);
        const trace = records.length === 0 ? 'evidence=unknown' : records.map((record) => `${link(record.id, record.id)} (${statusWords(record)})`).join('; ');
        lines.push(`- ${text(criterion.id)} ${text(criterion.title)} (${criterion.state}); ${trace}`);
      }
      lines.push('');
    }
    if (story.tasks.length > 0) {
      lines.push('#### Tasks', '');
      for (const task of story.tasks) {
        lines.push(`<a id="${anchor(task.id)}"></a>`);
        lines.push(`- [${task.done ? 'x' : ' '}] ${text(task.title)} (${text(task.id)})`);
      }
      lines.push('');
    }
  }

  lines.push('## Evidence', '');
  for (const record of bundle.evidence) {
    lines.push(`### ${text(record.id)}`, '');
    lines.push(`<a id="${anchor(record.id)}"></a>`);
    lines.push(`- source card: ${link(record.source.cardId, record.source.cardId)}`);
    lines.push(`- source criterion: ${record.source.criterionId === null ? 'none' : link(record.source.criterionId, record.source.criterionId)}`);
    lines.push(`- ${statusWords(record)}`);
    lines.push(`- policy: ${record.policyVersion ?? 'unknown'}`);
    lines.push(`- command digest: ${record.commandDigest ?? 'omitted'}`);
    lines.push('');
  }

  lines.push('## Deliveries', '');
  for (const delivery of bundle.deliveries) {
    lines.push(`### ${text(delivery.id)}`, '');
    lines.push(`<a id="${anchor(delivery.id)}"></a>`);
    lines.push(`- card: ${link(delivery.cardId, delivery.cardId)}`);
    lines.push(`- state: ${delivery.state}`);
    lines.push(`- assurance: ${delivery.assurance}`);
    lines.push(`- link: ${delivery.prUrl ?? 'unavailable'}`);
    lines.push('');
  }

  lines.push('## Omissions', '');
  if (bundle.omissions.length === 0) {
    lines.push('- none');
  } else {
    for (const omission of bundle.omissions) {
      lines.push(`- ${text(omission.field)}: ${omission.reason}; ${text(omission.note)}`);
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
