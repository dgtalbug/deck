import type { ComponentChildren, VNode } from 'preact';
import { RefreshCw } from 'lucide-preact';
import type { BoardApi, GitDigest } from './api.ts';

// Shared plumbing for the git panel sections: the action context passed down
// from GitPage (one runner, one busy map, one confirm queue) plus the guard
// mirror of core's ref-name pattern — the UI never invents a guard the core
// doesn't have (design D2).

export interface GitActionCtx {
  project: string;
  api: BoardApi;
  digest: GitDigest | null;
  busy: Record<string, boolean>;
  run(id: string, action: () => Promise<string>): Promise<void>;
  askConfirm(label: string, body: ComponentChildren, run: () => Promise<void>): void;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validBranchName(name: string): boolean {
  return (
    name.length <= 100 &&
    BRANCH_NAME.test(name) &&
    !name.includes('..') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('@{')
  );
}

export const CLEAN_HINT = 'requires a clean working tree — commit or stash first';

export function ActionBtn(props: {
  id: string;
  label: string;
  icon?: VNode;
  disabled?: boolean;
  hint?: string;
  busy: boolean;
  danger?: boolean;
  onClick(): void;
}): VNode {
  return (
    <button
      type="button"
      class={`btn btn-outline git-action${props.danger === true ? ' git-action-danger' : ''}`}
      data-action={props.id}
      disabled={props.disabled === true || props.busy}
      title={props.disabled === true ? props.hint : props.label}
      onClick={props.onClick}
    >
      {props.busy ? <RefreshCw size={12} class="is-spinning" /> : props.icon}
      {props.label}
    </button>
  );
}
