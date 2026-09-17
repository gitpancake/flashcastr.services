import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    watch: false,
    include: ["libs/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "libs/shared/**", "apps/agent-flashcastr/**"],
  },
});
