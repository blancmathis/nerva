import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __NERVA_VERSION__: JSON.stringify("0.1.0-test"),
    __NERVA_BUILD_ID__: JSON.stringify("0000000000000000"),
  },
  test: {
    coverage: {
      enabled: false,
    },
    exclude: ["**/dist/**", "**/node_modules/**", "**/e2e/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "apps/bridge/**/*.test.ts",
            "packages/**/*.test.ts",
            "packages/**/*.test.tsx",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/**/*.test.ts", "apps/web/**/*.test.tsx"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
    testTimeout: 15_000,
  },
});
