// Short slug ids: title slug + random base36 suffix, readable in
// specs/changes/<verb>-<id>/ directory names.
export function newCardId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 3)
    .join('-')
    .slice(0, 24);
  const suffix = Math.random().toString(36).slice(2, 6);
  return slug.length > 0 ? `${slug}-${suffix}` : `card-${suffix}`;
}

export function newTaskId(): string {
  return `t-${Math.random().toString(36).slice(2, 8)}`;
}
