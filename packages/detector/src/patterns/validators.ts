/**
 * Registry of named structural validators for tier_2 patterns.
 *
 * A tier_2 definition may name a validator via `structuralValidator`. The
 * compiler resolves the name against this registry (failing the build on an
 * unknown name) and the scanner runs it on the matched value, dropping the
 * finding when it returns false. This lets a structural pattern reject shapes
 * that match its regex but fail a deeper check, while keeping the JSON
 * definitions fully declarative.
 *
 * PURE module (no DOM, no Node) — it ships in the runtime bundle.
 *
 * No validators are wired to any current pattern: every migrated pattern is
 * precise on its regex alone. This registry is the extension point for the
 * patterns that will need one (it exists so the engine is complete, not to
 * change any existing detection behaviour).
 */

/** A structural validator: returns false to reject a regex match. */
export type StructuralValidator = (value: string) => boolean;

export const validators: Readonly<Record<string, StructuralValidator>> = {
  // (intentionally empty — see module comment)
};
