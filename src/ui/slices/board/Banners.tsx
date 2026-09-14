import type { VNode } from 'preact';
import { ShieldAlert } from 'lucide-preact';
import { exposedHost } from './mode.ts';

export function Banners(props: { online: boolean }): VNode {
  void props; 
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
