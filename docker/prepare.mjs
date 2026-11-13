// Used by bootstrap.sh inside the n8n containers: copies the workflows for the
// n8n CLI and fills in the values of the local stack.
//   node prepare.mjs <output dir>
//
//   ENVIRONMENT   which environment this instance is (test, prod)
//   APPLY_TOKEN   what callers of the apply workflow send as X-Apply-Token

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out] = process.argv.slice(2);
const env = process.env;

const credentials = [
  // The key is filled in later (see README): only a logged-in owner can create one.
  { id: 'amN8nApiKey00001', name: 'Activation manifest n8n API key', type: 'n8nApi', data: { apiKey: 'not-set-yet', baseUrl: 'http://127.0.0.1:5678/api/v1' } },
  { id: 'amApplyToken0001', name: 'Activation manifest apply token', type: 'httpHeaderAuth', data: { name: 'X-Apply-Token', value: env.APPLY_TOKEN } },
  // For one lab workflow: a Redis server that is not there.
  { id: 'amRedisNowhere01', name: 'Activation manifest lab Redis (nowhere)', type: 'redis', data: { host: '127.0.0.1', port: 1, database: 0 } },
];

mkdirSync(join(out, 'workflows'), { recursive: true });
writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));
for (const folder of ['/bootstrap/workflows', '/bootstrap/lab/initial']) {
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.json'))) {
    const workflow = JSON.parse(readFileSync(join(folder, file), 'utf8'));
    for (const node of workflow.nodes) {
      if (node.name === 'Settings' && node.type === 'n8n-nodes-base.code' && env.ENVIRONMENT) {
        node.parameters.jsCode = node.parameters.jsCode.replace(/const ENVIRONMENT = .*;/, `const ENVIRONMENT = ${JSON.stringify(env.ENVIRONMENT)};`);
      }
    }
    writeFileSync(join(out, 'workflows', file), JSON.stringify(workflow));
  }
}
