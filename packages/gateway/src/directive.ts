/**
 * The verbatim-echo directive injected into the request's system prompt when a
 * secret was swapped. It tells the model to reproduce WYLOC_MOCK_ tokens exactly
 * so they match for streaming rehydration. Shared across provider adapters.
 */
export const WYLOC_DIRECTIVE =
  "[Wyloc secret-protection notice]\n" +
  "Some sensitive values in this conversation have been replaced with placeholder " +
  "tokens of the form WYLOC_MOCK_<TYPE>_<ID> (for example, WYLOC" +
  "_MOCK_EXAMPLE_TOKEN_000000). They are intentional stand-ins for real " +
  "credentials. Whenever you reference or reproduce such a value, output the " +
  "placeholder token EXACTLY as written — exact case, exact characters, no " +
  "truncation, no inserted spaces or line breaks, no reformatting. Never invent " +
  "new WYLOC_MOCK_ tokens. Treat each placeholder as an opaque literal.";
