// Short slug ids: bare title slug, readable in specs/changes/<verb>-<id>/
// directory names. Uniqueness is collision-numbered Jira-style — the bare
// slug wins, and only a same-slug second card gets -2, -3, ... (the
// random-suffix ids this replaced live on in pre-existing cards).
export function newCardId(title: string, taken?: (id: string) => boolean): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 3)
    .join('-')
    .slice(0, 24);
  const base = slug.length > 0 ? slug : 'card';
  if (taken === undefined) return base;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

export function newTaskId(): string {
  return `t-${Math.random().toString(36).slice(2, 8)}`;
}
