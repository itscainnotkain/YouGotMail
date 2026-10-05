import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { builtinModules } from 'node:module';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SETUP_TOKEN: 'test-setup-key-unique-32-characters-long',
          APP_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['sanitize-html'],
          rolldownOptions: {
            external: [
              ...builtinModules,
              ...builtinModules.map((m) => `node:${m}`),
            ],
          },
        },
      },
    },
  },
});
