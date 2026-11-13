// npm run test:e2e
// Starts the test stack (two n8n instances on SQLite, standing in for TEST and
// PROD), runs test/e2e.test.mjs against it and removes the stack again. The
// tests import workflows into the running containers, so they need the docker
// CLI. Takes about 3 minutes. Set KEEP_STACK=1 to leave the stack running, for
// example to open the editors on http://localhost:55689 (TEST) and
// http://localhost:55690 (PROD) with owner@example.com / Lab-owner-1234,
// created by the tests.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 'activation-test'];
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1;

run('docker', [...compose, 'down', '-v']);
let status = run('docker', [...compose, 'up', '-d']);
if (status === 0) status = run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'test/e2e.test.mjs']);
if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60']);
if (!process.env.KEEP_STACK) run('docker', [...compose, 'down', '-v']);
process.exit(status);
