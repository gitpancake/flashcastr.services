import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    watch: false,
    include: [
      "libs/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Real-Postgres integration tests (guarded by describe.skipIf(!DATABASE_URL))
    // TRUNCATE the same shared tables from multiple files; running files in
    // parallel races one file's truncate against another's in-flight assertions.
    fileParallelism: false,
  },
});
