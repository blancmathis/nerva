import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  define: {
    __NERVA_VERSION__: JSON.stringify("0.1.0-test"),
    __NERVA_BUILD_ID__: JSON.stringify("0000000000000000"),
    __NERVA_BUILD_REVISION__: JSON.stringify("0000000000000000"),
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
