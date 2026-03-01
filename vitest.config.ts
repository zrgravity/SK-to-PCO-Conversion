import { defineConfig } from "vitest/config";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Local D1 bindings for tests
          d1Databases: { DB: "test-db" },
          // Env vars for tests
          bindings: {
            PCO_APP_ID: "test-app-id",
            PCO_APP_SECRET: "test-app-secret",
            CF_ACCESS_AUD: "",
          },
        },
      },
    },
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
