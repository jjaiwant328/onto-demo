// Client for the deployed ontos app (governance system of record). This is
// the whole surface the server wires into its endpoints; everything else
// about ontos stays out of this repo.
//
// Endpoint shapes follow the ontos source/docs (github.com/databrickslabs/
// ontos, `development` branch — src/backend/src/routes/{data_contracts,data_
// product}_routes.py and website/ontos/docs/dev_guide/api/*.md). The live app's
// Swagger at ${baseUrl}/docs is OAuth-gated, so the repo is the source of
// truth used here:
//   - POST /api/data-contracts/upload      multipart ODCS file (YAML or JSON)
//   - POST /api/data-products/from-contract
//   - GET  /api/data-products/{id}
//   - GET  /api/data-contracts/{id}
// Note: POST /api/data-contracts/odcs/import only accepts a JSON object body
// (a pasted contract document), NOT a YAML string, so the YAML upload goes
// through /upload.
//
// Errors are humanized the way shared/stateError.ts humanizes app-state
// failures: status + a short response snippet, never raw fetch internals.
import type {
  ContractValidationState,
  DataProductSummary,
  OntosClientConfig,
} from '../shared/ontosTypes';
import { getSpGateToken } from './spGateToken';

export interface OntosClient {
  importOdcsContract(yaml: string): Promise<{ contractId: string }>;
  activateContract(contractId: string): Promise<void>;
  createProductFromContract(contractId: string, name: string): Promise<{ productId: string }>;
  getProduct(id: string): Promise<DataProductSummary | null>;
  getContractValidationState(contractId: string): Promise<ContractValidationState>;
}

const BODY_SNIPPET_LIMIT = 200;

interface OntosResponse {
  status: number;
  body: unknown;
}

// First non-empty string among `keys` on a record-ish value.
function firstString(value: unknown, keys: string[]): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// First object among `keys` on a record-ish value (validation payloads have no
// fixed home yet, so several spellings are tolerated).
function firstRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

type CheckStatus = ContractValidationState['checks'][number]['status'];

// A check's status is a boolean (passed), a string, or nothing at all — map
// whatever showed up onto the three states a check can report.
function checkStatusOf(raw: unknown): CheckStatus {
  if (raw === true) return 'pass';
  if (raw === false) return 'fail';
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (/(fail|violat)/.test(s)) return 'fail';
  if (/(error|exception)/.test(s)) return 'error';
  if (/(pass|succeed|ok|valid)/.test(s)) return 'pass';
  return 'error';
}

function mapChecks(raw: unknown): ContractValidationState['checks'] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i) => {
    const check = (entry ?? {}) as Record<string, unknown>;
    const message = firstString(check, ['message', 'detail', 'details']);
    return {
      name: firstString(check, ['name', 'check_type', 'checkType', 'id']) ?? `check_${i + 1}`,
      status: checkStatusOf(check.passed ?? check.status ?? check.result),
      ...(message ? { message } : {}),
    };
  });
}

// Roll the individual checks into an overall state. Failed checks win over
// any run-level claim; a still-running run is pending; with no checks to roll
// up, infer from the run-level status.
function overallStatus(
  raw: unknown,
  checks: ContractValidationState['checks']
): ContractValidationState['status'] {
  const run = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (/(running|pending|queued|in_progress)/.test(run)) return 'pending';
  if (checks.length > 0) return 'pass';
  if (!run) return 'pending';
  if (/(fail|violat)/.test(run)) return 'fail';
  if (/(error|exception)/.test(run)) return 'error';
  if (/(pass|succeed|ok|valid)/.test(run)) return 'pass';
  return 'unknown';
}

// ontos has no REST endpoint for validation runs (they live in its workflow
// tables), so the state is inferred from the contract's lifecycle status: an
// active/approved contract passed its gates; a breaking one did not; anything
// still in flight is pending; anything unrecognized is unknown.
function lifecycleToState(raw: unknown): ContractValidationState['status'] {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s) return 'unknown';
  if (/(active|approved|certified|published)/.test(s)) return 'pass';
  if (/(breaking|rejected|failed|error)/.test(s)) return 'fail';
  if (/(draft|proposed|review|pending)/.test(s)) return 'pending';
  return 'unknown';
}

export function createOntosClient(cfg: OntosClientConfig): OntosClient {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const fetchImpl = cfg.fetchImpl ?? fetch;
  // SP OAuth token for the Apps gate; null (offline) → no Authorization
  // header and the request goes out exactly as it did before the gate.
  const gateToken = cfg.gateToken ?? getSpGateToken;

  async function request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string | FormData } = {},
    allowNotFound = false
  ): Promise<OntosResponse> {
    // minted before the try so a mint failure surfaces its own humanized
    // error rather than "could not reach the ontos app"
    const gate = await gateToken();
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api${path}`, {
        method,
        headers: {
          'X-API-key': cfg.apiToken,
          ...init.headers,
          ...(gate ? { Authorization: `Bearer ${gate}` } : {}),
        },
        body: init.body,
      });
    } catch (err) {
      throw new Error(
        `could not reach the ontos app at ${base} (${String((err as { message?: string })?.message ?? err)})`
      );
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!res.ok && !(allowNotFound && res.status === 404)) {
      const detail =
        typeof body === 'string' ? body : body === null ? '' : JSON.stringify(body);
      const snippet = detail.slice(0, BODY_SNIPPET_LIMIT);
      throw new Error(
        `ontos rejected ${method} /api${path} with status ${res.status}` +
          (snippet ? ` — ${snippet}` : ' (empty response body)')
      );
    }
    return { status: res.status, body };
  }

  return {
    async importOdcsContract(yaml: string): Promise<{ contractId: string }> {
      // ODCS YAML is a file upload: ontos parses the part as YAML because the
      // filename ends in .yaml. (The odcs/import sibling endpoint takes a JSON
      // object body, which we cannot produce without bundling a YAML parser.)
      const form = new FormData();
      form.append('file', new Blob([yaml], { type: 'application/x-yaml' }), 'contract.odcs.yaml');
      const { body } = await request('POST', '/data-contracts/upload', { body: form });
      const contractId = firstString(body, ['id', 'contract_id']);
      if (!contractId) {
        throw new Error('ontos imported the contract but returned no contract id');
      }
      return { contractId };
    },

    // A freshly uploaded contract sits in `draft`; the from-contract product
    // endpoint only accepts active/approved/certified contracts. Walk the ODCS
    // lifecycle one step at a time (ontos rejects skipping transitions).
    async activateContract(contractId: string): Promise<void> {
      for (const status of ['proposed', 'under_review', 'approved', 'active']) {
        await request('POST', `/data-contracts/${encodeURIComponent(contractId)}/change-status`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ new_status: status }),
        });
      }
    },

    async createProductFromContract(
      contractId: string,
      name: string
    ): Promise<{ productId: string }> {
      // product_type and version are required by the endpoint but not part of
      // this client's pinned surface — send stable, documented defaults.
      const { body } = await request('POST', '/data-products/from-contract', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_id: contractId,
          product_name: name,
          product_type: 'source-aligned',
          version: '1.0.0',
        }),
      });
      const productId = firstString(body, ['id', 'product_id']);
      if (!productId) {
        throw new Error('ontos created the data product but returned no product id');
      }
      return { productId };
    },

    async getProduct(id: string): Promise<DataProductSummary | null> {
      const { status, body } = await request(
        'GET',
        `/data-products/${encodeURIComponent(id)}`,
        {},
        true
      );
      if (status === 404) return null;
      return {
        id: firstString(body, ['id']) ?? id,
        name: firstString(body, ['name']) ?? id,
        status: firstString(body, ['status']),
        // upstream spells it `domain_id`; tolerate both so either shape maps
        domain: firstString(body, ['domain_id', 'domain']),
        owner: firstString(body, ['owner_team_name', 'owner_team_id', 'owner']),
      };
    },

    async getContractValidationState(contractId: string): Promise<ContractValidationState> {
      const { body } = await request('GET', `/data-contracts/${encodeURIComponent(contractId)}`);
      const doc = (body ?? {}) as Record<string, unknown>;
      // If the deployment ever exposes validation runs, tolerate the payload
      // under any of these spellings; otherwise infer from lifecycle status.
      const payload = firstRecord(doc, [
        'validation',
        'validation_state',
        'validationState',
        'last_validation_run',
      ]);
      if (payload) {
        const checks = mapChecks(payload.checks ?? payload.results);
        return {
          contract_id: contractId,
          status: overallStatus(payload.status, checks),
          checks,
          raw: doc,
        };
      }
      return {
        contract_id: contractId,
        status: lifecycleToState(doc.status),
        checks: [],
        raw: doc,
      };
    },
  };
}
