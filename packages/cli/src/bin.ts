#!/usr/bin/env node
import { createProgram } from './index.js';

createProgram()
  .parseAsync()
  .catch((err: unknown) => {
    process.stderr.write(`necromancer: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
