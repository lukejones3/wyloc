#!/usr/bin/env python3
"""
sqlglot worker for @wyloc/sql-masker.

A persistent, line-oriented JSON-RPC sidecar. The TS engine spawns one of
these once and talks to it over stdin/stdout (newline-delimited JSON), so the
~50ms interpreter+import cost is paid once and every subsequent parse is ~5ms.

Protocol (one JSON object per line, request and response):
  -> {"id": 1, "op": "classify", "sql": "...", "dialect": "postgres"}
  <- {"id": 1, "ok": true, "result": {...}}
  -> {"id": 2, "op": "rewrite", "sql": "...", "dialect": "postgres",
      "tables": {...}, "schemas": {...}, "columns": {...}, "identifiers": {...}}
  <- {"id": 2, "ok": true, "result": {"sql": "..."}}
  -> {"id": 3, "op": "ping"}            <- {"id": 3, "ok": true, "result": {"pong": true}}

RAM-only invariant: this process reads SQL from the pipe, holds it in memory,
and writes the transformed SQL back. It never writes SQL to disk and never logs
query text. Errors return only the exception class/message, not the SQL body.
"""
import sys
import json

try:
    import sqlglot
    from sqlglot import exp
except Exception as e:  # pragma: no cover - environment guard
    sys.stdout.write(json.dumps({
        "id": None, "ok": False,
        "error": f"sqlglot import failed ({type(e).__name__}): {e}. "
                 f"Install with: pip install -r requirements.txt",
        "fatal": True,
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def _cte_names(root):
    return {c.alias_or_name for c in root.find_all(exp.CTE)}


def classify(sql, dialect):
    """Return the identifier inventory the TS policy engine needs."""
    root = sqlglot.parse_one(sql, dialect=dialect)
    cte_names = _cte_names(root)

    # Physical sources = Table nodes whose name is NOT a CTE in scope.
    # (sqlglot models CTE references as Table nodes too, so we must subtract them.)
    physical = {}
    for t in root.find_all(exp.Table):
        if t.name in cte_names:
            continue
        catalog = t.text("catalog") or None
        db = t.text("db") or None
        physical[(catalog, db, t.name)] = {
            "name": t.name, "schema": db, "catalog": catalog,
        }

    # Query-local alias names: table aliases + projection/derived aliases,
    # minus CTE names (CTE names are reported separately).
    aliases = set()
    for ta in root.find_all(exp.TableAlias):
        if ta.name:
            aliases.add(ta.name)
    for a in root.find_all(exp.Alias):
        if a.alias:
            aliases.add(a.alias)
    aliases -= cte_names

    columns = sorted({c.name for c in root.find_all(exp.Column) if c.name})

    return {
        "physicalTables": list(physical.values()),
        "cteNames": sorted(cte_names),
        "aliases": sorted(aliases),
        "columns": columns,
    }


def _strip_comments(root):
    """Drop every comment node. Comments are an uncontrolled leak channel —
    a header like `/* sort by median_ghost */` re-exposes the exact identifiers
    and concepts we're masking — and they carry no value for optimization advice."""
    for item in root.walk():
        node = item[0] if isinstance(item, tuple) else item
        if getattr(node, "comments", None):
            node.comments = None
    return root


def literals(sql, dialect):
    """Return the distinct string-literal values in the query (for value scrubbing)."""
    root = sqlglot.parse_one(sql, dialect=dialect)
    seen = set()
    out = []
    for lit in root.find_all(exp.Literal):
        if lit.is_string and lit.this not in seen:
            seen.add(lit.this)
            out.append(lit.this)
    return {"literals": out}


def rewrite(sql, dialect, tables, schemas, columns, identifiers,
            literals_map=None, strip_comments=True):
    """Apply identifier + string-literal renames at the AST level, regenerate SQL."""
    root = sqlglot.parse_one(sql, dialect=dialect)
    if strip_comments:
        _strip_comments(root)
    cte_names = _cte_names(root)
    tables = tables or {}
    schemas = schemas or {}
    columns = columns or {}
    identifiers = identifiers or {}
    literals_map = literals_map or {}

    def rename_phys_and_cols(node):
        if isinstance(node, exp.Table) and node.name not in cte_names:
            if node.name in tables and node.this is not None:
                node.this.set("this", tables[node.name])
            db = node.text("db")
            if db and db in schemas and node.args.get("db") is not None:
                node.args["db"].set("this", schemas[db])
        elif isinstance(node, exp.Column):
            if node.name in columns and node.this is not None:
                node.this.set("this", columns[node.name])
        return node

    root = root.transform(rename_phys_and_cols)

    # Alias / concept-echo identifier renames: rewrite the Identifier node by
    # name everywhere it appears (definition + every reference), so all uses of
    # a query-local name stay consistent. Physical/column names were already
    # changed above to distinct strings, so they won't collide with these keys.
    if identifiers:
        def rename_ids(node):
            if isinstance(node, exp.Identifier) and node.name in identifiers:
                node.set("this", identifiers[node.name])
            return node
        root = root.transform(rename_ids)

    # String-literal value scrubbing: replace whole literal values by exact match.
    if literals_map:
        def rename_lits(node):
            if isinstance(node, exp.Literal) and node.is_string and node.this in literals_map:
                node.set("this", literals_map[node.this])
            return node
        root = root.transform(rename_lits)

    return {"sql": root.sql(dialect=dialect)}


def handle(req):
    op = req.get("op")
    if op == "ping":
        return {"pong": True, "sqlglot": sqlglot.__version__}
    dialect = req.get("dialect", "postgres")
    if op == "classify":
        return classify(req["sql"], dialect)
    if op == "literals":
        return literals(req["sql"], dialect)
    if op == "rewrite":
        return rewrite(
            req["sql"], dialect,
            req.get("tables"), req.get("schemas"),
            req.get("columns"), req.get("identifiers"),
            req.get("literals"), req.get("stripComments", True),
        )
    raise ValueError(f"unknown op: {op!r}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            result = handle(req)
            out = {"id": rid, "ok": True, "result": result}
        except Exception as e:  # never leak SQL text into the error
            out = {"id": rid, "ok": False,
                   "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
