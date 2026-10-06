import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { TEST_DATABASE_URL, assertLocalTestDatabase } from "./test-db";

// Rebuild the test database schema from the migrations once per test run.
export default async function setup() {
  assertLocalTestDatabase(TEST_DATABASE_URL);
  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();
}
