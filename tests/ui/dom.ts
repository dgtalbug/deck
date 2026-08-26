// DOM harness for UI tests: Bun has no DOM, so each test file installs a
// fresh happy-dom window as the global surface (spike S1 recipe — the
// GlobalRegistrator export is gone in happy-dom v20 and GlobalWindow does
// not propagate under Bun).
import { Window } from 'happy-dom';
import { render } from 'preact';
import type { VNode } from 'preact';

export type TestWindow = Window;

// Bun-native platform APIs that must survive the copy — happy-dom's fetch
// cannot do real HTTP, and its URL/AbortController break the server clients.
const KEEP_BUN = new Set([
  'fetch', 'Request', 'Response', 'Headers', 'Blob', 'File', 'FormData',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'EventSource', 'crypto', 'performance',
  'queueMicrotask', 'structuredClone', 'atob', 'btoa',
]);

// JS intrinsics happy-dom also defines on its window — copying them would
// silently swap the runtime's Number/Array/Promise out from under Bun.
const KEEP_INTRINSIC = new Set([
  'globalThis', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Function',
  'Promise', 'Symbol', 'Proxy', 'Reflect', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError',
  'ReferenceError', 'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'BigInt',
  'Intl', 'Infinity', 'NaN', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'require', 'module', 'exports',
]);

export function installDom(url = 'http://localhost/'): TestWindow {
  // A real origin is required — history.pushState is a no-op on about:blank.
  const win = new Window({ url });
  for (const key of Object.getOwnPropertyNames(win)) {
    if (KEEP_BUN.has(key) || KEEP_INTRINSIC.has(key)) continue;
    // DOM + event classes come from happy-dom (consistency: elements and
    // events must share one prototype chain); everything else copies over
    // whatever Bun already defined.
    try {
      (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
    } catch {
      // accessors without getters cannot be copied — skip
    }
  }
  return win;
}

/** Minimal structural element type — accepts lib.dom and happy-dom elements. */
export interface Dispatchable {
  dispatchEvent(event: unknown): boolean;
}

export function renderUi(vnode: VNode): { win: TestWindow; container: Dispatchable } {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  render(vnode, container);
  return { win, container };
}

// Fire a real keyboard event on an element (walkthrough tests).
export function press(win: TestWindow, el: Dispatchable, key: string, shift = false): void {
  el.dispatchEvent(
    new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey: shift }),
  );
}
