import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
