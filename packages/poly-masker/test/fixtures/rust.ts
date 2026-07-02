/**
 * Real-shaped Rust fixtures.
 *
 * APP_RUST — primary: std + external-crate uses (serde/tokio) beside
 * crate:: uses (plain, list, and `as`-aliased), struct/enum/trait/type/mod
 * declarations, a macro_rules! definition + invocations, #[derive] attrs,
 * impl methods (members — off), an internal URL const, an AWS key, doc +
 * line comments. Macro conservatism is the load-bearing check: names inside
 * token trees / attributes stay untouched.
 *
 * EXTERNAL_ONLY_RUST — NEGATIVE: std/serde only, fn main only (excluded as
 * entrypoint); nothing may be masked.
 */

export const RUST_PREFIXES = ["voltra_billing"];

export const APP_RUST = `//! Voltra billing — invoice reconciliation. Proprietary.
//! Owned by payments-core; escalation channel #voltra-billing-oncall.
use std::collections::HashMap;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

use crate::ledger::LedgerClient;
use crate::fx::{FxRateProvider, RateWindow};
use crate::audit::AuditSink as Sink;

const LEDGER_BASE_URL: &str = "https://ledger.internal.voltra.io/api/v3";
const AWS_KEY: &str = "AKIA5XQ2WJ8NPLR3MKVT";

/// Matches settlement batches against open invoices.
#[derive(Debug, Serialize, Deserialize)]
pub struct InvoiceReconciler {
    matched: u64,
    failed: u64,
}

pub enum ReconcileOutcome {
    Matched(u64),
    Failed(String),
}

pub trait Retryable {
    fn retry(&self) -> bool;
}

pub type BatchSummaries = HashMap<String, ReconcileOutcome>;

mod dunning {
    pub fn escalation_level(days: u32) -> u8 {
        (days / 30) as u8
    }
}

macro_rules! voltra_audit {
    ($msg:expr) => {
        println!("[audit] {}", $msg);
    };
}

impl InvoiceReconciler {
    pub fn summarize(&self) -> (u64, u64) {
        (self.matched, self.failed)
    }
}

pub fn reconcile_batch(
    client: &LedgerClient,
    fx: &FxRateProvider,
    sink: &Sink,
    batch_id: &str,
) -> InvoiceReconciler {
    let mut totals: HashMap<String, u64> = HashMap::new();
    let window = RateWindow::default();
    voltra_audit!(batch_id);
    for entry in client.open_entries(batch_id) {
        // members untouched: lookup/currency are method/field accesses
        let rate = fx.lookup(&entry.currency, &window);
        *totals.entry(entry.currency.clone()).or_insert(0) += 1;
        sink.record(&entry, rate);
    }
    let level = dunning::escalation_level(45);
    println!("{} currencies at level {}, InvoiceReconciler pending", totals.len(), level);
    InvoiceReconciler { matched: totals.len() as u64, failed: 0 }
}
`;

export const EXTERNAL_ONLY_RUST = `use std::collections::HashMap;
use std::time::Duration;

fn main() {
    let timeout = Duration::from_secs(5);
    let mut counts: HashMap<String, u64> = HashMap::new();
    for part in std::env::var("PARTS").unwrap_or_default().split(',') {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            *counts.entry(trimmed.to_string()).or_insert(0) += 1;
        }
    }
    println!("{} distinct parts in under {:?}", counts.len(), timeout);
}
`;
