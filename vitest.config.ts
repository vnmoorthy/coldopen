import { defineConfig } from "vitest/config";

// Unit tests run in plain Node: every module under test is pure TypeScript plus fetch/WebCrypto,
// which Node provides. Network calls are always stubbed (see test/fixtures.ts stubFetch).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    unstubGlobals: true,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
