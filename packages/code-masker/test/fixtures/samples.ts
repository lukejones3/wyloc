/** Real-shaped fixtures for @wyloc/code-masker tests. */

/**
 * Primary synthetic fixture — exercises every bucket at once:
 *  - internal class / function / interface / type / enum  (Bucket 1, masked)
 *  - external imports: react, lodash, node:crypto          (Bucket 3, NEVER masked)
 *  - relative imports + their module-specifier paths       (Bucket 1, masked)
 *  - internal URL / host / private IP / home-dir path      (Bucket 1, masked)
 *  - a hardcoded AWS access-key id                         (Bucket 1, detector swap)
 *  - comments (incl. one with a real internal name)        (stripped wholesale)
 *  - generic locals + keywords                             (Bucket 3, untouched)
 */
export const APP_TS = `
// Proprietary billing engine for Project Northstar — internal, do not distribute.
import { useState, useEffect } from "react";
import _ from "lodash";
import { randomBytes } from "node:crypto";
import { LedgerStore } from "./ledger/store";
import { formatMoney } from "../util/money";

/** The dunning state machine for overdue accounts. */
export type DunningState = "current" | "overdue" | "charged_off";

export interface LedgerEntry {
  id: string;
  amountCents: number;
}

export enum InvoiceStatus {
  Draft,
  Sent,
  Paid,
}

const API_BASE = "https://billing.internal.acme.com/v2/reconcile";
const FALLBACK_HOST = "ledger-primary.corp";
const DB_HOST = "10.4.12.9";
const CONFIG_PATH = "/Users/svc-billing/secrets/app.json";
const AWS_KEY = "AKIA5XQ2WJ8NPLR3MKVT";

export class BillingReconciler {
  private store: LedgerStore;

  constructor(store: LedgerStore) {
    // wires the proprietary LedgerStore into the reconciler
    this.store = store;
  }

  reconcile(entries: LedgerEntry[]): DunningState {
    const total = _.sumBy(entries, (e) => e.amountCents);
    const display = formatMoney(total);
    return total > 100000 ? "overdue" : "current";
  }
}

export function bootstrap(): BillingReconciler {
  const salt = randomBytes(16).toString("hex");
  return new BillingReconciler(new LedgerStore());
}

export function useDunning(): DunningState {
  const [state, setState] = useState<DunningState>("current");
  useEffect(() => {}, []);
  return state;
}
`;

/**
 * Negative fixture — the make-or-break check. EVERY identifier here comes from
 * an external/standard source. After masking, all of these names must survive
 * verbatim; nothing in this file is proprietary.
 */
export const EXTERNAL_ONLY_TS = `
import { useState, useEffect, useMemo, useCallback } from "react";
import { z } from "zod";
import { debounce, throttle, cloneDeep } from "lodash";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

export const schema = z.object({ id: z.string(), count: z.number() });

export function widget() {
  const [value, setValue] = useState(0);
  const memo = useMemo(() => cloneDeep(value), [value]);
  const onClick = useCallback(debounce(() => setValue((v) => v + 1), 200), []);
  useEffect(() => {
    throttle(() => {}, 100);
  }, []);
  return { value, memo, onClick };
}

export async function load(path) {
  const raw = await readFile(path, "utf8");
  return Buffer.from(raw).toString("base64");
}
`;

/** Template literal WITH ${} substitution — internal infra in the static parts. */
export const TEMPLATE_TS = `
export function endpoint(path: string, port: number): string {
  return \`https://billing.internal.acme.com/v2/\${path}?via=ledger-primary.corp&p=\${port}\`;
}
`;

/** Fixture for opt-in member masking (well-typed accesses, no \`any\`). */
export const MEMBERS_TS = `
import { Other } from "./other";

export class RiskScorer {
  weight: number;
  constructor(w: number) {
    this.weight = w;
  }
  score(input: number): number {
    return input * this.weight;
  }
}

export function run(): number {
  const scorer: RiskScorer = new RiskScorer(2);
  return scorer.score(21);
}
`;
