// Build mintlify-docs/openapi.json from the filecheck-api repo.
//
// Two sources there:
//   - api/routes.mjs, the list of every public operation. The account
//     resources (workflows, rules, profiles, connectors, optimize presets,
//     destinations, product mappings, settings, webhooks) are generated from
//     it; the job endpoints below are still written out by hand.
//   - the JSON Schemas: the job request schemas in
//     _layers/mixins/nodejs/schemas and the resource schemas in api/schemas,
//     embedded verbatim (their internal #/ refs rewritten so they resolve
//     under components/schemas).
//
// Usage (from the repo root):
//   node scripts/build-openapi.mjs
//
// By default it expects filecheck-api to be a sibling of this repo:
//   <parent>/filecheck-api
//   <parent>/mintlify-docs   <- this repo
// Override with FILECHECK_API=/abs/path/to/filecheck-api if needed.
//
// Re-run this whenever the API request schemas or endpoints change. Do not
// hand-edit openapi.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const API_ROOT = process.env.FILECHECK_API || path.resolve(REPO_ROOT, '..', 'filecheck-api');
const SCHEMA_DIR = process.env.FILECHECK_API_SCHEMAS || path.join(API_ROOT, '_layers', 'mixins', 'nodejs', 'schemas');
const RESOURCE_SCHEMA_DIR = path.join(API_ROOT, 'api', 'schemas');
const OUT = path.resolve(REPO_ROOT, 'openapi.json');

for (const dir of [SCHEMA_DIR, RESOURCE_SCHEMA_DIR]) {
  if (!fs.existsSync(dir)) {
    console.error(`Schema directory not found: ${dir}`);
    console.error('Set FILECHECK_API to the filecheck-api checkout and retry.');
    process.exit(1);
  }
}

const routes = await import(pathToFileURL(path.join(API_ROOT, 'api', 'routes.mjs')).href);

// Load a request schema verbatim, strip $schema/$id, and rewrite in-document
// refs (#/...) so they resolve under this component's location.
function loadSchema(file, name, dir = SCHEMA_DIR) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  delete raw.$schema;
  delete raw.$id;
  const base = `#/components/schemas/${name}/`;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) {
          node[k] = base + v.slice(2);
        } else {
          walk(v);
        }
      }
    }
  };
  walk(raw);
  return raw;
}

const JobsPost          = loadSchema('jobs-post.json', 'JobsPost');
const JobsPreflightPost = loadSchema('jobs-preflight-post.json', 'JobsPreflightPost');
const JobsOptimizePost  = loadSchema('jobs-optimize-post.json', 'JobsOptimizePost');
const JobsValidatePost  = loadSchema('jobs-validate-post.json', 'JobsValidatePost');

const json = (ref) => ({ 'application/json': { schema: { $ref: ref } } });
const errorResponses = {
  '400': { description: 'Validation error', content: json('#/components/schemas/Error') },
  '401': { description: 'Missing or invalid key', content: json('#/components/schemas/Error') },
};

const jobSubmissionResponses = {
  '200': { description: 'Sync completion (sync: true)', content: json('#/components/schemas/JobResponse') },
  '201': { description: 'Accepted, processing asynchronously', content: json('#/components/schemas/JobResponse') },
  '202': { description: 'Sync timed out; still pending', content: json('#/components/schemas/JobPendingResponse') },
  ...errorResponses,
  '403': { description: 'A referenced fileRef is not owned by the caller', content: json('#/components/schemas/Error') },
};

// ---- account resources, generated from api/routes.mjs ----------------------

const pascal = id => id.split(/[-_]/).map(part => part[0].toUpperCase() + part.slice(1)).join('');

// api/schemas/<id>.json → component <Pascal id>: the writable record, also
// the request body of its create and update operations.
const resourceSchemas = Object.fromEntries(fs.readdirSync(RESOURCE_SCHEMA_DIR)
  .filter(file => file.endsWith('.json'))
  .map(file => {
    const name = pascal(file.replace(/\.json$/, ''));
    return [name, loadSchema(file, name, RESOURCE_SCHEMA_DIR)];
  }));

// What a stored record carries besides its writable fields.
const RecordFields = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The record id.' },
    source: { type: 'string', enum: ['domain', 'store'], description: '`domain`: yours. `store`: a built-in catalog record.' },
    customized: { type: 'boolean', description: 'Your own copy of a built-in record, under the same id. Revert drops it.' },
    draft: { type: 'boolean', description: 'Present and true on an unpublished draft.' },
    draftExpiresAt: { type: 'string', format: 'date-time', description: 'When an unpublished draft is deleted.' },
    created: { type: 'integer', description: 'Unix time (seconds).' },
    modified: { type: 'integer', description: 'Unix time (seconds).' },
  },
};

// Response shapes that have no request schema.
const responseOnly = {
  Deleted: { type: 'object', properties: { id: { type: 'string' }, deleted: { type: 'boolean', const: true } } },
  DestinationTest: { type: 'object', description: 'What the test delivery did: whether it connected and wrote the sample file, and the error when it did not.', additionalProperties: true },
  WebhookTest: { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: ['integer', 'null'], description: 'The HTTP status your endpoint answered.' }, error: { type: ['string', 'null'] } } },
  WebhookEvent: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, group: { type: 'string' } } },
  StoreProduct: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The product id in your store.' },
      title: { type: 'string' }, url: { type: ['string', 'null'] }, status: { type: ['string', 'null'] },
      workflowId: { type: ['string', 'null'], description: 'The workflow it is mapped to, if any.' },
      variants: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, sku: { type: ['string', 'null'] }, workflowId: { type: ['string', 'null'] } } } },
    },
  },
};

const ERROR_STATUS = {
  400: 'Invalid request: `code` says why, `param` names the field, `details` lists every problem',
  402: 'Job submissions are paused: the credit balance is exhausted',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict: `code` says why (in_use, draft_reference, not_a_draft, not_a_catalog_record, cart_not_supported)',
};

const responseSchemaFor = ({ schema }) => {
  if (resourceSchemas[pascal(schema)]) return { allOf: [{ $ref: `#/components/schemas/${pascal(schema)}` }, { $ref: '#/components/schemas/RecordFields' }] };
  if (responseOnly[pascal(schema)]) return { $ref: `#/components/schemas/${pascal(schema)}` };
  throw new Error(`no schema for response ${schema}`);
};

const generatedPaths = {};
for (const op of routes.operations.filter(o => o.response)) {
  const item = responseSchemaFor(op.response);
  const payload = {
    type: 'object',
    properties: {
      [op.response.key]: op.response.list ? { type: 'array', items: item } : item,
      ...(op.query?.some(q => q.name === 'dryRun') && { dryRun: { type: 'boolean', description: 'Present and true when nothing was saved.' } }),
      ...(op.id.startsWith('publish') && { published: { type: 'array', items: { type: 'string' }, description: 'Every id published, dependencies first.' } }),
      ...(op.id.startsWith('revert') && { reverted: { type: 'boolean', description: 'False when there was no copy to drop.' } }),
      ...(op.response.list && op.id === 'searchProducts' && { hasMore: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] } }),
    },
  };
  const statuses = [...new Set([...(op.body ? [400] : []), ...(op.errors || [])])];
  (generatedPaths[op.path] ??= {})[op.method.toLowerCase()] = {
    operationId: op.id,
    tags: [op.tag],
    summary: op.summary,
    ...(op.description && { description: op.description }),
    ...((op.params || op.query) && { parameters: [...(op.params || []), ...(op.query || [])] }),
    ...(op.body && {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${pascal(op.body)}` } } },
      },
    }),
    responses: {
      [String(op.status || 200)]: { description: 'OK', content: { 'application/json': { schema: payload } } },
      ...Object.fromEntries(statuses.map(status => [String(status), { description: ERROR_STATUS[status], content: json('#/components/schemas/Error') }])),
      '401': errorResponses['401'],
    },
  };
}

const sugarBody = (name) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } });

const spec = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'Filecheck API',
    version: '1.1.0',
    description: 'The Filecheck REST API. Submit files as jobs and fetch results, and set up your account: workflows, upload rules, preflight profiles, connectors, optimize presets, delivery destinations, product mappings, storefront settings and webhooks. All requests are authenticated server-side with your secret key (`sk_live_…`).',
  },
  servers: [{ url: 'https://api.filecheck.io', description: 'Production' }],
  security: [{ bearerAuth: [] }],
  tags: routes.tags,
  paths: {
    '/jobs': {
      post: {
        tags: ['Jobs'],
        summary: 'Submit a job',
        description: 'Canonical job submission. Each entry in `sources[]` is one source file plus the ordered `steps[]` to run on it, unless `ruleId`, `workflowId` or `previewWorkflow` decides the steps: then the files go through that intake, as on the storefront. Draft rules and workflows work too, and `previewWorkflow` runs an unsaved one, so a setup can be tried on real files before it goes live. Async (201) by default; set `sync: true` to wait up to ~27s.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JobsPost' } } } },
        responses: jobSubmissionResponses,
      },
      get: {
        tags: ['Jobs'],
        summary: 'List jobs',
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { jobs: { type: 'array', items: { $ref: '#/components/schemas/Job' } } } } } } },
          ...errorResponses,
        },
      },
    },
    '/jobs/{id}': {
      get: {
        tags: ['Jobs'],
        summary: 'Get a job',
        description: 'Returns the full Job with child Tasks and steps. Use `?expand=runs` for a flattened per-file summary with proof and download URLs.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', required: false, schema: { type: 'string', enum: ['runs'] }, description: 'Set to `runs` to return a flattened per-file summary instead of the full job.' },
        ],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/JobResponse' }, { $ref: '#/components/schemas/RunsResponse' }] } } } },
          '404': { description: 'Job not found', content: json('#/components/schemas/Error') },
          ...errorResponses,
        },
      },
      delete: {
        tags: ['Jobs'],
        summary: 'Delete a job',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Deleted' }, '404': { description: 'Job not found', content: json('#/components/schemas/Error') }, ...errorResponses },
      },
    },
    '/jobs/preflight': { post: { tags: ['Jobs'], summary: 'Preflight a file', description: 'Sugar wrapper. Runs a preflight-only job. Async (201) by default; `sync: true` waits for the result.', requestBody: sugarBody('JobsPreflightPost'), responses: jobSubmissionResponses } },
    '/jobs/fix':       { post: { tags: ['Jobs'], summary: 'Fix a file', description: 'Sugar wrapper for preflight + autofix, plus an optional re-preflight when `repreflight: true`. Async (201) by default.', requestBody: sugarBody('FixPost'), responses: jobSubmissionResponses } },
    '/jobs/optimize':  { post: { tags: ['Jobs'], summary: 'Optimize a file', description: 'Sugar wrapper. Runs an optimize-only job. Async (201) by default; `sync: true` waits for the result.', requestBody: sugarBody('JobsOptimizePost'), responses: jobSubmissionResponses } },
    '/jobs/validate':  { post: { tags: ['Jobs'], summary: 'Validate a file', description: 'Sugar wrapper. Validates a file against one or more PDF/A or PDF/UA conformance levels. Sync by default; set `async: true` to return 201 immediately.', requestBody: sugarBody('JobsValidatePost'), responses: jobSubmissionResponses } },
    '/jobs/previews':  { post: { tags: ['Jobs'], summary: 'Generate previews', description: 'Sugar wrapper. Renders preview images for a file. Async (201) by default; `sync: true` waits for the result.', requestBody: sugarBody('PreviewsPost'), responses: jobSubmissionResponses } },
    '/uploads': {
      post: {
        tags: ['Uploads'],
        summary: 'Create an upload',
        description: 'Mints presigned S3 POST credentials so a client can upload a large file directly (up to 500 MB). Returns a `fileRef` usable as a job source. Credentials expire in 300 seconds.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadRequest' } } } },
        responses: { '200': { description: 'OK', content: json('#/components/schemas/UploadResponse') }, ...errorResponses, '500': { description: 'Failed to create upload credentials', content: json('#/components/schemas/Error') } },
      },
    },
    '/orders/{id}': {
      post: {
        tags: ['Orders'],
        summary: 'Capture an order',
        description: 'Records a commerce order and links its line items (and their Filecheck `jobId`s) to the caller. Currently shaped for WooCommerce (`source: "wp"`).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderRequest' } } } },
        responses: { '200': { description: 'Order captured' }, ...errorResponses },
      },
    },
    ...generatedPaths,
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Your secret key as a bearer token, e.g. `Authorization: Bearer sk_live_…`. Secret keys are server-side only.' },
    },
    schemas: {
      JobsPost, JobsPreflightPost, JobsOptimizePost, JobsValidatePost,
      PreviewsPost: {
        type: 'object', required: ['sources'], additionalProperties: false,
        properties: {
          sources: { type: 'array', minItems: 1, items: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string', description: 'Base64 file payload' }, fileRef: { type: 'string' }, params: { type: 'object' } } } },
          sync: { type: 'boolean', default: false }, webhook: { type: 'string' }, metaData: { type: 'object' },
        },
      },
      FixPost: {
        type: 'object', required: ['sources'], additionalProperties: false,
        properties: {
          sources: { type: 'array', minItems: 1, items: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string', description: 'Base64 file payload' }, fileRef: { type: 'string' }, profileId: { type: 'string' }, items: { type: 'array', items: { type: 'string' }, description: 'Specific autofix items to apply; omit to let Filecheck choose defaults.' } } } },
          repreflight: { type: 'boolean', default: false, description: 'Re-run preflight after autofix to confirm the result.' },
          sync: { type: 'boolean', default: false }, webhook: { type: 'string' }, metaData: { type: 'object' },
        },
      },
      UploadRequest: {
        type: 'object', additionalProperties: false,
        properties: { mimeType: { type: 'string', description: 'Content type of the file you intend to upload.' }, sizeBytes: { type: 'integer', description: 'Expected size in bytes. Capped at 500 MB.' } },
      },
      UploadResponse: {
        type: 'object',
        properties: {
          fileRef: { type: 'string', description: 'Pass this as a job source.' },
          upload: { type: 'object', properties: { url: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, method: { type: 'string', enum: ['POST'] } } },
          maxBytes: { type: 'integer' }, expiresIn: { type: 'integer', description: 'Seconds until the credentials expire.' },
        },
      },
      OrderRequest: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['wp'], default: 'wp' },
          orderId: { type: 'string' }, status: { type: 'string' }, currency: { type: 'string' }, total: {},
          customer: { type: 'object', properties: { id: {}, email: { type: 'string' } } },
          items: { type: 'array', items: { type: 'object', properties: { jobId: { type: 'string' }, itemId: {}, productId: {}, name: { type: 'string' }, quantity: {}, sku: { type: 'string' }, total: {} } } },
        },
      },
      Step: {
        type: 'object',
        properties: {
          id: { type: 'string' }, type: { type: 'string', description: 'preflight, repreflight, autofix, optimize, validate, previews, proof' },
          status: { type: 'string' }, outcome: { type: ['string', 'null'], enum: ['pass', 'warn', 'fail', null] },
          reason: { type: ['string', 'null'] }, params: { type: ['object', 'null'] }, runtimeParams: { type: ['object', 'null'] },
          started: { type: ['string', 'null'] }, ended: { type: ['string', 'null'] }, duration: { type: ['number', 'null'] },
          outputs: { type: 'array', items: { type: 'object' } },
        },
      },
      OutputArtifact: {
        type: 'object',
        properties: { kind: { type: 'string' }, role: { type: 'string' }, bucket: { type: 'string' }, key: { type: 'string' }, downloadUrl: { type: ['string', 'null'] }, expiresIn: { type: ['integer', 'null'] } },
      },
      Task: {
        type: 'object',
        properties: {
          id: { type: 'string' }, createdAt: { type: ['string', 'null'] }, updatedAt: { type: ['string', 'null'] },
          status: { type: 'string' }, outcome: { type: ['string', 'null'] }, fileType: { type: ['string', 'null'] }, mimeType: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] }, fileRef: { type: ['string', 'null'] }, clientRef: { type: ['string', 'null'] }, jobId: { type: ['string', 'null'] },
          originalArtifact: { type: ['object', 'null'] }, outputArtifacts: { type: 'array', items: { $ref: '#/components/schemas/OutputArtifact' } },
          steps: { type: 'array', items: { $ref: '#/components/schemas/Step' } },
        },
      },
      Job: {
        type: 'object',
        properties: {
          id: { type: 'string' }, createdAt: { type: ['string', 'null'] }, modifiedAt: { type: ['string', 'null'] },
          status: { type: 'string', description: 'idle, incomplete, uploading, processing, ready, partial, rejected' },
          outcome: { type: ['string', 'null'] }, channel: { type: ['string', 'null'], enum: ['api', 'store', 'admin', null] },
          ruleId: { type: ['string', 'null'] }, workflowId: { type: ['string', 'null'] }, metaData: { type: ['object', 'null'] },
          tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
          orderId: { type: ['string', 'null'] }, customerId: { type: ['string', 'null'] }, customerEmail: { type: ['string', 'null'] },
          summary: { type: 'object', description: 'Present on non-lean responses.' },
          results: { type: 'object', description: 'Aggregated validate / preflight / optimize results on non-lean responses.' },
        },
      },
      Run: {
        type: 'object',
        description: 'A flattened per-file view returned by ?expand=runs.',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          outcome: { type: ['string', 'null'], enum: ['pass', 'warn', 'fail', null] }, status: { type: ['string', 'null'] },
          hasOutput: { type: 'boolean' }, proofs: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
          downloadUrl: { type: ['string', 'null'] },
        },
      },
      JobResponse: { type: 'object', properties: { job: { $ref: '#/components/schemas/Job' } } },
      JobPendingResponse: { type: 'object', properties: { pending: { type: 'boolean' }, job: { $ref: '#/components/schemas/Job' } } },
      RunsResponse: { type: 'object', properties: { runs: { type: 'array', items: { $ref: '#/components/schemas/Run' } } } },
      ...resourceSchemas,
      RecordFields,
      ...responseOnly,
      Error: {
        type: 'object',
        properties: {
          error: { type: 'boolean', const: true },
          code: { type: 'string', description: 'Machine-readable reason, such as validation_failed, invalid_reference, not_found, in_use, draft_reference.' },
          message: { type: 'string' },
          param: { type: 'string', description: 'The field at fault, as a dotted path (intake.ruleId, accepts.0.preflight.profileId).' },
          details: { type: 'array', description: 'Every problem found, or the records that block a delete.', items: { type: 'object', additionalProperties: true } },
          requestId: { type: 'string', description: 'Quote it to support.' },
        },
      },
    },
  },
};

fs.writeFileSync(OUT, JSON.stringify(spec, null, 2));
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${Object.keys(spec.paths).length} paths)`);
