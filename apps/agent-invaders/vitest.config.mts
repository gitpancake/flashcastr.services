import { defineConfig } from "vitest/config";

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: "../../node_modules/.vite/apps/agent-invaders",
  test: {
    name: "@flashcastr/agent-invaders",
    watch: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
  },
}));
