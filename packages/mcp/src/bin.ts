#!/usr/bin/env node
import { runStdio } from './index.js';

await runStdio({ workdir: process.env.NECROMANCER_WORKDIR });
