const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** "s_" + 16 base32 chars, etc. */
export const randomId = (prefix: string, chars = 16) => prefix + base32(randomBytes(Math.ceil((chars * 5) / 8))).slice(0, chars);

/** Time-sortable id: 10 chars of base32 millisecond timestamp + 10 random chars. */
export function sortableId(): string {
  let t = Date.now();
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  return ts + base32(randomBytes(7)).slice(0, 10);
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const b64url = (bytes: Uint8Array) => b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseJsonArray(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL_RE.test(s);
export const normEmail = (s: string) => s.trim().toLowerCase();

/** "Quo SMS!" -> "quo-sms", at most `max` characters; "" when nothing is left. */
export const slug = (s: string, max: number) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");

/** A whole number written as a number or a string of digits, else NaN. */
export const wholeNumber = (raw: unknown) =>
  typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;

/** Whether a fetch failed because its AbortSignal timed out. */
export const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** "just now", "5 minutes ago", "3 days ago", or a date for anything older than a month. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  if (s < 30 * 86400) return unit(Math.floor(s / 86400), "day");
  return new Date(ms).toISOString().slice(0, 10);
}
