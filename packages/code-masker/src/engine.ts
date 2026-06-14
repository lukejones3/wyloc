import ts from "typescript";
import { scan, buildSwap } from "@wyloc/detector";
import { resolveConfig, type CodeMaskerConfig, type CodeMaskerConfigInput } from "./config.js";
import { collectMaskedSymbols, importOrigin } from "./classify.js";
import { maskIdentifier, maskModuleSpecifier } from "./mask.js";
import { maskStringValue } from "./strings.js";
import { parse } from "./program.js";
import { rehydrate } from "./rehydrate.js";
import { SessionMap } from "./session.js";
import type { MaskKind } from "./types.js";

/** Outcome of masking one source file. `session` is RAM-only and drives rehydration. */
export interface MaskResult {
  masked: string;
  session: SessionMap;
  // Inspection surface (useful for tests/audit; reveals nothing beyond `session`).
  maskedIdentifiers: { real: string; mask: string; kind: MaskKind }[];
  maskedStrings: { real: string; mask: string }[];
  maskedModuleSpecifiers: { real: string; mask: string }[];
  swappedSecrets: { mock: string }[];
}

function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) && p.moduleSpecifier === node) return true;
  if (ts.isExportDeclaration(p) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p) && p.expression === node) return true;
  if (ts.isImportTypeNode(p)) return true;
  if (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return false;
}

/**
 * The TS/JS code masker. Pure and in-process (no sidecar): the TypeScript
 * Compiler API parses, the binder/checker classifies by scope + import origin,
 * an AST transform renames internal identifiers consistently + masks internal
 * strings + strips comments, and @wyloc/detector swaps hardcoded secrets.
 *
 * Reuse one instance across files; it holds only the resolved policy.
 */
export class CodeMasker {
  private readonly config: CodeMaskerConfig;

  constructor(config: CodeMaskerConfig) {
    this.config = config;
  }

  static create(input?: CodeMaskerConfigInput): CodeMasker {
    return new CodeMasker(resolveConfig(input));
  }

  mask(code: string, fileName = "input.ts"): MaskResult {
    const cfg = this.config;
    const { checker, sourceFile } = parse(code, fileName);
    const session = new SessionMap();

    // 1. Classify: which symbols are internal-proprietary, and how to mask each.
    const maskedSymbols = collectMaskedSymbols(sourceFile, checker, cfg);
    const maskOf = new Map<ts.Symbol, string>();
    const maskedIdentifiers: MaskResult["maskedIdentifiers"] = [];
    for (const [symbol, info] of maskedSymbols) {
      const mask = session.add(info.kind, info.real, maskIdentifier(info.real, info.kind, cfg));
      maskOf.set(symbol, mask);
      maskedIdentifiers.push({ real: info.real, mask, kind: info.kind });
    }

    const maskedStrings: MaskResult["maskedStrings"] = [];
    const maskedModuleSpecifiers: MaskResult["maskedModuleSpecifiers"] = [];
    const factory = ts.factory;

    // 2. One AST transform: rename identifiers, mask strings + module specifiers.
    const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => (root) => {
      const visit = (node: ts.Node): ts.Node => {
        // Consistent rename of every reference to a masked internal symbol.
        if (ts.isIdentifier(node)) {
          const s = checker.getSymbolAtLocation(node);
          const mask = s ? maskOf.get(s) : undefined;
          return mask ? factory.createIdentifier(mask) : node;
        }

        // Object shorthand `{ foo }` whose value is masked -> `{ foo: <mask> }`,
        // so we never silently rename the property KEY (public shape).
        if (ts.isShorthandPropertyAssignment(node)) {
          const s = checker.getShorthandAssignmentValueSymbol(node);
          const mask = s ? maskOf.get(s) : undefined;
          if (mask) {
            return factory.createPropertyAssignment(node.name, factory.createIdentifier(mask));
          }
          return node;
        }

        // Element-access member: `c["score"]` whose argument resolves to a
        // masked member -> `c["<mask>"]`, keeping computed access consistent
        // with the renamed declaration. (Gating guarantees the access resolved.)
        if (
          ts.isStringLiteral(node) &&
          node.parent &&
          ts.isElementAccessExpression(node.parent) &&
          node.parent.argumentExpression === node
        ) {
          const s = checker.getSymbolAtLocation(node);
          const mask = s ? maskOf.get(s) : undefined;
          if (mask) return factory.createStringLiteral(mask);
        }

        // String / no-substitution template literals.
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (isModuleSpecifier(node)) {
            const spec = node.text;
            const origin = importOrigin(spec, cfg);
            if (cfg.maskModuleSpecifiers && (origin === "relative" || origin === "internal-bare")) {
              const mask = session.add("module-specifier", spec, maskModuleSpecifier(spec, cfg));
              maskedModuleSpecifiers.push({ real: spec, mask });
              return factory.createStringLiteral(mask);
            }
            return node; // external module path — leave it (model needs it)
          }
          const res = maskStringValue(node.text, cfg);
          if (res.hits.length === 0) return node;
          for (const h of res.hits) {
            const mask = session.add(h.kind, h.real, h.mask);
            maskedStrings.push({ real: h.real, mask });
          }
          return ts.isStringLiteral(node)
            ? factory.createStringLiteral(res.value)
            : factory.createNoSubstitutionTemplateLiteral(res.value);
        }

        // Template literals WITH ${} substitutions: mask the static text parts
        // (e.g. an internal host in `https://billing.internal/${path}`) and let
        // visitEachChild rename identifiers inside the substitution expressions.
        if (ts.isTemplateExpression(node) && (cfg.maskStrings || cfg.maskBucket2)) {
          const visited = ts.visitEachChild(node, visit, ctx) as ts.TemplateExpression;
          let changed = false;
          const maskPart = (text: string): string => {
            const res = maskStringValue(text, cfg);
            if (res.hits.length) {
              changed = true;
              for (const h of res.hits) {
                maskedStrings.push({ real: h.real, mask: session.add(h.kind, h.real, h.mask) });
              }
            }
            return res.value;
          };
          const headText = maskPart(visited.head.text);
          const spanTexts = visited.templateSpans.map((s) => maskPart(s.literal.text));
          if (!changed) return visited;
          const last = visited.templateSpans.length - 1;
          const spans = visited.templateSpans.map((s, i) =>
            factory.updateTemplateSpan(
              s,
              s.expression,
              i === last
                ? factory.createTemplateTail(spanTexts[i]!)
                : factory.createTemplateMiddle(spanTexts[i]!),
            ),
          );
          return factory.updateTemplateExpression(
            visited,
            factory.createTemplateHead(headText),
            spans,
          );
        }

        return ts.visitEachChild(node, visit, ctx);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    };

    const transformed = ts.transform(sourceFile, [transformer]).transformed[0]!;

    // 3. Print — strips ALL comments (the deliberate, safe choice).
    const printer = ts.createPrinter({ removeComments: cfg.stripComments });
    let masked = printer.printFile(transformed);

    // 4. Hardcoded secrets: reuse @wyloc/detector (never rebuilt). Run last so
    //    findings' spans are valid against the already-masked text.
    const swappedSecrets: MaskResult["swappedSecrets"] = [];
    if (cfg.scrubSecrets) {
      const { findings } = scan(masked, cfg.detectorConfig);
      if (findings.length > 0) {
        const swap = buildSwap(masked, findings, cfg.sessionSalt);
        masked = swap.swappedText;
        for (const m of swap.mappings) {
          session.add("secret", m.real, m.mock);
          swappedSecrets.push({ mock: m.mock });
        }
      }
    }

    return { masked, session, maskedIdentifiers, maskedStrings, maskedModuleSpecifiers, swappedSecrets };
  }

  /**
   * Reverse a masked LLM response using a session map. Reverses ONLY the tokens
   * we created and passes through identifiers the model invented. Pure — no
   * parser needed.
   */
  rehydrate(text: string, session: SessionMap): string {
    return rehydrate(text, session);
  }
}
