import { defineConfig } from "drizzle-kit";

// Migrations live in ./drizzle (0000_init.sql is the source of truth for the
// table shapes; the test harness loads the same SQL into pg-mem). Deployment runs
// `drizzle-kit migrate` against the real Postgres (plan.md sec 15).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/yammer",
  },
});
