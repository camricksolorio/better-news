import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = { value: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieStore.value ? { name, value: cookieStore.value } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

import { isCorrectSecret, isValidSessionToken, requireAdmin, sessionToken } from "./admin-auth";

const original = process.env.ADMIN_SECRET;
beforeEach(() => {
  process.env.ADMIN_SECRET = "correct horse";
  cookieStore.value = undefined;
});
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = original;
});

describe("admin auth", () => {
  it("accepts only the right secret", () => {
    expect(isCorrectSecret("correct horse")).toBe(true);
    expect(isCorrectSecret("wrong")).toBe(false);
    expect(isCorrectSecret("correct horse ")).toBe(false);
    expect(isCorrectSecret("")).toBe(false);
    expect(isCorrectSecret(null)).toBe(false);
  });

  it("the cookie token is derived, deterministic, and not the secret", () => {
    const token = sessionToken()!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain("correct horse");
    expect(sessionToken()).toBe(token);
  });

  it("validates only the matching token", () => {
    expect(isValidSessionToken(sessionToken())).toBe(true);
    expect(isValidSessionToken("nope")).toBe(false);
    expect(isValidSessionToken(undefined)).toBe(false);
    expect(isValidSessionToken("correct horse")).toBe(false);
  });

  it("a token minted under another secret stops working when the secret changes", () => {
    const old = sessionToken();
    process.env.ADMIN_SECRET = "rotated";
    expect(isValidSessionToken(old)).toBe(false);
  });

  it("denies everyone when ADMIN_SECRET is unset", () => {
    const token = sessionToken();
    delete process.env.ADMIN_SECRET;
    expect(sessionToken()).toBeNull();
    expect(isValidSessionToken(token)).toBe(false);
    expect(isCorrectSecret("anything")).toBe(false);
    expect(isCorrectSecret("")).toBe(false);
  });
});

describe("requireAdmin (the re-check that works even if Proxy is bypassed)", () => {
  it("redirects to the login page without a session cookie", async () => {
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
  });

  it("redirects with a forged cookie", async () => {
    cookieStore.value = "forged";
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
  });

  it("passes with a valid session cookie", async () => {
    cookieStore.value = sessionToken()!;
    await expect(requireAdmin()).resolves.toBeUndefined();
  });
});
