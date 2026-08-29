import { describe, expect, test } from 'bun:test';
import { withSpinner } from '../../src/cli/spin.ts';

function io() {
  const err: string[] = [];
  return { err, io: { err: (t: string) => err.push(t) } };
}

describe('wait feedback (identity §5)', () => {
  test('non-TTY is totally silent, even past the delay', async () => {
    const { err, io: spin } = io();
    const value = await withSpinner({ isatty: false, dumb: false, io: spin }, 'opening board…', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 42;
    });
    expect(value).toBe(42);
    expect(err).toEqual([]);
  });

  test('work under 120 ms never prints a spinner line', async () => {
    const { err, io: spin } = io();
    await withSpinner({ isatty: true, dumb: false, io: spin }, 'opening board…', async () => 'fast');
    expect(err).toEqual([]);
  });

  test('past 120 ms on a TTY the spinner prints and is erased', async () => {
    const { err, io: spin } = io();
    await withSpinner({ isatty: true, dumb: false, io: spin }, 'opening board…', async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
      return 'done';
    });
    expect(err.join('')).toContain('⠋ opening board…');
    expect(err.join('')).toContain('\r\x1b[2K');
  });

  test('TERM=dumb gets a single static line, only past 2 s', async () => {
    const { err, io: spin } = io();
    await withSpinner({ isatty: true, dumb: true, io: spin }, 'opening board…', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'quick';
    });
    expect(err).toEqual([]);
  });

  test('erase happens even when the work throws', async () => {
    const { err, io: spin } = io();
    await expect(
      withSpinner({ isatty: true, dumb: false, io: spin }, 'opening board…', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(err.join('')).toContain('\r\x1b[2K');
  });
});
