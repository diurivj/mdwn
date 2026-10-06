import { sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";

export { sql };
export { accounts } from "./schema";
export * from "./schema";

/**
 * Drizzle client bound to a Cloudflare D1 database. `env.DB` is the D1
 * binding from wrangler.jsonc (separate databases per environment: local,
 * preview, production — production D1 is never bound in preview or local).
 *
 * Server-only module (RR convention): importable only from server-side code;
 * the client build errors on any client-side import, keeping the D1/Drizzle
 * dependency out of the browser bundle.
 */
export function createDb(db: D1Database): DrizzleD1Database {
  return drizzle(db);
}

/**
 * One D1 transaction for ordered, parameterized SQLite statements. Drizzle's
 * D1 `batch()` cannot prepare parameterized `db.run(sql`...`)` raw queries;
 * compile their SQL and bindings with its SQLite dialect, then batch the
 * resulting D1 statements. Keep direct D1 access inside this adapter only.
 */
export function atomicSqlBatch(db: D1Database, statements: readonly SQL[]): Promise<D1Result[]> {
  const dialect = new SQLiteAsyncDialect();
  return db.batch(
    statements.map((statement) => {
      const compiled = dialect.sqlToQuery(statement);
      return db.prepare(compiled.sql).bind(...compiled.params);
    }),
  );
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
