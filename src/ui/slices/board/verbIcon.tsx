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
  if (props.verb === undefined) return null; 
  const Icon = VERB_ICONS[props.verb as (typeof VERBS)[number]] ?? CircleDot;
  return <Icon size={props.size ?? 12} />;
}
