import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { App } from '../../src/ui/app.tsx';
import { route } from '../../src/ui/router.ts';
import { installDom } from './dom.ts';

// Boot splash (brand §3 spade draw): shown for BOOT_MS on boot into the
// workspace, never on project routes, and never again after client nav.

function stubProjects(): void {
  globalThis.fetch = (async () =>
    new Response('{"projects":[]}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

// The router signal is module-global — restore it and fetch so later files
// in the same Bun process see the default workspace state.
const realFetch = globalThis.fetch;
afterEach(() => {
  route.value = { project: null, view: 'kanban', card: null };
  globalThis.fetch = realFetch;
});

describe('boot splash', () => {
  test('home boot shows the spade splash, then home after 2 s', async () => {
    const win = installDom('http://localhost/');
    route.value = { project: null, view: 'kanban', card: null };
    stubProjects();
    const host = win.document.createElement('div');
    win.document.body.appendChild(host as Parameters<typeof win.document.body.appendChild>[0]);
    render(<App />, host);

    const splash = host.querySelector('.boot-splash');
    expect(splash).not.toBeNull();
    expect(splash!.getAttribute('role')).toBe('status');

    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(host.querySelector('.boot-splash')).toBeNull();
    expect(host.querySelector('.topbar')).not.toBeNull();
  });

  test('project boot skips the splash entirely', async () => {
    const win = installDom('http://localhost/myproj/');
    route.value = { project: 'myproj', view: 'kanban', card: null };
    const host = win.document.createElement('div');
    win.document.body.appendChild(host as Parameters<typeof win.document.body.appendChild>[0]);
    render(<App />, host);
    expect(host.querySelector('.boot-splash')).toBeNull();
  });
});
