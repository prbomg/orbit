import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const output = process.argv[2];
if (!output || !resolve(output).endsWith('.tar.gz')) throw new Error('Usage: node scripts/package-release.mjs /path/to/orbit-release.tar.gz');
if (existsSync(output)) throw new Error('Output already exists');
// Explicit source allowlist. Never ship the committed legacy database, profiles,
// static export, node_modules, local environment or generated credentials.
const sources = ['app', 'components', 'hooks', 'lib', 'prisma/migrations', 'prisma/schema.prisma', 'prisma/seed.mjs', 'scripts', 'tests', 'utils', 'worker', 'patches', 'deploy', 'docs/local-v6.md', 'docs/client-hints.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'next.config.ts', 'next-env.d.ts', 'tsconfig.json', 'postcss.config.mjs', 'components.json', '.env.example', '.gitignore', 'README.md', 'AGENTS.md', 'proxy.ts'];
execFileSync('tar', ['-czf', resolve(output), '--', ...sources], { stdio: 'inherit' });
console.log(`Release saved: ${resolve(output)}`);
