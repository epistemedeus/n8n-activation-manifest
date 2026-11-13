// Builds workflows/*.json and lab/**/*.json.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the Code nodes can be written as normal
// JavaScript, and so the apply workflow carries the very same plan() and
// settle() functions as apply-manifest.mjs. After changing either, run:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, settle } from '../apply-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const APPLY = 'amApply000000001';
const CREDENTIALS = {
  n8nApi: { n8nApi: { id: 'amN8nApiKey00001', name: 'Activation manifest n8n API key' } },
  token: { httpHeaderAuth: { id: 'amApplyToken0001', name: 'Activation manifest apply token' } },
};

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// The body of a function, as the text of a Code node.
const code = (fn) => {
  const text = fn.toString();
  const lines = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).replace(/^\n/, '').trimEnd().split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(indent)).join('\n');
};

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const api = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return api.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0, input = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: input });
    },
    chain(...names) {
      for (let i = 1; i < names.length; i++) api.link(names[i - 1], names[i]);
    },
  };
  build(api);
  return { name, nodes, connections, settings: { executionOrder: 'v1' }, pinData: {}, id, active: false };
}

const isTrue = (expression) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uuid(expression), leftValue: expression, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});

// --- Apply activation manifest ---------------------------------------------------

/* eslint-disable no-undef */
function settings() {
  // Which environment of the manifest this instance is. A call that names
  // another environment is refused, so a PROD call sent to TEST does nothing.
  const ENVIRONMENT = 'prod';

  // The public API of this same instance.
  const API_URL = 'http://127.0.0.1:5678/api/v1';

  // 'publish': POST /workflows/{id}/publish and /unpublish.
  // 'activate': the older /activate and /deactivate.
  const ENDPOINTS = 'publish';

  const body = $input.first().json.body ?? {};
  return [
    {
      json: {
        environment: ENVIRONMENT,
        asked: body.environment ?? null,
        apiUrl: API_URL.replace(/\/+$/, ''),
        endpoints: ENDPOINTS,
        // Changes are made only when the call says "dryRun": false.
        dryRun: body.dryRun !== false,
        stale: body.stale,
        manifest: body.manifest,
        self: $workflow.id,
      },
    },
  ];
}

function planNode() {
  // PLAN_FUNCTION
  const s = $('Settings').first().json;
  const workflows = $input.all().flatMap((page) => page.json.data ?? []);
  const planned =
    s.asked === s.environment
      ? plan(s.manifest, s.environment, workflows, { stale: s.stale, self: s.self })
      : { errors: [`this instance is "${s.environment}", the call asked for "${s.asked}"`], rows: [], actions: [] };
  return [{ json: { planned } }];
}

function steps() {
  // One item per API call, unpublish before publish. A dry run makes none.
  const s = $('Settings').first().json;
  const { actions } = $input.first().json.planned;
  if (s.dryRun || actions.length === 0) return [{ json: { none: true } }];
  const path = { publish: s.endpoints === 'activate' ? 'activate' : 'publish', unpublish: s.endpoints === 'activate' ? 'deactivate' : 'unpublish' };
  return actions.map((step) => ({
    json: {
      id: step.id,
      action: step.action,
      url: `${s.apiUrl}/workflows/${encodeURIComponent(step.id)}/${path[step.action]}`,
      body: step.action === 'publish' && step.versionId ? { versionId: step.versionId } : {},
    },
  }));
}

async function settleNode() {
  // Unpublish answers before n8n has taken the webhooks down. A publish of a
  // workflow with the same webhook path that comes too early gets a 409, and
  // on n8n 2.47.7 keeps getting it afterwards. So wait once.
  const SETTLE_SECONDS = 3;
  const unpublished = $('Steps').all().some((item) => item.json.action === 'unpublish');
  if (unpublished) await new Promise((resolve) => setTimeout(resolve, SETTLE_SECONDS * 1000));
  return $input.all();
}

function report() {
  // SETTLE_FUNCTION
  const s = $('Settings').first().json;
  const planned = $('Plan').first().json.planned;
  const results = {};
  let after = null;
  const steps = $('Steps').all().map((item) => item.json);
  for (const [node, action] of [['Unpublish', 'unpublish'], ['Publish', 'publish']]) {
    if (!$(node).isExecuted) continue;
    const sent = steps.filter((step) => step.action === action);
    $(node).all().forEach((item, index) => {
      const answer = item.json;
      results[sent[index].id] = { status: Number(answer.statusCode ?? 0), message: answer.body?.message ?? answer.error?.message ?? JSON.stringify(answer.body ?? '').slice(0, 300) };
    });
  }
  if ($('List again').isExecuted) after = $('List again').all().flatMap((page) => page.json.data ?? []);
  const result = { environment: s.environment, ...settle(planned, results, after, s.dryRun) };
  return [{ json: { httpStatus: result.errors.length > 0 ? 400 : result.ok ? 200 : 409, result } }];
}
/* eslint-enable no-undef */

const withFunction = (text, marker, fn) => text.replace(`// ${marker}`, `const ${fn.name} = ${fn.toString()};\n`);

const list = (url) => ({
  url,
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'n8nApi',
  sendQuery: true,
  queryParameters: {
    parameters: [
      { name: 'limit', value: '250' },
      { name: 'excludePinnedData', value: 'true' },
    ],
  },
  options: {
    pagination: {
      pagination: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'cursor', value: '={{ $response.body.nextCursor }}' }] },
        paginationCompleteWhen: 'other',
        completeExpression: '={{ !$response.body.nextCursor }}',
        limitPages: true,
        maxRequests: 100,
      },
    },
    timeout: 60000,
  },
});

const apply = workflow(APPLY, 'Apply activation manifest', (w) => {
  w.note(
    'About',
    [
      '## Apply activation manifest',
      'Makes this instance match an activation manifest: which workflows are active here, which are not.',
      '',
      '`POST /webhook/activation-manifest/apply` with header `X-Apply-Token` and the body',
      '`{ "environment": "prod", "dryRun": false, "manifest": { ... } }`',
      '',
      '- Without `"dryRun": false` nothing is changed, the answer says what would change.',
      '- A workflow is activated only when the manifest lists it as `active` for this environment.',
      '- Everything not listed is deactivated (`"default": "inactive"`) or left alone (`"default": "ignore"`).',
      '- This workflow never deactivates itself.',
      '',
      '**To set up:** edit **Settings**, give the four HTTP nodes an *n8n API* credential',
      '(scopes `workflow:list`, `workflow:activate`, `workflow:deactivate`) and the webhook a *Header Auth* credential.',
    ],
    [-560, -400],
    640,
    330,
  );
  w.node(
    'Apply',
    'webhook',
    2,
    [-520, 0],
    { httpMethod: 'POST', path: 'activation-manifest/apply', authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
    { webhookId: uuid('activation-manifest/apply'), credentials: CREDENTIALS.token },
  );
  w.node('Settings', 'code', 2, [-280, 0], { jsCode: code(settings) });
  w.node('List workflows', 'httpRequest', 4.2, [-40, 0], list('={{ $json.apiUrl }}/workflows'), { credentials: CREDENTIALS.n8nApi });
  w.node('Plan', 'code', 2, [200, 0], { jsCode: withFunction(code(planNode), 'PLAN_FUNCTION', plan) });
  w.node('Steps', 'code', 2, [440, 0], { jsCode: code(steps) });
  w.node('Anything to do?', 'if', 2.2, [680, 0], isTrue('={{ !$json.none }}'));
  // One call at a time, in order.
  const call = {
    method: 'POST',
    url: '={{ $json.url }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'n8nApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 0 } }, response: { response: { fullResponse: true, neverError: true } }, timeout: 60000 },
  };
  w.node('Unpublish or publish?', 'if', 2.2, [920, -100], isTrue("={{ $json.action === 'unpublish' }}"));
  w.node('Unpublish', 'httpRequest', 4.2, [1160, -220], call, { credentials: CREDENTIALS.n8nApi, onError: 'continueRegularOutput' });
  w.node('Let n8n settle', 'code', 2, [1160, 0], { jsCode: code(settleNode) });
  w.node('Publish', 'httpRequest', 4.2, [1400, 0], call, { credentials: CREDENTIALS.n8nApi, onError: 'continueRegularOutput' });
  w.node('Both done', 'merge', 3, [1640, -100], {});
  w.node('List again', 'httpRequest', 4.2, [1880, -100], list("={{ $('Settings').first().json.apiUrl }}/workflows"), { credentials: CREDENTIALS.n8nApi, executeOnce: true });
  w.node('Report', 'code', 2, [2120, 0], { jsCode: withFunction(code(report), 'SETTLE_FUNCTION', settle) });
  w.node('Answer', 'respondToWebhook', 1.1, [2360, 0], { respondWith: 'json', responseBody: '={{ JSON.stringify($json.result) }}', options: { responseCode: '={{ $json.httpStatus }}' } });

  w.chain('Apply', 'Settings', 'List workflows', 'Plan', 'Steps', 'Anything to do?');
  w.link('Anything to do?', 'Unpublish or publish?', 0);
  // Output 0 (unpublish) is the upper branch: n8n runs it to its end first.
  w.link('Unpublish or publish?', 'Unpublish', 0);
  w.link('Unpublish', 'Both done', 0, 0);
  w.link('Unpublish or publish?', 'Let n8n settle', 1);
  w.chain('Let n8n settle', 'Publish');
  w.link('Publish', 'Both done', 0, 1);
  w.chain('Both done', 'List again', 'Report');
  w.link('Anything to do?', 'Report', 1);
  w.link('Report', 'Answer');
});

// --- lab workflows: what the "Git repository" holds --------------------------------

// A webhook that answers which workflow and which version of it is live.
const lab = (id, name, slug, { path = `lab/${slug}`, version = 'v1', schedule = false } = {}) =>
  workflow(id, name, (w) => {
    w.node('Called', 'webhook', 2, [-260, 0], { httpMethod: 'GET', path, responseMode: 'lastNode', options: {} }, { webhookId: uuid(`${id}/${path}`) });
    if (schedule) w.node('Every night', 'scheduleTrigger', 1.2, [-260, 200], { rule: { interval: [{ field: 'cronExpression', expression: '0 0 3 * * *' }] } });
    w.node('Answer', 'set', 3.4, [-20, 0], {
      assignments: {
        assignments: [
          { id: uuid(`${id}/workflow`), name: 'workflow', value: slug, type: 'string' },
          { id: uuid(`${id}/version`), name: 'version', value: version, type: 'string' },
        ],
      },
      options: {},
    });
    w.link('Called', 'Answer');
    if (schedule) w.link('Every night', 'Answer');
  });

const initial = {
  '1-order-intake': lab('amOrders00000001', 'Order intake', 'orders'),
  '2-daily-reconciliation': lab('amReconcile00001', 'Daily reconciliation', 'reconcile', { schedule: true }),
  '3-smoke-test': lab('amSmoke000000001', 'Smoke test', 'smoke'),
  '4-wip-experiment': lab('amWip00000000001', 'WIP experiment', 'wip'),
};

// Workflows that "arrive with a later pull": the tests import them into the
// running instances.
const later = {
  'invoice-export': lab('amInvoices000001', 'Invoice export', 'invoices'),
  // Takes over the webhook path of Order intake.
  'order-intake-next': lab('amOrdersNext0001', 'Order intake (next)', 'orders-next', { path: 'lab/orders' }),
  'same-name-1': lab('amTwinOne0000001', 'Twin', 'twin-1'),
  'same-name-2': lab('amTwinTwo0000001', 'Twin', 'twin-2'),
  // Triggers that cannot start.
  'broken-no-trigger': workflow('amNoTrigger00001', 'Broken: no trigger', (w) => {
    w.node('Run by hand', 'manualTrigger', 1, [-260, 0], {});
    w.node('Answer', 'set', 3.4, [-20, 0], { assignments: { assignments: [] }, options: {} });
    w.link('Run by hand', 'Answer');
  }),
  'broken-cron': workflow('amBadCron0000001', 'Broken: bad cron expression', (w) => {
    w.node('Schedule', 'scheduleTrigger', 1.2, [-260, 0], { rule: { interval: [{ field: 'cronExpression', expression: 'not a cron expression' }] } });
    w.node('Answer', 'set', 3.4, [-20, 0], { assignments: { assignments: [] }, options: {} });
    w.link('Schedule', 'Answer');
  }),
  'broken-missing-credential': workflow('amNoCredential01', 'Broken: trigger without its credential', (w) => {
    w.node('New mail', 'emailReadImap', 2, [-260, 0], { options: {} });
    w.node('Answer', 'set', 3.4, [-20, 0], { assignments: { assignments: [] }, options: {} });
    w.link('New mail', 'Answer');
  }),
  'broken-unreachable': workflow('amUnreachable001', 'Broken: trigger cannot reach its server', (w) => {
    w.node('New message', 'redisTrigger', 1, [-260, 0], { channels: 'lab', options: {} }, { credentials: { redis: { id: 'amRedisNowhere01', name: 'Activation manifest lab Redis (nowhere)' } } });
    w.node('Answer', 'set', 3.4, [-20, 0], { assignments: { assignments: [] }, options: {} });
    w.link('New message', 'Answer');
  }),
};

const write = (folder, name, json) => {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${folder}/${name}.json`);
};
write('workflows', 'apply-activation-manifest', apply);
for (const [name, json] of Object.entries(initial)) write('lab/initial', name, json);
for (const [name, json] of Object.entries(later)) write('lab/later', name, json);
