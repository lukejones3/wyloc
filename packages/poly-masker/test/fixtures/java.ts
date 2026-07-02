/**
 * Real-shaped Java fixtures.
 *
 * APP_JAVA — primary: package decl, internal imports (incl. a deep model
 * package), external imports (slf4j/Spring/Jackson + java.util/java.math),
 * java.lang implicits, a nested record, streams/lambdas/method references,
 * an internal URL, an AWS key, comments.
 *
 * EXTERNAL_ONLY_JAVA — the NEGATIVE fixture: no package declaration, no
 * internal imports; the ONLY maskable name is the file's own class (internal
 * by definition). Everything else must survive byte-identical.
 *
 * WILDCARD_IMPORT_JAVA — internal wildcard import: unenumerable, must be
 * left alone entirely (conservative under-mask), external names intact.
 */

export const JAVA_PREFIXES = ["com.voltra."];

export const APP_JAVA = `// Voltra billing — invoice reconciliation service.
// Owned by payments-core; escalation channel #voltra-billing-oncall.
package com.voltra.billing;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.voltra.ledger.LedgerClient;
import com.voltra.ledger.model.LedgerEntry;
import com.voltra.billing.fx.FxRateProvider;

/**
 * Matches incoming settlement batches against open invoices and posts
 * the matched entries back to the internal ledger service.
 */
@Service
public class InvoiceReconciler {

    private static final Logger log = LoggerFactory.getLogger(InvoiceReconciler.class);

    // Internal ledger endpoint (prod); staging swaps the host via config.
    private static final String LEDGER_BASE_URL = "https://ledger.internal.voltra.io/api/v3";
    private static final String AWS_KEY = "AKIA5XQ2WJ8NPLR3MKVT";

    private final LedgerClient ledgerClient;
    private final FxRateProvider fxRates;
    private final ObjectMapper mapper = new ObjectMapper();

    public InvoiceReconciler(LedgerClient ledgerClient, FxRateProvider fxRates) {
        this.ledgerClient = ledgerClient;
        this.fxRates = fxRates;
    }

    /** Walks one settlement batch; returns a summary of matches and failures. */
    public ReconcileResult reconcileBatch(String batchId) {
        List<LedgerEntry> entries = ledgerClient.openEntries(batchId);
        int matched = 0, failed = 0;

        for (LedgerEntry entry : entries) {
            BigDecimal rate = fxRates.lookup(entry.getCurrency());
            if (rate == null) {
                log.warn("fx lookup failed for {}", entry.getCurrency());
                failed++;
                continue;
            }
            BigDecimal amount = BigDecimal.valueOf(entry.getAmountMinor()).multiply(rate);
            try {
                ledgerClient.postEntry(entry.getId(), amount);
                matched++;
            } catch (RuntimeException e) {
                log.error("post failed for entry {}", entry.getId(), e);
                failed++;
            }
        }
        return new ReconcileResult(batchId, matched, failed);
    }

    public Map<String, Long> summarizeByCurrency(List<LedgerEntry> entries) {
        return entries.stream()
                .collect(Collectors.groupingBy(LedgerEntry::getCurrency, Collectors.counting()));
    }

    /** Immutable summary of one reconcile run. */
    public record ReconcileResult(String batchId, int matched, int failed) {}
}
`;

export const EXTERNAL_ONLY_JAVA = `import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Cli {
    private static final Logger log = LoggerFactory.getLogger(Cli.class);

    public static void main(String[] args) {
        List<String> parts = new ArrayList<>();
        Duration timeout = Duration.ofSeconds(5);
        for (String arg : args) {
            if (arg == null || arg.isBlank()) {
                continue;
            }
            parts.add(arg.strip());
        }
        log.info("parsed {} args in under {}", parts.size(), timeout);
    }
}
`;

export const WILDCARD_IMPORT_JAVA = `package com.voltra.billing;

import java.util.List;
import com.voltra.util.*;

public class BatchRunner {
    public void run(List<String> ids) {
        // Retrier comes from the internal wildcard import — unenumerable, so
        // it must be left alone rather than guessed at.
        Retrier retrier = new Retrier(3);
        retrier.attempt(() -> ids.forEach(System.out::println));
    }
}
`;
