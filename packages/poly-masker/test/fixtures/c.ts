/**
 * Real-shaped C fixtures.
 *
 * APP_C — primary: system + local includes, #define object/function-like
 * macros (incl. one whose body hides an identifier), typedef'd struct,
 * static + extern functions, an #if condition referencing a define, an
 * internal URL macro, an AWS key, comments. Preprocessor conservatism is the
 * load-bearing check.
 *
 * VOLTRA_LEDGER_H — the local header APP_C includes; drives the project
 * index (prototypes + types that a .c file references unqualified).
 *
 * EXTERNAL_ONLY_C — NEGATIVE: pure stdlib + main; nothing may be masked.
 */

export const APP_C = `/* Voltra billing — invoice reconciliation. Proprietary. */
/* Owned by payments-core; escalation channel #voltra-billing-oncall. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "voltra_ledger.h"

#define MAX_BATCH 512
#define POST_ENTRY(id, amt) ledger_post((id), (amt))
#define LEDGER_URL "https://ledger.internal.voltra.io/api/v3"
#define AWS_KEY "AKIA5XQ2WJ8NPLR3MKVT"

typedef struct invoice_reconciler {
    unsigned long matched;
    unsigned long failed;
} invoice_reconciler_t;

enum reconcile_outcome { RECONCILE_OK, RECONCILE_FAIL };

static int reconcile_entry(const char *entry_id, double amount);

static int reconcile_entry(const char *entry_id, double amount) {
    if (amount <= 0) return RECONCILE_FAIL;
    POST_ENTRY(entry_id, amount);
    return RECONCILE_OK;
}

int reconcile_batch(const char *batch_id) {
    invoice_reconciler_t rec;
    memset(&rec, 0, sizeof(rec));
    char *entries[MAX_BATCH];
    size_t n = ledger_open_entries(batch_id, entries, MAX_BATCH);
    for (size_t i = 0; i < n; i++) {
        if (reconcile_entry(entries[i], 1.0) == RECONCILE_OK) rec.matched++;
        else rec.failed++;
    }
#if MAX_BATCH > 256
    printf("large batch mode: %s\\n", LEDGER_URL);
#endif
    printf("matched=%lu failed=%lu\\n", rec.matched, rec.failed);
    return (int)rec.matched;
}
`;

export const VOLTRA_LEDGER_H = `#ifndef VOLTRA_LEDGER_H
#define VOLTRA_LEDGER_H

#include <stddef.h>

typedef struct ledger_entry {
    char id[16];
    long amount_minor;
} ledger_entry_t;

size_t ledger_open_entries(const char *batch_id, char **out, size_t cap);
int ledger_post(const char *entry_id, double amount);

#endif
`;

export const EXTERNAL_ONLY_C = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    const char *parts = getenv("PARTS");
    if (parts == NULL) parts = "";
    size_t total = 0;
    char buf[256];
    strncpy(buf, parts, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = 0;
    for (char *tok = strtok(buf, ","); tok != NULL; tok = strtok(NULL, ",")) {
        if (strlen(tok) > 0) total++;
    }
    printf("%zu parts\\n", total);
    return (int)(total > 0 ? EXIT_SUCCESS : EXIT_FAILURE);
}
`;
