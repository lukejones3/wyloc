/**
 * Real-shaped COBOL fixtures.
 *
 * APP_COBOL — FIXED-FORMAT (sequence area cols 1-6, indicator col 7): the
 * Voltra invoice reconciler as a batch program. Internal identity: PROGRAM-ID,
 * WS-* data items, paragraph + section names, a COPY member. Plus an internal
 * URL in a VALUE clause, an AWS key, col-7 comment lines, and an inline `*>`
 * comment. Column alignment through the byte-span rewrite is the make-or-break
 * check here.
 *
 * VLEDGREC_CPY — the copybook APP_COBOL COPYs; drives the project index.
 *
 * EXTERNAL_ONLY_COBOL — NEGATIVE: verbs / figurative constants / intrinsics
 * only; the sole internal identity is its own PROGRAM-ID.
 *
 * FREE_FORMAT_COBOL — column-1 free-format source. The COBOL85 grammar does
 * NOT accept it (fixed/area format only) — the fixture pins the documented
 * degradation: input parse gate rejects → detector-only fallback.
 */

export const APP_COBOL = [
  "000100 IDENTIFICATION DIVISION.",
  "000200 PROGRAM-ID. VBILLRECON.",
  "000300* VOLTRA BILLING - INVOICE RECONCILIATION. PROPRIETARY.",
  "000400* OWNED BY PAYMENTS-CORE. ESCALATION: VOLTRA-BILLING-ONCALL.",
  "000500 ENVIRONMENT DIVISION.",
  "000600 DATA DIVISION.",
  "000700 WORKING-STORAGE SECTION.",
  "000800 01  WS-LEDGER-URL      PIC X(50)",
  '000900     VALUE "https://ledger.internal.voltra.io/api/v3".',
  // Short enough that the detector mock (+12 chars) stays within column 72.
  '001000 01  WS-KEY PIC X(20) VALUE "AKIA5XQ2WJ8NPLR3MKVT".',
  "001100 01  WS-BATCH-TOTALS.",
  "001200     05  WS-MATCHED-CNT PIC 9(6) VALUE ZERO.",
  "001300     05  WS-FAILED-CNT  PIC 9(6) VALUE ZERO.",
  "001400     05  WS-RATE-AMT    PIC 9(4)V99 VALUE ZERO.",
  "001500 COPY VLEDGREC.",
  "001600 PROCEDURE DIVISION.",
  "001700 MAIN-CONTROL SECTION.",
  "001800 MAIN-PARA.",
  "001900     PERFORM RECONCILE-BATCH *> per settlement batch",
  '002000     DISPLAY "MATCHED: " WS-MATCHED-CNT',
  '002100     DISPLAY "FAILED:  " WS-FAILED-CNT',
  "002200     STOP RUN.",
  "002300 RECONCILE-BATCH.",
  "002400     ADD 1 TO WS-MATCHED-CNT",
  "002500     COMPUTE WS-RATE-AMT = FUNCTION NUMVAL(VL-RATE-RAW)",
  "002600     IF WS-MATCHED-CNT GREATER THAN 100",
  "002700         MOVE ZERO TO WS-FAILED-CNT",
  "002800         PERFORM MAIN-PARA",
  "002900     END-IF.",
  "",
].join("\n");

export const VLEDGREC_CPY = [
  "      * VOLTRA LEDGER ENTRY RECORD (SHARED COPYBOOK).",
  "       01  VL-ENTRY.",
  "           05  VL-ENTRY-ID    PIC X(12).",
  "           05  VL-CURRENCY    PIC X(3).",
  "           05  VL-AMT-MINOR   PIC S9(12) COMP-3.",
  "           05  VL-RATE-RAW    PIC X(10).",
  "",
].join("\n");

export const EXTERNAL_ONLY_COBOL = [
  "000100 IDENTIFICATION DIVISION.",
  "000200 PROGRAM-ID. MAINPROG.",
  "000300 PROCEDURE DIVISION.",
  "000400 ONLY-PARA.",
  '000500     DISPLAY "HELLO " FUNCTION CURRENT-DATE',
  '000600     DISPLAY FUNCTION UPPER-CASE("done")',
  "000700     STOP RUN.",
  "",
].join("\n");

/**
 * OVERFLOW_COBOL — a fixed-format line already near column 72 whose secret
 * grows past it when the detector swaps in a (longer) mock. Documents the
 * accepted behavior: the identifier rewrite itself is verified clean
 * (pre-detector re-parse gate); the post-detector mock line becomes ONE
 * contained parse-error island; rehydration restores the original bytes.
 */
export const OVERFLOW_COBOL = [
  "000100 IDENTIFICATION DIVISION.",
  "000200 PROGRAM-ID. VOVERFLOW.",
  "000300 DATA DIVISION.",
  "000400 WORKING-STORAGE SECTION.",
  // 68 chars: within col 72 as written, past it once the mock adds 12.
  '000500 01  WS-SECRET-KEY-FLD PIC X(20) VALUE "AKIA5XQ2WJ8NPLR3MKVT".',
  "000600 PROCEDURE DIVISION.",
  "000700 MAIN-PARA.",
  "000800     DISPLAY WS-SECRET-KEY-FLD",
  "000900     STOP RUN.",
  "",
].join("\n");

export const FREE_FORMAT_COBOL = [
  "IDENTIFICATION DIVISION.",
  "PROGRAM-ID. VFREERECON.",
  "*> free-format Voltra reconciler stub. proprietary.",
  "DATA DIVISION.",
  "WORKING-STORAGE SECTION.",
  "01  WS-TOTAL-CNT PIC 9(6) VALUE ZERO.",
  "PROCEDURE DIVISION.",
  "MAIN-PARA.",
  "    ADD 1 TO WS-TOTAL-CNT",
  '    DISPLAY "TOTAL: " WS-TOTAL-CNT',
  "    STOP RUN.",
  "",
].join("\n");
