/**
 * Real-shaped C# fixtures.
 *
 * APP_CSHARP — primary: block namespace, internal usings (Voltra.*) beside
 * System / NuGet ones, a class + record + const URL + AWS key, LINQ,
 * doc comments, one fully-qualified internal reference. The types imported
 * from OTHER files via `using Voltra.Ledger;` (LedgerClient, LedgerEntry,
 * IFxRateProvider) are the C# ambiguity case: WITHOUT the project index they
 * must be left alone (safe under-mask); WITH it they must mask.
 *
 * SIBLING_CS — the sibling file declaring those types in Voltra.* namespaces;
 * written to a temp project dir to build a real ProjectIndex in tests.
 *
 * EXTERNAL_ONLY_CSHARP — NEGATIVE: top-level program, System/NuGet only;
 * nothing may be masked.
 */

export const CSHARP_PREFIXES = ["Voltra."];

export const APP_CSHARP = `// Voltra billing — invoice reconciliation service.
// Owned by payments-core; escalation channel #voltra-billing-oncall.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;

using Voltra.Ledger;
using Voltra.Ledger.Models;
using Voltra.Billing.Fx;

namespace Voltra.Billing
{
    /// <summary>
    /// Matches incoming settlement batches against open invoices and posts
    /// matched entries back to the internal ledger service.
    /// </summary>
    public class InvoiceReconciler
    {
        // Internal ledger endpoint (prod); staging swaps the host via config.
        private const string LedgerBaseUrl = "https://ledger.internal.voltra.io/api/v3";
        private const string AwsKey = "AKIA5XQ2WJ8NPLR3MKVT";

        private readonly LedgerClient _ledgerClient;
        private readonly IFxRateProvider _fxRates;
        private readonly HttpClient _http;
        private readonly ILogger<InvoiceReconciler> _log;

        public InvoiceReconciler(LedgerClient ledgerClient, IFxRateProvider fxRates,
                                 ILogger<InvoiceReconciler> log)
        {
            _ledgerClient = ledgerClient;
            _fxRates = fxRates;
            _log = log;
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        }

        /// <summary>Walks one settlement batch; returns a summary.</summary>
        public async Task<ReconcileResult> ReconcileBatchAsync(string batchId)
        {
            IReadOnlyList<LedgerEntry> entries = await _ledgerClient.OpenEntriesAsync(batchId);
            int matched = 0, failed = 0;

            foreach (var entry in entries)
            {
                decimal? rate = _fxRates.Lookup(entry.Currency);
                if (rate is null)
                {
                    _log.LogWarning("fx lookup failed for {Currency}", entry.Currency);
                    failed++;
                    continue;
                }
                try
                {
                    await _ledgerClient.PostEntryAsync(entry.Id, entry.AmountMinor * rate.Value);
                    matched++;
                }
                catch (HttpRequestException e)
                {
                    _log.LogError(e, "post failed for entry {EntryId}", entry.Id);
                    failed++;
                }
            }
            return new ReconcileResult(batchId, matched, failed);
        }

        public Dictionary<string, int> SummarizeByCurrency(IEnumerable<LedgerEntry> entries) =>
            entries.GroupBy(e => e.Currency).ToDictionary(g => g.Key, g => g.Count());

        public static InvoiceReconciler CreateDefault() =>
            new InvoiceReconciler(new Voltra.Ledger.LedgerClient(new HttpClient()), null, null);
    }

    /// <summary>Immutable summary of one reconcile run.</summary>
    public record ReconcileResult(string BatchId, int Matched, int Failed);
}
`;

export const SIBLING_CS = `using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;

namespace Voltra.Ledger
{
    public class LedgerClient
    {
        private readonly HttpClient _http;
        public LedgerClient(HttpClient http) => _http = http;
        public Task<IReadOnlyList<LedgerEntry>> OpenEntriesAsync(string batchId) =>
            Task.FromResult<IReadOnlyList<LedgerEntry>>(new List<LedgerEntry>());
        public Task PostEntryAsync(string entryId, decimal amount) => Task.CompletedTask;
    }
}

namespace Voltra.Ledger.Models
{
    public record LedgerEntry(string Id, string Currency, long AmountMinor);
}

namespace Voltra.Billing.Fx
{
    public interface IFxRateProvider
    {
        decimal? Lookup(string currency);
    }
}
`;

export const EXTERNAL_ONLY_CSHARP = `using System;
using System.Linq;
using System.Net.Http;

var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
var parts = (Environment.GetEnvironmentVariable("PARTS") ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries)
    .Select(p => p.Trim())
    .Where(p => p.Length > 0)
    .ToList();
Console.WriteLine($"parsed {parts.Count} parts, client ready: {client != null}");
`;
