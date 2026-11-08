import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = { value: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieStore.value ? { name, value: cookieStore.value } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
const save = vi.fn();
const clear = vi.fn();
vi.mock("@/lib/eval/event-labeling", () => ({
  saveEventLabel: (...a: unknown[]) => save(...a),
  clearEventLabel: (...a: unknown[]) => clear(...a),
  loadEvent: async () => ({ event: { id: "e" }, labeled: [], candidates: [] }),
}));
vi.mock("@/db", () => ({ db: {} }));

import { sessionToken } from "@/lib/admin-auth";
import { clearEventLabelAction, labelEventArticleAction } from "./actions";

beforeEach(() => {
  process.env.ADMIN_SECRET = "correct horse";
  cookieStore.value = undefined;
  save.mockClear();
  clear.mockClear();
});

describe("event labelling actions", () => {
  it("refuse an unauthenticated request without touching the data", async () => {
    await expect(labelEventArticleAction("e", "a", "in")).rejects.toThrow(/NEXT_REDIRECT:\/admin\/login/);
    await expect(clearEventLabelAction("e", "a")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(save).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("save and clear for an admin, and return the reloaded event", async () => {
    cookieStore.value = sessionToken()!;
    const after = await labelEventArticleAction("e", "a", "related");
    expect(save).toHaveBeenCalledWith({}, "e", "a", "related");
    expect(after.event.id).toBe("e");
    await clearEventLabelAction("e", "a");
    expect(clear).toHaveBeenCalledWith({}, "e", "a");
  });
});
