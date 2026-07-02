/**
 * Real-shaped C++ fixtures.
 *
 * APP_CPP — primary: system + local includes, a config-gated internal
 * namespace (voltra::billing), class/struct/alias declarations, a template
 * member (no instantiation reasoning), out-of-class member definition
 * (member — off), a #define function-like macro, a fully-qualified internal
 * reference, std:: everywhere, an internal URL, an AWS key, comments.
 *
 * VOLTRA_LEDGER_HPP — the local header; drives the project index.
 *
 * EXTERNAL_ONLY_CPP — NEGATIVE: iostream/vector/string + main only; the one
 * declared name is nothing — zero masked.
 */

export const CPP_PREFIXES = ["voltra"];

export const APP_CPP = `// Voltra billing — invoice reconciliation. Proprietary.
// Owned by payments-core; escalation channel #voltra-billing-oncall.
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "voltra/ledger_client.hpp"

#define VOLTRA_AUDIT(msg) std::fprintf(stderr, "[audit] %s\\n", (msg))

namespace voltra::billing {

constexpr const char* kLedgerBaseUrl = "https://ledger.internal.voltra.io/api/v3";
constexpr const char* kAwsKey = "AKIA5XQ2WJ8NPLR3MKVT";

using BatchSummaries = std::map<std::string, int>;

/// Matches settlement batches against open invoices.
class InvoiceReconciler {
public:
    explicit InvoiceReconciler(std::shared_ptr<LedgerClient> client)
        : client_(std::move(client)) {}

    template <typename Range>
    BatchSummaries summarize(const Range& entries) const {
        BatchSummaries counts;
        for (const auto& e : entries) counts[e.currency()]++;
        return counts;
    }

    int reconcile(const std::vector<std::string>& ids);

private:
    std::shared_ptr<LedgerClient> client_;
};

struct ReconcileResult {
    int matched = 0;
    int failed = 0;
};

// Out-of-class member definition: a MEMBER, stays untouched.
int InvoiceReconciler::reconcile(const std::vector<std::string>& ids) {
    VOLTRA_AUDIT("batch start");
    for (const auto& id : ids) client_->post_entry(id);
    return static_cast<int>(ids.size());
}

ReconcileResult run_batch(const std::vector<std::string>& ids) {
    auto client = std::make_shared<LedgerClient>();
    voltra::billing::InvoiceReconciler rec(client);
    ReconcileResult result;
    result.matched = rec.reconcile(ids);
    return result;
}

}  // namespace voltra::billing
`;

export const VOLTRA_LEDGER_HPP = `#pragma once
#include <memory>
#include <string>

namespace voltra::ledger {

class LedgerClient {
public:
    void post_entry(const std::string& id);
};

}  // namespace voltra::ledger
`;

export const EXTERNAL_ONLY_CPP = `#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

int main() {
    const char* parts = std::getenv("PARTS");
    std::vector<std::string> out;
    std::stringstream ss(parts ? parts : "");
    std::string tok;
    while (std::getline(ss, tok, ',')) {
        if (!tok.empty()) out.push_back(tok);
    }
    std::cout << out.size() << " parts" << std::endl;
    return out.empty() ? EXIT_FAILURE : EXIT_SUCCESS;
}
`;
