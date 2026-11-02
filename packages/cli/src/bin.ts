#!/usr/bin/env node
import { errorMessage } from '@necromancer/core';
import { createProgram } from './index.js';

createProgram()
  .parseAsync()
  .catch((err: unknown) => {
    process.stderr.write(`necromancer: ${errorMessage(err)}\n`);
    process.exit(1);
  });
