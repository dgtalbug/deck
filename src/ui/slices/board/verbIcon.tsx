import type { VNode } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import {
  Bug,
  CircleDot,
  ClipboardList,
  FileText,
  FlaskConical,
  Gauge,
  Hammer,
  Paintbrush,
  Recycle,
  Sparkles,
  Undo2,
  Workflow,
} from 'lucide-preact';
import { VERBS, type Verb } from './api.ts';

// One Verb → icon mapping, consumed everywhere a verb appears (Card, TodoView
// rows, CardDetail, GroomForm). Per-icon lucide-preact imports keep
// tree-shaking honest — the barrel import would pull the whole icon set.

type IconComponent = LucideIcon;

export const VERB_ICONS: Record<Verb, IconComponent> = {
  feat: Sparkles,
  fix: Bug,
  docs: FileText,
  style: Paintbrush,
  refactor: Recycle,
  perf: Gauge,
  test: FlaskConical,
  build: Hammer,
  ci: Workflow,
  chore: ClipboardList,
  revert: Undo2,
};

export function VerbIcon(props: { verb: Verb | undefined; size?: number }): VNode | null {
  if (props.verb === undefined) return null; // callers gate on card kind; keep the guard local
  // User-registered verbs have no mapping — a dot beats a crash or a blank.
  const Icon = VERB_ICONS[props.verb as (typeof VERBS)[number]] ?? CircleDot;
  return <Icon size={props.size ?? 12} />;
}
