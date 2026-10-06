// Admin gate (D3): a single ADMIN_SECRET. The cookie holds a value derived from the secret
// (never the secret itself). Proxy does an optimistic check; every admin page and server
// action calls requireAdmin() again, because Proxy is not the only line of defense.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const ADMIN_COOKIE = "admin_session";
export const ADMIN_LOGIN_PATH = "/admin/login";

function secret(): string | null {
  const s = process.env.ADMIN_SECRET;
  return s && s.length > 0 ? s : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The value stored in the session cookie. Null when ADMIN_SECRET is unset, which denies
// everyone: unlike /api/ingest, the admin area is never open.
export function sessionToken(): string | null {
  const s = secret();
  return s ? createHmac("sha256", s).update("better-news-admin-session").digest("hex") : null;
}

export function isValidSessionToken(token: string | undefined | null): boolean {
  const expected = sessionToken();
  return !!expected && !!token && safeEqual(token, expected);
}

export function isCorrectSecret(input: string | undefined | null): boolean {
  const s = secret();
  return !!s && !!input && safeEqual(input, s);
}

export async function isAdmin(): Promise<boolean> {
  return isValidSessionToken((await cookies()).get(ADMIN_COOKIE)?.value);
}

// Call at the top of every admin page, server action, and route handler.
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect(ADMIN_LOGIN_PATH);
}
