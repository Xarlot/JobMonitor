import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// jsdom lacks WebCrypto; use Node's implementation so crypto.subtle works in tests.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// jsdom lacks the Popover API; declare it "supported" so @primer/react's
// TooltipV2 doesn't load @oddbird/popover-polyfill (which throws under jsdom).
if (typeof HTMLElement !== 'undefined' && !('popover' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'popover', {
    value: null,
    writable: true,
    configurable: true,
  });
  const proto = HTMLElement.prototype as unknown as Record<string, () => void>;
  proto.showPopover = () => {};
  proto.hidePopover = () => {};
  proto.togglePopover = () => {};
}

// jsdom gaps that @primer/react relies on at render time.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
const cssGlobal = globalThis as unknown as { CSS?: { supports?: (...a: unknown[]) => boolean } };
if (!cssGlobal.CSS) cssGlobal.CSS = {};
if (typeof cssGlobal.CSS.supports !== 'function') cssGlobal.CSS.supports = () => false;

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
}
