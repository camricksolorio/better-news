import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDb, resetTestDb } from "@/tests/test-db";

const { client, db } = connectTestDb();
vi.mock("@/db", () => ({ get db() { return db; } }));
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));
afterEach(() => vi.unstubAllEnvs());

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("./route");
  return GET(new Request("http://localhost/api/health", { headers }));
};

describe("GET /api/health", () => {
  it("401 without the secret, and does not reveal checks", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect((await call({ authorization: "Bearer nope" })).status).toBe(401);
  });

  it("503 with the failing checks on an unhealthy pipeline", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call({ authorization: "Bearer s3cret" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual(expect.arrayContaining([{ name: "ingest_freshness", ok: false, detail: expect.any(String) }]));
  });

  it("200 when every check passes", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await client.unsafe(`
      INSERT INTO pipeline_runs (stage, started_at, finished_at) VALUES ('embed', now(), now()), ('cluster', now(), now());
      INSERT INTO feed_items (source_id, guid, title, link) VALUES ('src', 'g', 't', 'https://x.test/1');
      INSERT INTO stories (first_article_at, last_article_at, window_ends_at, centroid) VALUES (now(), now(), now(), array_fill(0, ARRAY[768])::vector);
      UPDATE feed_items SET story_id = (SELECT id FROM stories), embedding = array_fill(0, ARRAY[768])::vector,
        embedding_model = 'm', embedding_input_version = 'v', clustered_at = now();
    `);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
