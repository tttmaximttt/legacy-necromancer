import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// An empty home for tests, reused across runs so none are left behind.
const testHome = path.join(os.tmpdir(), 'necromancer-test-home');
mkdirSync(testHome, { recursive: true });

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@necromancer/core': pkg('core'),
      '@necromancer/excavate': pkg('excavate'),
      '@necromancer/mcp': pkg('mcp'),
      '@necromancer/graveyard': pkg('graveyard'),
      '@necromancer/llm': pkg('llm'),
      '@necromancer/interview': pkg('interview'),
      '@necromancer/resurrect': pkg('resurrect'),
      '@necromancer/witness': pkg('witness'),
      '@necromancer/plan': pkg('plan'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    // Keep tests off the real API even when the developer has a key, in the shell or in ~/.necromancer/.env
    // (hence the empty home); tests inject a ScriptedModel.
    env: {
      HOME: testHome,
      USERPROFILE: testHome,
      NECROMANCER_ANTHROPIC_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
    },
  },
});
