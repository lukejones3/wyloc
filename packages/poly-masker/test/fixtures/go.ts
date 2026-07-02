/**
 * Real-shaped Go fixtures (mirrors code-masker's samples.ts conventions).
 *
 * APP_GO — the primary fixture: internal declarations (struct/interface/type/
 * func), internal imports (qualifier + selectors), external imports (gin/zap/
 * decimal + stdlib), an internal URL, a hardcoded AWS key, comments, and a
 * generic-local-heavy function body.
 *
 * EXTERNAL_ONLY_GO — the make-or-break NEGATIVE fixture: every identifier is
 * stdlib/third-party or a generic local; nothing may be masked.
 *
 * SHADOWED_QUALIFIER_GO — a param shadows an internal import's qualifier; the
 * conservative rule skips that import entirely (no partial mask).
 */

export const INTERNAL_MODULE = "github.com/voltra/billing-core";

export const APP_GO = `// Package billing implements Voltra's invoice reconciliation pipeline.
// Owned by the payments-core team; see go/voltra-billing-runbook.
package billing

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/voltra/billing-core/internal/ledger"
	fx "github.com/voltra/billing-core/pkg/fxrates"
)

const (
	// ledgerBaseURL points at the internal ledger service in prod.
	ledgerBaseURL = "https://ledger.internal.voltra.io/api/v3"
	awsAccessKey  = "AKIA5XQ2WJ8NPLR3MKVT"
)

// InvoiceReconciler matches incoming payments against open invoices.
type InvoiceReconciler struct {
	ledgerClient *ledger.Client
	rates        fx.Provider
	log          *zap.Logger
	httpClient   *http.Client
}

// DunningPolicy is how aggressively we chase unpaid invoices.
type DunningPolicy int

// Retryable is anything the pipeline can re-run safely.
type Retryable interface {
	Retry(ctx context.Context) error
}

// NewInvoiceReconciler wires a reconciler with the shared ledger client.
func NewInvoiceReconciler(lc *ledger.Client, rates fx.Provider, log *zap.Logger) *InvoiceReconciler {
	return &InvoiceReconciler{
		ledgerClient: lc,
		rates:        rates,
		log:          log,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

// ReconcileBatch walks a settlement batch and posts matched entries to the ledger.
func (r *InvoiceReconciler) ReconcileBatch(ctx context.Context, batchID string) (*ReconcileResult, error) {
	entries, err := r.ledgerClient.OpenEntries(ctx, batchID)
	if err != nil {
		return nil, fmt.Errorf("fetch open entries for %s: %w", batchID, err)
	}

	result := &ReconcileResult{BatchID: batchID}
	for _, e := range entries {
		rate, err := r.rates.Lookup(ctx, e.Currency)
		if err != nil {
			r.log.Warn("fx lookup failed", zap.String("currency", e.Currency))
			continue
		}
		amount := decimal.NewFromInt(e.AmountMinor).Mul(rate)
		if err := ledger.PostEntry(ctx, e.ID, amount); err != nil {
			result.Failed++
			continue
		}
		result.Matched++
	}
	return result, nil
}

// ReconcileResult summarizes one batch run.
type ReconcileResult struct {
	BatchID string
	Matched int
	Failed  int
}

// RegisterRoutes exposes the reconcile trigger on the internal admin router.
func RegisterRoutes(rg *gin.RouterGroup, r *InvoiceReconciler) {
	rg.POST("/reconcile/:batchID", func(c *gin.Context) {
		res, err := r.ReconcileBatch(c.Request.Context(), c.Param("batchID"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, res)
	})
}
`;

export const EXTERNAL_ONLY_GO = `package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

func main() {
	router := gin.Default()
	client := &http.Client{Timeout: 5 * time.Second}

	router.GET("/ping", func(c *gin.Context) {
		total := decimal.NewFromInt(0)
		for _, part := range strings.Split(os.Getenv("PARTS"), ",") {
			n, err := decimal.NewFromString(part)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
			total = total.Add(n)
		}
		fmt.Println("total", total)
		c.JSON(http.StatusOK, gin.H{"total": total.String(), "client": client != nil})
	})
}
`;

export const SHADOWED_QUALIFIER_GO = `package billing

import (
	"context"

	"github.com/voltra/billing-core/internal/ledger"
)

// process takes a LOCAL param named ledger that shadows the import's qualifier.
func process(ctx context.Context, ledger string) error {
	_ = ctx
	_ = ledger
	return nil
}
`;
