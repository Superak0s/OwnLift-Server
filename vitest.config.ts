import { defineConfig } from "vitest/config"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup-env.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    exclude: ["**/node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["**/*.ts"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "tests/**",
        "**/*.test.ts",
        "**/*.d.ts",
        "middleware/validation.check.ts",
      ],
    },
  },
})
