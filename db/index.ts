import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import type { Db } from "./types";

let instance: Db | undefined;

function connect(): Db {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  return drizzle(postgres(process.env.DATABASE_URL, { prepare: false }), { schema });
}

// Connects on first use, not at import. `next build` imports every route to read its config, so a build that has
// no database credentials (a preview deployment without them, say) would otherwise fail before serving anything.
// Using the database without DATABASE_URL still throws, at the call that needs it.
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = (instance ??= connect());
    const value = Reflect.get(real, prop, real);
    // Methods keep `this` as the real instance. `$client` is the postgres client: a function that carries its own
    // methods (`end`, ...), which binding would drop.
    return typeof value === "function" && prop !== "$client" ? value.bind(real) : value;
  },
});
