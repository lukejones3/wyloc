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

/** Strip every non-digit so a separated number ("4111 1111…") collapses to digits. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/**
 * Luhn (mod-10) checksum. This is the real gate for credit cards: a digit
 * string that matches a card shape but fails Luhn is almost certainly NOT a
 * card (order id, tracking number, …), so we reject it.
 */
export function luhnValid(digits: string): boolean {
  if (digits.length === 0) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True if the digit string opens with a major-network card prefix + valid length. */
function hasCardPrefix(d: string): boolean {
  const len = d.length;
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  if (d[0] === "4") return len === 13 || len === 16 || len === 19; // Visa
  if (p2 === 34 || p2 === 37) return len === 15; // American Express
  if (p2 >= 51 && p2 <= 55) return len === 16; // Mastercard (legacy)
  if (p4 >= 2221 && p4 <= 2720) return len === 16; // Mastercard (2-series)
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) {
    return len >= 16 && len <= 19; // Discover
  }
  return false;
}

export const validators: Readonly<Record<string, StructuralValidator>> = {
  /** Credit card: must match a network prefix + valid length AND pass Luhn. */
  creditCard(value: string): boolean {
    const d = digitsOnly(value);
    if (d.length < 13 || d.length > 19) return false;
    if (!hasCardPrefix(d)) return false;
    return luhnValid(d);
  },

  /**
   * US SSN validity: 9 digits, excluding never-issued forms — area 000 / 666 /
   * 900-999, group 00, or serial 0000. The regex matches the shape; this
   * rejects structurally-impossible values (e.g. 000-00-0000).
   */
  ssn(value: string): boolean {
    const d = digitsOnly(value);
    if (d.length !== 9) return false;
    const area = Number(d.slice(0, 3));
    const group = Number(d.slice(3, 5));
    const serial = Number(d.slice(5, 9));
    if (area === 0 || area === 666 || area >= 900) return false;
    if (group === 0) return false;
    if (serial === 0) return false;
    return true;
  },
};
