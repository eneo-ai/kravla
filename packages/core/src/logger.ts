// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal structural logging interface. A pino instance satisfies it as-is
 * (`logger.child({...})` included), so callers inject their pino logger
 * directly; the library itself never depends on pino. When no logger is
 * provided, everything routes to `noopLogger` and the crawler stays silent.
 */
export type LogFn = (obj: unknown, msg?: string, ...args: unknown[]) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
