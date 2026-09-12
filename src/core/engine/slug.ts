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
  // Four-word law (v0.7.1): verb/slug, the conventional-commit shape — the
  // title is said exactly once (the card id used to duplicate it). Git owns
  // uniqueness: a same-titled second card refuses at start with a retitle
  // hint (verbs.ts). Empty titles fall back to the id for uniqueness.
  return slug.length > 0 ? `${verb}/${slug}` : `${verb}/${card.id}`;
}
