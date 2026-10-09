import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { TEST_DATABASE_URL, assertLocalTestDatabase } from "@/tests/test-db";
import { feedItems } from "./schema";

// Records every postgres client the module opens, so the tests can see when it connects and close what they open.
const opened = vi.hoisted(() => [] as { end: () => Promise<void> }[]);
vi.mock("postgres", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  return {
    default: (...args: Parameters<typeof postgres>) => {
      const client = actual.default(...args);
      opened.push(client);
      return client;
    },
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(opened.splice(0).map((client) => client.end()));
});

describe("db", () => {
  it("can be imported without DATABASE_URL, so a build needs no database credentials", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.resetModules();
    await expect(import("./index")).resolves.toHaveProperty("db");
    expect(opened).toHaveLength(0);
  });

  it("throws a clear error when used without DATABASE_URL, and opens no connection", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.resetModules();
    const { db } = await import("./index");
    expect(() => db.select()).toThrow("DATABASE_URL is not set");
    expect(opened).toHaveLength(0);
  });

  it("connects on first use, once, and runs queries, transactions, and raw SQL", async () => {
    assertLocalTestDatabase(TEST_DATABASE_URL);
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    vi.resetModules();
    const { db } = await import("./index");
    expect(opened).toHaveLength(0); // importing connected to nothing

    expect(await db.execute(sql`SELECT 1 AS one`)).toMatchObject([{ one: 1 }]);
    expect(opened).toHaveLength(1);

    expect(await db.transaction(async (tx) => (await tx.execute(sql`SELECT 2 AS two`))[0].two)).toBe(2);
    // The query builder, through the proxy, against a real table.
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(feedItems)).toHaveLength(1);
    expect(opened).toHaveLength(1); // every use shared the one connection
  });
});
