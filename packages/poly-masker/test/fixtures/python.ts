/**
 * Real-shaped Python fixtures.
 *
 * APP_PY — primary: absolute internal imports (from voltra_billing.*),
 * a relative import, an unaliased dotted internal import (module attribute
 * chain), stdlib (os/logging/decimal/dataclasses) + pip (requests/tenacity)
 * imports, module/class/method docstrings, # comments, an f-string with an
 * internal host, an AWS key, decorators, dynamic attribute access everywhere
 * (the member-masking-off case).
 *
 * EXTERNAL_ONLY_PY — NEGATIVE: stdlib/pip only, no declarations to mask
 * beyond... nothing: plain script, zero maskable names.
 */

export const PYTHON_PREFIXES = ["voltra_billing"];

export const APP_PY = `"""Voltra billing — invoice reconciliation service.

Owned by payments-core; escalation channel #voltra-billing-oncall.
"""
import logging
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Iterable

import requests
from tenacity import retry, stop_after_attempt

import voltra_billing.fx
from voltra_billing.ledger import LedgerClient
from .models import LedgerEntry

log = logging.getLogger(__name__)

# Internal ledger endpoint (prod); staging swaps the host via config.
LEDGER_BASE_URL = "https://ledger.internal.voltra.io/api/v3"
AWS_KEY = "AKIA5XQ2WJ8NPLR3MKVT"


@dataclass
class ReconcileResult:
    """Immutable summary of one reconcile run."""

    batch_id: str
    matched: int = 0
    failed: int = 0
    notes: list[str] = field(default_factory=list)


class InvoiceReconciler:
    """Matches settlement batches against open invoices and posts matched
    entries back to the internal ledger service."""

    def __init__(self, ledger_client: LedgerClient):
        self.ledger_client = ledger_client
        self.session = requests.Session()
        self.session.headers["X-Env"] = os.environ.get("APP_ENV", "prod")

    @retry(stop=stop_after_attempt(3))
    def reconcile_batch(self, batch_id: str) -> ReconcileResult:
        """Walks one settlement batch; returns a summary."""
        entries = self.ledger_client.open_entries(batch_id)
        result = ReconcileResult(batch_id=batch_id)

        for entry in entries:
            rate = voltra_billing.fx.lookup(entry.currency)
            if rate is None:
                log.warning("fx lookup failed for %s", entry.currency)
                result.failed += 1
                continue
            amount = Decimal(entry.amount_minor) * rate
            try:
                self.session.post(f"https://ledger.internal.voltra.io/entries/{entry.id}", json={"amount": str(amount)})
                result.matched += 1
            except requests.HTTPError:
                log.exception("post failed for entry %s", entry.id)
                result.failed += 1
        return result


def summarize_by_currency(entries: Iterable[LedgerEntry]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in entries:
        counts[entry.currency] = counts.get(entry.currency, 0) + 1
    return counts
`;

export const EXTERNAL_ONLY_PY = `import json
import os
from datetime import timedelta
from pathlib import Path

import requests

timeout = timedelta(seconds=5)
parts = [p.strip() for p in os.environ.get("PARTS", "").split(",") if p.strip()]
payload = json.dumps({"parts": parts, "cwd": str(Path.cwd())})
resp = requests.post("https://httpbin.org/post", data=payload, timeout=timeout.total_seconds())
print(resp.status_code, len(parts))
`;
