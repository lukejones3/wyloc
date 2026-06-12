#!/usr/bin/env python3
"""
SQL-masking optimization experiment runner.

Sends RAW / OPAQUE / SEMANTIC versions of the same query to one or both LLM
providers (OpenAI and/or Anthropic) with one shared optimization prompt, then
saves every prompt and response so the masking strategies can be compared
within a provider AND across providers (the cross-model validation).

Usage:
    OPENAI_API_KEY=sk-...      python3 run_experiment.py --provider openai
    ANTHROPIC_API_KEY=sk-ant-... python3 run_experiment.py --provider anthropic
    OPENAI_API_KEY=... ANTHROPIC_API_KEY=... python3 run_experiment.py --provider both
Optional model overrides:
    OPENAI_MODEL=gpt-4o            (default; falls back on model-not-found)
    ANTHROPIC_MODEL=claude-opus-4-8 (default; falls back on model-not-found)

No third-party packages required (stdlib urllib only).
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
QDIR = HERE / "queries"
RDIR = HERE / "responses"

VERSIONS = ["raw", "opaque", "semantic"]
MAX_TOKENS = 2048
PROMPT = (HERE / "prompt.txt").read_text().strip()


def _openai_parse(data):
    return data["choices"][0]["message"]["content"] or ""


def _anthropic_parse(data):
    return "".join(b.get("text", "") for b in data.get("content", [])
                   if b.get("type") == "text")


# Both APIs accept the same request body shape: {model, max_tokens, messages:[{role,content}]}.
# Only the endpoint, auth header, response shape, and model names differ.
PROVIDERS = {
    "openai": {
        "env": "OPENAI_API_KEY",
        "url": "https://api.openai.com/v1/chat/completions",
        "models": [os.environ.get("OPENAI_MODEL", "gpt-4o"), "gpt-4o-mini", "gpt-4-turbo"],
        "headers": lambda key: {"Authorization": f"Bearer {key}", "content-type": "application/json"},
        "parse": _openai_parse,
    },
    "anthropic": {
        "env": "ANTHROPIC_API_KEY",
        "url": "https://api.anthropic.com/v1/messages",
        "models": [os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8"),
                   "claude-opus-4-7", "claude-sonnet-4-6"],
        "headers": lambda key: {"x-api-key": key, "anthropic-version": "2023-06-01",
                                "content-type": "application/json"},
        "parse": _anthropic_parse,
    },
}


def build_user_message(sql: str) -> str:
    return f"{PROMPT}\n\n```sql\n{sql.strip()}\n```"


def _is_model_not_found(code: int, detail: str) -> bool:
    return code == 404 or "model_not_found" in detail or "does not exist" in detail


def call_api(cfg: dict, api_key: str, user_message: str):
    last_err = None
    for model in cfg["models"]:
        body = json.dumps({
            "model": model,
            "max_tokens": MAX_TOKENS,
            "messages": [{"role": "user", "content": user_message}],
        }).encode()
        req = urllib.request.Request(cfg["url"], data=body, method="POST",
                                     headers=cfg["headers"](api_key))
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())
                return model, cfg["parse"](data), data
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            last_err = f"HTTP {e.code} on {model}: {detail}"
            if _is_model_not_found(e.code, detail):   # try the next model name
                continue
            raise SystemExit(f"API error: {last_err}")
        except urllib.error.URLError as e:
            raise SystemExit(f"Network error: {e}")
    raise SystemExit(f"All model names failed. Last: {last_err}")


def run_provider(provider: str, api_key: str) -> list:
    """Run all three versions for one provider; returns markdown report lines."""
    cfg = PROVIDERS[provider]
    outdir = RDIR / provider
    outdir.mkdir(parents=True, exist_ok=True)

    report = [f"\n\n# Provider: {provider}\n"]
    for name in VERSIONS:
        sql = (QDIR / f"{name}.sql").read_text()
        user_message = build_user_message(sql)
        (outdir / f"{name}.prompt.txt").write_text(user_message)

        print(f"[{provider}/{name}] sending…", flush=True)
        model, text, raw = call_api(cfg, api_key, user_message)
        print(f"[{provider}/{name}] got {len(text)} chars from {model}", flush=True)

        (outdir / f"{name}.response.txt").write_text(text)
        (outdir / f"{name}.response.json").write_text(json.dumps(raw, indent=2))
        report += [f"\n\n---\n\n## {provider} · {name.upper()}  (model: {model})\n", text]
        time.sleep(1)
    return report


def main():
    ap = argparse.ArgumentParser(description="SQL masking experiment runner")
    ap.add_argument("--provider", choices=["openai", "anthropic", "both"],
                    default="openai", help="which provider(s) to run (default: openai)")
    args = ap.parse_args()

    providers = ["openai", "anthropic"] if args.provider == "both" else [args.provider]

    # Validate keys up front so we don't half-run.
    keys = {}
    missing = []
    for p in providers:
        env = PROVIDERS[p]["env"]
        keys[p] = os.environ.get(env)
        if not keys[p]:
            missing.append(env)
    if missing:
        sys.exit(f"Missing env var(s): {', '.join(missing)}")

    RDIR.mkdir(exist_ok=True)
    report = ["# SQL masking experiment — results",
              f"\n_Shared prompt:_\n\n> {PROMPT}\n",
              f"\n_Providers run: {', '.join(providers)}_"]
    for p in providers:
        report += run_provider(p, keys[p])

    (HERE / "results.md").write_text("\n".join(report))
    print(f"\nWrote {HERE / 'results.md'} and per-provider files in {RDIR}/<provider>/")


if __name__ == "__main__":
    main()
