// Branch slug law (shared by the verb engine, the review gate, and the
// next digest): deterministic per card, so any surface can re-derive the
// build branch from the card alone.
import type { VerbName, VerbItem } from '../board/types.ts';

function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
    .slice(0, 32);
}

export function branchFor(card: Pick<VerbItem, 'id' | 'title'>, verb: VerbName): string {
  const slug = titleSlug(card.title);
  return slug.length > 0 ? `${verb}/${card.id}-${slug}` : `${verb}/${card.id}`;
}
