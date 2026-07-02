import type { Node } from "web-tree-sitter";
import { collect, innerSpan, spanOf, walk } from "../tree.js";
import type { AnalyzerCtx, LangAnalysis, Span, SymbolTarget } from "../types.js";

/**
 * COBOL analyzer — the enterprise target, and technically the cleanest: no
 * preprocessor, no imports beyond COPY, every identifier declared explicitly.
 *
 * Classification:
 *  - INTERNAL (masked): the PROGRAM-ID, DATA DIVISION data items
 *    (entry_name), paragraph/section names, COPY member names, and
 *    copybook-sourced items resolved via the project index
 *    (ctx.extraInternalTypes; snippet path under-masks safely).
 *  - NEVER TOUCH: reserved words, verbs, figurative constants, and intrinsic
 *    function names (the RESERVED set below) — intrinsics like LENGTH parse
 *    as ordinary WORD leaves, so the set is load-bearing, not decorative.
 *
 * FIXED-FORMAT COLUMN SAFETY (the thing to get right): identifier masks are
 * SAME-LENGTH COBOL words (M + [A-Z0-9]…, equal length, never reserved), so a
 * byte-span rewrite cannot move anything — every line keeps its exact length,
 * the col-7 indicator and Area A/B alignment survive, and nothing crosses
 * column 72. A same-length mask that would collide (tiny hash space on very
 * short names) SKIPS that identifier — conservative under-mask, never a
 * broken rewrite. String-literal masks and detector mocks may change a
 * line's length; that is accepted (output feeds an LLM, not a compiler, and
 * rehydration restores the original bytes — the re-parse gate still applies).
 *
 * Comment handling is TEXTUAL, not tree-based (the grammar swallows comment
 * lines as extras): fixed-format `*`/`/` in column 7 removes the whole line;
 * `*>` inline comments (both formats) are stripped to end-of-line.
 */

/** Reserved words, verbs, figurative constants, intrinsics — never masked. */
const RESERVED = new Set(
  `ACCEPT ACCESS ADD ADVANCING AFTER ALL ALPHABET ALPHABETIC ALPHANUMERIC ALSO
   ALTER ALTERNATE AND ANY ARE AREA AREAS ASCENDING ASSIGN AT AUTHOR BEFORE
   BINARY BLANK BLOCK BOTTOM BY CALL CANCEL CHARACTER CHARACTERS CLASS CLOSE
   CODE COLLATING COLUMN COMMA COMMON COMP COMP-1 COMP-2 COMP-3 COMP-4 COMP-5
   COMPUTATIONAL COMPUTE CONFIGURATION CONTAINS CONTENT CONTINUE CONTROL
   CONVERTING COPY CORR CORRESPONDING COUNT CURRENCY DATA DATE DAY DAY-OF-WEEK
   DEBUGGING DECIMAL-POINT DECLARATIVES DELETE DELIMITED DELIMITER DEPENDING
   DESCENDING DISPLAY DIVIDE DIVISION DOWN DUPLICATES DYNAMIC ELSE END
   END-ADD END-CALL END-COMPUTE END-DELETE END-DIVIDE END-EVALUATE END-IF
   END-MULTIPLY END-PERFORM END-READ END-RETURN END-REWRITE END-SEARCH
   END-START END-STRING END-SUBTRACT END-UNSTRING END-WRITE ENVIRONMENT EQUAL
   ERROR EVALUATE EVERY EXCEPTION EXIT EXTEND EXTERNAL FALSE FD FILE
   FILE-CONTROL FILLER FIRST FOOTING FOR FROM FUNCTION GENERATE GIVING GLOBAL
   GO GOBACK GREATER GROUP HEADING HIGH-VALUE HIGH-VALUES IDENTIFICATION IF IN
   INDEX INDEXED INITIAL INITIALIZE INPUT INPUT-OUTPUT INSPECT INSTALLATION
   INTO INVALID IS I-O I-O-CONTROL JUST JUSTIFIED KEY LABEL LEADING LEFT
   LENGTH LESS LIMIT LIMITS LINE LINES LINKAGE LOCK LOW-VALUE LOW-VALUES
   MEMORY MERGE MODE MOVE MULTIPLE MULTIPLY NATIVE NEGATIVE NEXT NO NOT
   NUMERIC OBJECT-COMPUTER OCCURS OF OFF OMITTED ON OPEN OPTIONAL OR ORDER
   ORGANIZATION OTHER OUTPUT OVERFLOW PACKED-DECIMAL PADDING PAGE PERFORM PIC
   PICTURE PLUS POINTER POSITION POSITIVE PROCEDURE PROCEDURES PROCEED
   PROGRAM PROGRAM-ID QUOTE QUOTES RANDOM READ RECORD RECORDS REDEFINES REEL
   REFERENCE RELATIVE RELEASE REMAINDER REMOVAL RENAMES REPLACE REPLACING
   RERUN RESERVE RETURN REVERSED REWIND REWRITE RIGHT ROUNDED RUN SAME SD
   SEARCH SECTION SECURITY SEGMENT-LIMIT SELECT SENTENCE SEPARATE SEQUENCE
   SEQUENTIAL SET SIGN SIZE SORT SORT-MERGE SOURCE-COMPUTER SPACE SPACES
   SPECIAL-NAMES STANDARD STANDARD-1 STANDARD-2 START STATUS STOP STRING
   SUBTRACT SUM SYNC SYNCHRONIZED TALLYING TAPE TEST THAN THEN THROUGH THRU
   TIME TIMES TO TOP TRAILING TRUE TYPE UNIT UNSTRING UNTIL UP UPON USAGE USE
   USING VALUE VALUES VARYING WHEN WITH WORDS WORKING-STORAGE WRITE
   ZERO ZEROES ZEROS
   ABS ANNUITY BYTE-LENGTH CHAR COMBINED-DATETIME CONCATENATE CURRENT-DATE
   DATE-OF-INTEGER DATE-TO-YYYYMMDD DAY-OF-INTEGER DAY-TO-YYYYDDD E EXP EXP10
   FACTORIAL FORMATTED-CURRENT-DATE FORMATTED-DATE FORMATTED-DATETIME
   FORMATTED-TIME FRACTION-PART INTEGER INTEGER-OF-DATE INTEGER-OF-DAY
   INTEGER-PART LOG LOG10 LOWER-CASE MAX MEAN MEDIAN MIDRANGE MIN MOD NUMVAL
   NUMVAL-C NUMVAL-F ORD ORD-MAX ORD-MIN PI PRESENT-VALUE RANGE REM REVERSE
   SECONDS-FROM-FORMATTED-TIME SECONDS-PAST-MIDNIGHT SIGN SIN SQRT
   STANDARD-DEVIATION SUBSTITUTE TAN TEST-FORMATTED-DATETIME TEST-NUMVAL
   TRIM UPPER-CASE VARIANCE WHEN-COMPILED YEAR-TO-YYYY`
    .split(/\s+/)
    .filter(Boolean),
);

/** ≥90% of non-blank lines shaped like sequence-area + col-7 indicator. */
export function isFixedFormatCobol(src: string): boolean {
  const lines = src.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  let fixed = 0;
  for (const l of lines) {
    if (l.length >= 7 && /^[0-9 ]{6}$/.test(l.slice(0, 6)) && " */-Dd$".includes(l[6]!)) fixed++;
  }
  return fixed / lines.length >= 0.9;
}

/**
 * Same-length, valid-COBOL-word mask: starts with a letter, [A-Z0-9] body,
 * exact length of the original. Deterministic; retries a few salted variants
 * to dodge collisions/reserved words, then gives up (caller skips — the
 * conservative failure). Never contains '-' or '_', so the shared rehydrate
 * word-boundary logic treats it as one token.
 */
function sameLenMask(
  real: string,
  hash: (s: string) => string,
  used: Set<string>,
  fixedLen: boolean,
): string | null {
  const upper = real.toUpperCase();
  for (let attempt = 0; attempt < 8; attempt++) {
    let body = "";
    let round = 0;
    while (body.length < real.length) body += hash(`${upper}#${attempt}#${round++}`).toUpperCase();
    const mask = fixedLen
      ? `M${body}`.slice(0, real.length)
      : `M${body.slice(0, Math.max(5, real.length - 1))}`;
    if (!used.has(mask) && !RESERVED.has(mask) && mask !== upper) {
      used.add(mask);
      return mask;
    }
  }
  return null;
}

/** Textual comment spans: col-7 comment lines (fixed) + inline `*>`. */
function commentSpans(src: string, fixed: boolean): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  for (const line of src.split(/\n/)) {
    const end = offset + line.length;
    if (fixed && line.length >= 7 && (line[6] === "*" || line[6] === "/")) {
      spans.push({ start: offset, end });
    } else {
      // `*>` to end of line, outside string literals (quote-parity scan).
      let inQuote: string | null = null;
      for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i]!;
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
        } else if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === "*" && line[i + 1] === ">") {
          spans.push({ start: offset + i, end });
          break;
        }
      }
    }
    offset = end + 1;
  }
  return spans;
}

export function analyzeCobol(root: Node, ctx: AnalyzerCtx): LangAnalysis {
  const symbols: SymbolTarget[] = [];
  const strings: LangAnalysis["strings"] = [];
  const fixed = isFixedFormatCobol(ctx.src);
  const usedMasks = new Set<string>();
  const targets = new Map<string, SymbolTarget>();

  const declare = (name: string, kind: SymbolTarget["kind"]): void => {
    const upper = name.toUpperCase();
    if (targets.has(upper) || RESERVED.has(upper)) return;
    const mask = sameLenMask(name, ctx.hash, usedMasks, fixed);
    if (!mask) return; // same-length collision — conservative skip
    targets.set(upper, { kind, real: name, mask, spans: [] });
  };

  // ── 1. Declarations: program-id, data items, paragraphs/sections, COPY. ──
  for (const n of collect(root, ["program_name"])) declare(n.text, "namespace");
  for (const n of collect(root, ["entry_name"])) declare(n.text, "type");
  for (const header of collect(root, ["paragraph_header", "section_header"])) {
    const word = collect(header, ["WORD"])[0];
    if (word) declare(word.text, "function");
  }
  for (const copy of collect(root, ["copy_statement"])) {
    const word = collect(copy, ["WORD"])[0];
    if (word) declare(word.text, "import");
  }
  // Copybook-sourced data items (project index / session accumulation).
  for (const name of ctx.extraInternalTypes) declare(name, "import");

  // ── 2. Every occurrence: declaration nodes + WORD references. ──
  walk(root, (n) => {
    if (n.type === "program_name" || n.type === "entry_name" || n.type === "WORD") {
      const target = targets.get(n.text.toUpperCase());
      if (target) target.spans.push(spanOf(n));
    }
  });
  symbols.push(...targets.values());

  // ── 3. String literals (VALUE clauses, DISPLAY operands, …). ──
  walk(root, (n) => {
    if (n.type === "string") {
      const span = innerSpan(n, 1);
      if (span.end > span.start) strings.push({ span, text: ctx.src.slice(span.start, span.end) });
    }
  });

  return { symbols, strings, comments: commentSpans(ctx.src, fixed) };
}
