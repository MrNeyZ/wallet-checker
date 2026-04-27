// Tiny helpers for the cookie-based password gate.
// Cookie value is a sha256 of WEB_PASSWORD so the secret never round-trips.
export const SESSION_COOKIE = "wallet_checker_session";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
