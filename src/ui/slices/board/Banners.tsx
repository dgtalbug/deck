import type { VNode } from 'preact';
import { ShieldAlert } from 'lucide-preact';
import { exposedHost } from './mode.ts';

// Persistent banners: server-unreachable is rendered by Board (it owns the
// online signal); this component carries the non-loopback exposure warning
// (D-UI-009 — unauthenticated LAN access when the server runs --host).

export function Banners(props: { online: boolean }): VNode {
  void props; // online banner lives in Board next to the stale-view notice
  if (!exposedHost()) return <></>;
  return (
    <div class="callout c-danger banner" role="alert">
      <ShieldAlert size={15} />
      <div>
        <strong class="label">unauthenticated LAN exposure</strong>
        This page is served from a non-loopback host with no authentication. Anyone on this network can read and mutate
        the board. Rebind the server to 127.0.0.1 unless you meant this.
      </div>
    </div>
  );
}
