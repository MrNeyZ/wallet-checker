// Map raw backend / RPC error strings to short, human-friendly lines for UI.
//
// Backend wraps upstream failures with format like:
//   "Backend 429: SolanaTracker returned 429: <body>"
//   "Backend 500: RPC rate limit hit. Please wait a few seconds and try again."
// The raw body is useful for logs but noisy in the UI. Map known patterns to
// a one-liner; pass everything else through unchanged so we don't hide novel
// errors. Also strip JSON bodies that leaked into the message.

const RATE_LIMIT_PATTERN = /\b429\b|rate[\s-]?limit|too many requests/i;
const SOLANA_TRACKER_PATTERN = /solana[\s-]?tracker/i;
const HELIUS_PATTERN = /helius/i;

export function prettifyApiError(error: string): string {
  if (!error) return "Unknown error";

  if (RATE_LIMIT_PATTERN.test(error)) {
    if (SOLANA_TRACKER_PATTERN.test(error)) {
      return "SolanaTracker rate limit. Wait and retry.";
    }
    if (HELIUS_PATTERN.test(error) || /\brpc\b/i.test(error)) {
      return "RPC rate limit hit. Wait and retry.";
    }
    return "Rate limit hit. Wait and retry.";
  }

  // If the message looks like it ends in a JSON body, drop the body.
  // Pattern: "<prefix>: {...}" or "<prefix>: [...]" — keep the prefix only.
  const jsonStart = error.search(/[:\-]\s*[{[]/);
  if (jsonStart > 0) {
    return error.slice(0, jsonStart).trim() || error;
  }

  return error;
}
