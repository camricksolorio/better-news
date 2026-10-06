import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    globalSetup: ["./tests/global-setup.ts"],
    // DB tests share one database and truncate between tests.
    fileParallelism: false,
  },
});
