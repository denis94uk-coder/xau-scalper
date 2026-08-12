/**
 * DOM environment for component tests.
 *
 * Registered as a preload rather than inside each test file so that importing a
 * component never depends on which test happened to set up `document` first.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Recharts and the sidebar read layout APIs happy-dom does not implement.
// Without these a chart throws on mount and the page under test never renders.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// The pages subscribe to the server's SSE feed on mount. happy-dom has no
// EventSource, and without one every page throws before it renders anything.
if (!globalThis.EventSource) {
  globalThis.EventSource = class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onopen: ((e: Event) => void) | null = null;
    readyState = 1;
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return false;
    }
  } as unknown as typeof EventSource;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
