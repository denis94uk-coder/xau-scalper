/**
 * The live configuration, held in one place.
 *
 * WHY A STORE RATHER THAN A READ
 * The config is read on every engine tick, every API request and every
 * correlation rebuild. Re-parsing a JSON document from SQLite each time would
 * be wasteful, but the worse problem is consistency: a save landing halfway
 * through a signal run would let one asset be evaluated under the old rules and
 * the next under the new ones. So the document is cached, replaced atomically,
 * and readers hold a reference to an immutable snapshot for the duration of
 * whatever they are doing.
 *
 * Subscribers exist for the one thing that cannot be re-read on demand: timers
 * already scheduled at the old cadence.
 */

import {
  type AppConfig,
  CONFIG_KEY,
  defaultConfig,
  type ValidationIssue,
  validateConfig,
  withDefaults,
} from "../core/config";
import type { Db } from "./db";

export class ConfigError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map(i => `${i.path}: ${i.message}`.trim()).join("; "));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export class ConfigStore {
  private current: AppConfig;
  private listeners = new Set<(cfg: AppConfig) => void>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.current = this.read();
  }

  /**
   * Load from the database, falling back to defaults.
   *
   * A stored document that no longer validates does NOT stop the app: it is
   * repaired from the defaults section by section and reported. Refusing to
   * start because a setting drifted out of range would leave open positions
   * unmonitored, which is a far worse outcome than one reset knob.
   */
  private read(): AppConfig {
    const stored = this.db.getSetting<Partial<AppConfig>>(CONFIG_KEY);
    if (!stored) return defaultConfig();

    const merged = withDefaults(stored);
    const issues = validateConfig(merged);
    if (issues.length === 0) return merged;

    console.warn(
      "[config] stored configuration is invalid, falling back to defaults for:",
      issues.map(i => i.path).join(", "),
    );
    return defaultConfig();
  }

  /** The current snapshot. Treat as immutable. */
  get(): AppConfig {
    return this.current;
  }

  /**
   * Validate, persist and publish a new configuration.
   *
   * Throws ConfigError with every problem found, so the caller can hand the
   * whole list to a form rather than surfacing one field at a time.
   */
  save(input: unknown): AppConfig {
    const merged = withDefaults((input ?? {}) as Partial<AppConfig>);
    const issues = validateConfig(merged);
    if (issues.length > 0) throw new ConfigError(issues);

    this.db.setSetting(CONFIG_KEY, merged);
    this.current = merged;
    for (const fn of this.listeners) fn(merged);
    return merged;
  }

  /** Restore the shipped defaults. */
  reset(): AppConfig {
    return this.save(defaultConfig());
  }

  /** Notified after every successful save. Returns an unsubscribe function. */
  onChange(fn: (cfg: AppConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
