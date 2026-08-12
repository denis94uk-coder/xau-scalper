/**
 * Keep the test suite away from the operator's real MetaTrader terminal.
 *
 * The MT5 code auto-discovers a terminal whenever TEO_MT5_DIR is unset, which
 * is the right behaviour for the app and a hazard for tests: a suite that
 * clears the variable, or an async run that outlives the `afterEach` which
 * cleared it, will resolve the discovery path and write an order or history
 * request into the live install.
 *
 * That actually happened — a stray history request appeared under the real
 * terminal's `requests/`. The EA consumes that directory, so a test artifact
 * there is not litter, it is an instruction to a trading terminal.
 *
 * Pinning it here, as a preload, makes the safe value the default for every
 * file. A test that wants a real temp directory still sets its own; what it
 * can no longer do is leave the variable unset and fall through to discovery.
 */
const SAFE_DIR = "/nonexistent/teo-test-terminal";

process.env.TEO_MT5_DIR ??= SAFE_DIR;

// `delete process.env.TEO_MT5_DIR` in an afterEach would otherwise re-open the
// discovery path for anything still running. Deleting now restores the guard
// instead of clearing it.
const env = process.env as Record<string, string | undefined>;
const proxy = new Proxy(env, {
  deleteProperty(target, key) {
    if (key === "TEO_MT5_DIR") {
      target.TEO_MT5_DIR = SAFE_DIR;
      return true;
    }
    return Reflect.deleteProperty(target, key);
  },
});

Object.defineProperty(process, "env", {
  value: proxy,
  configurable: true,
  writable: true,
});
