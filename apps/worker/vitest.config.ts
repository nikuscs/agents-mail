import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AGENTS_MAIL_TOKEN: "test-token-0123456789abcdef0123456789",
          AGENTS_MAIL_FROM: "Agent <agent@example.com>",
          MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
}));
