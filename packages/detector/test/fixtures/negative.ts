/**
 * Negative fixtures: inputs that must produce ZERO findings.
 *
 * These are the false-positive traps — the realistic, secret-shaped but
 * harmless strings that a developer pastes into an LLM every day. If the
 * detector fires on any of these, adoption dies (plan Section 17).
 *
 * When tuning, this file is the one that matters most. Adding a new
 * vendor pattern is cheap; a new false positive is expensive.
 */

export interface NegativeFixture {
  name: string;
  text: string;
}

export const negativeFixtures: NegativeFixture[] = [
  {
    name: "Plain English prose",
    text: "Can you explain how the authentication flow works in this app? I want to understand the token refresh logic.",
  },
  {
    name: "Ordinary config values",
    text: "PORT=3000\nNODE_ENV=production\nLOG_LEVEL=debug\nMAX_RETRIES=5",
  },
  {
    name: "Git commit SHA",
    text: "The bug was introduced in commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
  },
  {
    name: "UUID in code",
    text: "const userId = '550e8400-e29b-41d4-a716-446655440000';",
  },
  {
    name: "MD5 hash",
    text: "The file checksum is d41d8cd98f00b204e9800998ecf8427e, verify it matches.",
  },
  {
    name: "SHA-256 digest",
    text: "integrity sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    name: "Localhost database URL, no password",
    text: "DATABASE_URL=postgresql://localhost:5432/myapp_dev",
  },
  {
    name: "Example/placeholder database URL",
    text: "DATABASE_URL=postgres://user:password@localhost:5432/example_db",
  },
  {
    name: "Lorem ipsum",
    text: "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor",
  },
  {
    name: "Base64 of a normal sentence",
    text: "Decode this: VGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZw==",
  },
  {
    name: "Tailwind class soup",
    text: "<div className='flex items-center justify-between px-4 py-2 rounded-lg shadow-md'>",
  },
  {
    name: "Import path / module identifier",
    text: "import { useState, useEffect, useCallback } from 'react-dom-server-renderer';",
  },
  {
    name: "AWS key but explicitly an example",
    text: "For example, your key looks like AKIAIOSFODNN7EXAMPLE — replace it with yours.",
  },
  {
    name: "Placeholder API key",
    text: "OPENAI_API_KEY=your-api-key-here",
  },
  {
    name: "Redacted value",
    text: "API_KEY=REDACTED in the logs we ship to the dashboard",
  },
  {
    name: "40-char base64 blob with NO AWS context",
    text: "The CI artifact fingerprint is tB6yQ2nW9kP4mZ7vL1cF8dG3hX5uR0aE2iO6sJ4q after the build step.",
  },
  {
    name: "Git SHA-1 next to the word aws (hash, not a key)",
    text: "The aws deploy regressed at commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b yesterday.",
  },
  {
    name: "Example AWS secret key placeholder",
    text: "Replace the aws example secret EXAMPLEKEYwJ8xK2pQ7nR4tV9sL1mB3cF6dG0hY5 with your own.",
  },
  {
    name: "Long hex color list",
    text: "colors: #ff5733 #33ff57 #3357ff #f0f0f0 #1a1a1a #cccccc #abcdef",
  },
  {
    name: "CSS / minified-looking but harmless",
    text: ".btn{padding:8px 16px;margin:0 auto;border-radius:4px;background:#eee}",
  },
  {
    name: "Numeric ID sequence",
    text: "order ids: 100023456789 100023456790 100023456791 100023456792",
  },
  {
    name: "File path",
    text: "The error log is at /var/log/application/staging/2024-06-01-error.log",
  },
  {
    name: "Semver and package names",
    text: "Upgrade typescript@5.7.2 and @types/node@22.10.1 then rebuild.",
  },
];
