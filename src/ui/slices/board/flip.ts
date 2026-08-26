// FLIP reorder animation (D-UI-005, zero new deps): the drag-drop caller
// snapshots card rects BEFORE the store applies the intent, then after the
// response lands plays invert-transform + transition back to zero. Only
// user-initiated moves animate this way — remote SSE moves get the lighter
// .is-remote-in fade-slide cue instead. DOM-less test runtimes have zero
// rects, so every step degrades to a no-op.

export type FlipSnapshot = Map<string, { top: number; left: number }>;

function cardElements(root: HTMLElement | null): { id: string; el: HTMLElement }[] {
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLElement>('.kcard[data-id]')].map((el) => ({
    id: el.getAttribute('data-id') ?? '',
    el,
  }));
}

export function captureFlip(root: HTMLElement | null): FlipSnapshot {
  const snapshot: FlipSnapshot = new Map();
  for (const { id, el } of cardElements(root)) {
    const rect = el.getBoundingClientRect();
    snapshot.set(id, { top: rect.top, left: rect.left });
  }
  return snapshot;
}

export function playFlip(root: HTMLElement | null, before: FlipSnapshot): void {
  if (before.size === 0) return;
  const raf: (cb: () => void) => void =
    typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => cb();
  raf(() => {
    raf(() => {
      for (const { id, el } of cardElements(root)) {
        const first = before.get(id);
        if (first === undefined) continue;
        const rect = el.getBoundingClientRect();
        const dy = first.top - rect.top;
        const dx = first.left - rect.left;
        if (dx === 0 && dy === 0) continue;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.transition = 'none';
        // force layout so the invert transform is the animation start point
        void el.offsetHeight;
        el.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)';
        el.style.transform = '';
        el.addEventListener('transitionend', () => {
          el.style.transition = '';
        }, { once: true });
      }
    });
  });
}
