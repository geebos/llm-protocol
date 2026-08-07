import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/ir/**",
        "src/capabilities/**",
        "src/index.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        // NFR-009: 语句覆盖率 ≥85%；其余维度兜底
        statements: 85,
        lines: 85,
        functions: 90,
        branches: 70,
      },
    },
  },
});
