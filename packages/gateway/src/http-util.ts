/**
 * Low-level HTTP plumbing helpers shared by the proxy.
 *
 * Kept dependency-free and framework-free: Node's built-in `http` plus
 * the global `fetch`/`Headers`/`ReadableStream` (Node 18+) are all we
 * use. No Express, no undici-direct, no body parsers.
 */

import type { IncomingMessage } from "node:http";

/**
 * Request headers we must NOT forward upstream. Hop-by-hop headers are
 * connection-scoped and meaningless to the upstream; `host` must be the
 * upstream's host (fetch sets it); `content-length` is recomputed by
 * fetch from the body we hand it. We also drop `accept-encoding` so the
 * upstream replies uncompressed — that keeps the SSE stream as plain
 * UTF-8 text we can buffer and rewrite on token boundaries without
 * having to inflate/deflate mid-stream.
 */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
]);

/**
 * Response headers we must NOT forward back to the client. We always let
 * Node re-frame the response (chunked) and, because we dropped
 * `accept-encoding` upstream, the body is already plain — so any stale
 * `content-encoding`/`content-length` would be a lie. Strip them.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

/** Collect a Node request body into a single Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Build the upstream fetch headers from the incoming client headers. */
export function buildUpstreamHeaders(
  incoming: IncomingMessage["headers"],
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    // Node collapses most headers to a string; arrays only for set-cookie
    // and a few others. Join arrays with comma per RFC 7230.
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/** Convert upstream fetch response headers into Node outgoing headers. */
export function buildClientHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    out[key] = value;
  });
  return out;
}
