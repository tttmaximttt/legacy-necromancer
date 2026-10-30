#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';

// stdout carries the MCP protocol, so nothing else may write to it.
await createServer({ workdir: process.env.NECROMANCER_WORKDIR }).connect(new StdioServerTransport());
