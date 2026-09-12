import { describe, expect, test } from 'bun:test';
import { nonLoopbackWarning } from '../../src/server/serve.ts';

// The paired file for the "Host Bind Warns Loud" requirement: a non-loopback
// --host exposes unauthenticated git writes — the warning fires before the
// server ever listens.
describe('non-loopback bind warning', () => {
  test('loopback hosts stay silent', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(nonLoopbackWarning(host)).toBeNull();
    }
  });

  test('non-loopback hosts get a loud unauthenticated-writes warning', () => {
    const warning = nonLoopbackWarning('0.0.0.0');
    expect(warning).not.toBeNull();
    expect(warning!).toContain('0.0.0.0');
    expect(warning!).toContain('UNAUTHENTICATED');
    expect(warning!).toContain('git routes');
  });

  test('serveMain routes its bind through the warning (source contract)', async () => {
    const source = await Bun.file('src/server/serve.ts').text();
    expect(source).toContain('nonLoopbackWarning(server.hostname');
  });
});
