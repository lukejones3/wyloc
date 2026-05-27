import type { DetectorConfig } from "./types.js";

/**
 * Context keywords for Layer 4 gating. Proximity to one of these raises
 * confidence; absence of any lowers it. From plan Section 5, Layer 4.
 */
export const CONTEXT_KEYWORDS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "apikey",
  "api_key",
  "api-key",
  "access_key",
  "accesskey",
  "private_key",
  "client_secret",
  "bearer",
  "session",
  "cookie",
  "db",
  "database",
  "connection",
  "conn_str",
  "dsn",
];

/** Markers that strongly imply a production environment. */
export const PROD_MARKERS: readonly string[] = [
  "prod",
  "production",
  "live",
  "release",
];

/** Markers that strongly imply a non-production environment. */
export const DEV_MARKERS: readonly string[] = [
  "dev",
  "development",
  "staging",
  "stage",
  "test",
  "testing",
  "sandbox",
  "local",
  "localhost",
  "demo",
  "example",
  "sample",
  "mock",
  "dummy",
  "fake",
  "placeholder",
];

/**
 * Default allowlist substrings. A candidate that contains or is adjacent
 * to one of these is suppressed (plan Section 5, Layer 5).
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "example.com",
  "example.org",
  "example",
  "your-",
  "xxxx",
  "XXXX",
  "<your",
  "placeholder",
  "changeme",
  "change-me",
  "redacted",
  "REDACTED",
  "dummy",
  "notreal",
  "foobar",
];

export const defaultConfig: DetectorConfig = {
  entropyThreshold: 4.0,
  entropyMinLength: 20,
  requireContextForEntropy: true,
  suppressedRuleIds: [],
  allowlist: [...DEFAULT_ALLOWLIST],
  contextWindow: 64,
};

/** Merge a partial user config over the defaults. */
export function resolveConfig(partial?: Partial<DetectorConfig>): DetectorConfig {
  if (!partial) return { ...defaultConfig, allowlist: [...DEFAULT_ALLOWLIST] };
  return {
    ...defaultConfig,
    ...partial,
    allowlist: [
      ...DEFAULT_ALLOWLIST,
      ...(partial.allowlist ?? []),
    ],
  };
}
