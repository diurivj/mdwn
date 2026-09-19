import { defineConfig } from "drizzle-kit";

/**
 * Generates SQL migrations from app/db/schema.ts into ./drizzle.
 * Generation never touches a database; migrations are *applied* through
 * Wrangler (`npm run db:migrate:*`), which is the reviewed commit point.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./app/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});