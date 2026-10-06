import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/better_news_test";

// Tests truncate tables; refuse to point them anywhere but a local database.
export function assertLocalTestDatabase(url: string) {
  const { hostname } = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    throw new Error(`Refusing to run tests against non-local database host "${hostname}"`);
  }
}

export function connectTestDb() {
  assertLocalTestDatabase(TEST_DATABASE_URL);
  const client = postgres(TEST_DATABASE_URL, { prepare: false, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

const TABLES = [
  "join_audit_items",
  "eval_pair_labels",
  "llm_calls",
  "pipeline_runs",
  "pipeline_locks",
  "feed_items",
  "stories",
];

// story_assignments is append-only, so TRUNCATE (which skips row triggers) is the way to clear it.
export async function resetTestDb(client: ReturnType<typeof postgres>) {
  await client.unsafe(`TRUNCATE ${TABLES.join(", ")}, story_assignments RESTART IDENTITY CASCADE`);
}

// Drizzle wraps driver errors ("Failed query: ..."); the Postgres message is on `cause`.
export async function dbError(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return err.cause?.message ?? err.message;
  }
  throw new Error("expected the query to fail, but it succeeded");
}
