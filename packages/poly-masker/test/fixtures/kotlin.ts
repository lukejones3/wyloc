/**
 * Real-shaped Kotlin fixtures.
 *
 * APP_KOTLIN — primary, deliberately arranged around the grammar quirks:
 * an internal import with a SAME-LINE trailing comment (the import_header
 * text-swallowing quirk), an aliased internal import (`as Fx`), a comment
 * directly after the import list, data class / object / typealias / top-level
 * function (all name-field-less nodes), an interpolated string carrying an
 * internal host, coroutines + slf4j + ktor as externals, an AWS key, KDoc.
 *
 * EXTERNAL_ONLY_KOTLIN — NEGATIVE: external imports and a main() only;
 * nothing may be masked.
 */

export const KOTLIN_PREFIXES = ["com.voltra."];

export const APP_KOTLIN = `// Voltra billing — invoice reconciliation service.
// Owned by payments-core; escalation channel #voltra-billing-oncall.
package com.voltra.billing

import java.math.BigDecimal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory
import io.ktor.client.HttpClient
import com.voltra.ledger.LedgerClient // ledger service SDK
import com.voltra.ledger.model.LedgerEntry
import com.voltra.billing.fx.FxRateProvider as Fx
// Internal ledger endpoint (prod); staging swaps the host via config.

private const val AWS_KEY = "AKIA5XQ2WJ8NPLR3MKVT"

/**
 * Matches incoming settlement batches against open invoices and posts
 * matched entries back to the internal ledger service.
 */
class InvoiceReconciler(
    private val ledgerClient: LedgerClient,
    private val fxRates: Fx,
    private val http: HttpClient,
) {
    private val log = LoggerFactory.getLogger(InvoiceReconciler::class.java)

    /** Walks one settlement batch; returns a summary of matches and failures. */
    suspend fun reconcileBatch(batchId: String): ReconcileResult = withContext(Dispatchers.IO) {
        val entries: List<LedgerEntry> = ledgerClient.openEntries(batchId)
        var matched = 0
        var failed = 0

        for (entry in entries) {
            val rate: BigDecimal? = fxRates.lookup(entry.currency)
            if (rate == null) {
                log.warn("fx lookup failed for {} at https://ledger.internal.voltra.io/entries/\${entry.id}", entry.currency)
                failed++
                continue
            }
            runCatching { ledgerClient.postEntry(entry.id, BigDecimal.valueOf(entry.amountMinor).multiply(rate)) }
                .onSuccess { matched++ }
                .onFailure { failed++ }
        }
        ReconcileResult(batchId, matched, failed)
    }

    fun summarizeByCurrency(entries: List<LedgerEntry>): Map<String, Int> =
        entries.groupingBy { it.currency }.eachCount()
}

/** Immutable summary of one reconcile run. */
data class ReconcileResult(val batchId: String, val matched: Int, val failed: Int)

object ReconcilerRegistry {
    val active = mutableListOf<InvoiceReconciler>()
}

typealias BatchSummaries = Map<String, ReconcileResult>

fun buildReconciler(lc: LedgerClient, fx: Fx, http: HttpClient): InvoiceReconciler =
    InvoiceReconciler(lc, fx, http)
`;

export const EXTERNAL_ONLY_KOTLIN = `import java.time.Duration
import kotlinx.coroutines.runBlocking
import org.slf4j.LoggerFactory

fun main() = runBlocking {
    val log = LoggerFactory.getLogger("cli")
    val timeout = Duration.ofSeconds(5)
    val parts = (System.getenv("PARTS") ?: "")
        .split(',')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
    log.info("parsed {} parts in under {}", parts.size, timeout)
}
`;
