import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExhumeReport } from '@necromancer/core';
import { exhume as runExhume, type ExhumeOptions } from '@necromancer/excavate';

export interface ServerOptions {
  /** Injected in tests; defaults to the real excavator. */
  exhume?: (source: string, options: ExhumeOptions) => Promise<ExhumeReport>;
  /** Where remote repos are cloned. */
  workdir?: string;
}

/** Per-cluster file lists and lockfile notes get long on big repos; summaries keep the agent's context small. */
const SUMMARY_FILES_PER_CLUSTER = 8;
const SUMMARY_INFO_FINDINGS = 10;

export function createServer(options: ServerOptions = {}): McpServer {
  const exhume = options.exhume ?? runExhume;
  const server = new McpServer({ name: 'necromancer', version: '0.0.0' });

  server.registerTool(
    'exhume',
    {
      title: 'Exhume a repository',
      description:
        'Reconstruct the architecture of a JavaScript/TypeScript repository: module clusters, the most ' +
        'load-bearing files (blast radius, betweenness, git churn), external packages, git history span, ' +
        'install-time scripts that look suspicious, and imports that only work on case-insensitive filesystems. ' +
        'Read-only: clones the repo and parses it, never installs or runs anything. Takes seconds for most repos.',
      inputSchema: {
        source: z.string().min(1).describe('Git URL (https or ssh) or a local directory path'),
        top: z.number().int().min(1).max(50).default(5).describe('How many load-bearing files to return'),
        includeTests: z.boolean().default(false).describe('Treat test files as architecture too'),
        detail: z
          .enum(['summary', 'full'])
          .default('summary')
          .describe('"summary" trims cluster file lists and low-severity findings; "full" returns everything'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source, top, includeTests, detail }, extra) => {
      const progressToken = extra._meta?.progressToken;
      let step = 0;
      try {
        const report = await exhume(source, {
          top,
          includeTests,
          workdir: options.workdir,
          onProgress: (message) => {
            if (progressToken === undefined) return;
            void extra
              .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++step, message } })
              .catch(() => {});
          },
        });
        const body = detail === 'full' ? report : summarize(report);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `exhume failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.registerPrompt(
    'autopsy',
    {
      title: 'Autopsy an abandoned repo',
      description: 'Exhume a repository and judge whether it is worth reviving.',
      argsSchema: { source: z.string().describe('Git URL or local path') },
    },
    ({ source }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Run the necromancer \`exhume\` tool on ${source}. From the report, tell me: what the project is and how ` +
              'it is structured (name the clusters by what they do, not by folder), which files are load-bearing and why, ' +
              'how long ago it died, anything risky in its install scripts or imports, and whether it looks worth reviving. ' +
              'Quote numbers from the report; do not guess beyond it.',
          },
        },
      ],
    }),
  );

  return server;
}

/** Same shape as the report, with long lists cut and a note of how much was cut. */
export function summarize(report: ExhumeReport) {
  const info = report.installScripts.filter((f) => f.severity === 'info');
  return {
    ...report,
    clusters: report.clusters.map(({ files, ...c }) => ({
      ...c,
      files: files.slice(0, SUMMARY_FILES_PER_CLUSTER),
      ...(files.length > SUMMARY_FILES_PER_CLUSTER && { moreFiles: files.length - SUMMARY_FILES_PER_CLUSTER }),
    })),
    orphans: report.orphans.slice(0, 20),
    externalPackages: report.externalPackages.slice(0, 30),
    manifests: report.manifests.map(({ manifest, name, engines, dependencies, devDependencies }) => ({
      manifest,
      name,
      engines,
      dependencies: Object.keys(dependencies).length,
      devDependencies: Object.keys(devDependencies).length,
    })),
    installScripts: [
      ...report.installScripts.filter((f) => f.severity !== 'info'),
      ...info.slice(0, SUMMARY_INFO_FINDINGS),
    ],
    truncated: {
      orphans: Math.max(0, report.orphans.length - 20),
      externalPackages: Math.max(0, report.externalPackages.length - 30),
      infoInstallScripts: Math.max(0, info.length - SUMMARY_INFO_FINDINGS),
      hint: 'Call exhume again with detail "full" for complete lists and per-manifest dependency versions.',
    },
  };
}
