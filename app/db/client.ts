import { sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export { accounts } from "./schema";
export * from "./schema";

/**
 * Drizzle client bound to a Cloudflare D1 database. `env.DB` is the D1
 * binding from wrangler.jsonc (separate databases per environment: local,
 * preview, production — production D1 is never bound in preview or local).
 */
export function createDb(db: D1Database): DrizzleD1Database {
  return drizzle(db);
}

/** Cheap liveness probe through the ORM: SELECT 1. */
export async function ping(db: D1Database): Promise<boolean> {
  try {
    const result = await createDb(db).run(sql`SELECT 1`);
    return result.success;
  } catch {
    return false;
  }
}