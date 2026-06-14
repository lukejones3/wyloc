import type { CodeMaskerConfig } from "./config.js";
import { shortHash } from "./hash.js";
import type { MaskKind } from "./types.js";

/**
 * Semantic-preserving identifier masks. Mirrors the SQL masker's
 * fact_/dim_ prefix-preservation philosophy: keep the *kind* recognizable so
 * the model can still follow the code's structure, strip the proprietary name,
 * append a deterministic hash so every reference renames consistently.
 *
 *   class BillingReconciler   -> Class_<hash>
 *   function computeDunning   -> fn_<hash>
 *   interface LedgerEntry     -> Interface_<hash>
 *   type DunningState         -> Type_<hash>
 *   enum InvoiceStatus        -> Enum_<hash>
 *   namespace Billing         -> Mod_<hash>
 *   method .reconcile()       -> m_<hash>
 *   import {x} from "./a"      -> Import_<hash>   (relative-imported symbol)
 *
 * The prefix doubles as a hint to the model ("this is a class") and keeps the
 * masked token a valid, collision-resistant JS identifier.
 */

const PREFIX: Record<Exclude<MaskKind, "module-specifier" | "string" | "secret">, string> = {
  class: "Class",
  function: "fn",
  interface: "Interface",
  type: "Type",
  enum: "Enum",
  namespace: "Mod",
  member: "m",
  import: "Import",
};

/** Mask an internal identifier of a given kind. */
export function maskIdentifier(real: string, kind: keyof typeof PREFIX, cfg: CodeMaskerConfig): string {
  return `${PREFIX[kind]}_${shortHash(real, cfg.sessionSalt, cfg.hashLength)}`;
}

/**
 * Mask a relative module specifier while keeping it a structurally-valid
 * relative path of the same depth, so imports still parse and the model still
 * sees "this comes from a sibling/parent module".
 *   "./billing/reconciler"      -> "./mod_<hash>"
 *   "../core/ledger/entry.js"   -> "../mod_<hash>.js"
 *   "./engine"                  -> "./mod_<hash>"
 */
export function maskModuleSpecifier(real: string, cfg: CodeMaskerConfig): string {
  const m = real.match(/^(\.\.?(?:\/)?)(.*)$/);
  const lead = m ? m[1] : "./";
  const rest = m ? m[2]! : real;
  const ext = rest.match(/\.(m?[jt]sx?|json|css)$/i)?.[0] ?? "";
  const base = lead && !lead.endsWith("/") ? `${lead}/` : (lead ?? "./");
  return `${base}mod_${shortHash(real, cfg.sessionSalt, cfg.hashLength)}${ext}`;
}

/**
 * Mask an internal infrastructure host while preserving its shape (it remains a
 * hostname the model can reason about). The internal TLD/domain identity is
 * stripped; a deterministic hash keeps references consistent.
 *   billing.internal.acme.com -> host-<hash>.internal.example
 *   db1.corp                  -> host-<hash>.corp
 */
export function maskHost(real: string, tld: string | null, cfg: CodeMaskerConfig): string {
  const suffix = tld ? `.${tld}` : "";
  return `host-${shortHash(real, cfg.sessionSalt, cfg.hashLength)}${suffix}`;
}

/** Mask a private IP — keep it a syntactically-valid private address. */
export function maskPrivateIp(real: string, cfg: CodeMaskerConfig): string {
  // Deterministically derive a stand-in in the 10/8 documentation-ish space.
  const h = shortHash(real, cfg.sessionSalt, 8);
  const a = parseInt(h.slice(0, 2), 36) % 256;
  const b = parseInt(h.slice(2, 4), 36) % 256;
  const c = parseInt(h.slice(4, 6), 36) % 256;
  return `10.${a}.${b}.${c}`;
}

/** Mask an architecture-revealing file path to an opaque, obviously-fake token. */
export function maskPath(real: string, cfg: CodeMaskerConfig): string {
  return `/masked/path_${shortHash(real, cfg.sessionSalt, cfg.hashLength)}`;
}

/** Generic Bucket-2 / fallback string token (codenames, queue names, etc.). */
export function maskToken(real: string, cfg: CodeMaskerConfig): string {
  return `WYLOC_MASK_${shortHash(real, cfg.sessionSalt, cfg.hashLength).toUpperCase()}`;
}
