// Unit tests for the ontos client. All responses are served by an injected
// fetchImpl — no network, no real auth. The wire expectations (URLs, X-API-key
// and gate Authorization headers, body shapes) are the contract with the
// deployed ontos app.
import { describe, expect, it } from 'vitest';
import { createOntosClient } from './ontosClient';
import type { OntosClientConfig } from '../shared/ontosTypes';

const BASE = 'https://ontos.example';
const TOKEN = 'tok-123';
const SP_TOKEN = 'sp-oauth-tok';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Records every fetch the client makes and serves canned responses. The
// gate-token resolver defaults to null so these tests stay hermetic offline —
// a dev shell with the SP env vars exported must never leak a live mint.
function makeHarness(cfgOverrides: Partial<OntosClientConfig> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let respond: (url: string) => Response = () => jsonResponse(200, {});
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init: init ?? {} });
    return Promise.resolve(respond(input));
  };
  return {
    calls,
    respondWith(fn: (url: string) => Response) {
      respond = fn;
    },
    client: createOntosClient({
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateToken: () => Promise.resolve(null),
      ...cfgOverrides,
    }),
  };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('importOdcsContract', () => {
  it('uploads the YAML as a multipart file and returns the contract id', async () => {
    const h = makeHarness();
    h.respondWith(() =>
      jsonResponse(200, { id: 'urn:datacontract:jai_ontos:x', unknownField: 'tolerated' })
    );
    const yaml = 'apiVersion: v3.1.0\nkind: DataContract\n';
    const res = await h.client.importOdcsContract(yaml);
    expect(res).toEqual({ contractId: 'urn:datacontract:jai_ontos:x' });
    const call = h.calls[0];
    expect(call.url).toBe(`${BASE}/api/data-contracts/upload`);
    expect(call.init.method).toBe('POST');
    expect(headersOf(call.init)['X-API-key']).toBe(TOKEN);
    const file = (call.init.body as FormData).get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('contract.odcs.yaml');
    expect(file.type).toBe('application/x-yaml');
    expect(await file.text()).toBe(yaml);
  });

  it('humanizes non-2xx responses with the status code and a body snippet', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(400, { detail: 'Invalid contract data' }));
    await expect(h.client.importOdcsContract('nonsense: true')).rejects.toThrow(
      /status 400.*Invalid contract data/
    );
  });

  it('throws a readable error when the response carries no contract id', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(200, { name: 'jai_contract' }));
    await expect(h.client.importOdcsContract('apiVersion: v3.1.0')).rejects.toThrow(
      /returned no contract id/
    );
  });
});

describe('createProductFromContract', () => {
  it('posts the embedded JSON body and returns the product id', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(201, { id: 'dp-1', extra: 'tolerated' }));
    const res = await h.client.createProductFromContract('c-1', 'Store Traffic & Labor');
    expect(res).toEqual({ productId: 'dp-1' });
    const call = h.calls[0];
    expect(call.url).toBe(`${BASE}/api/data-products/from-contract`);
    expect(call.init.method).toBe('POST');
    expect(headersOf(call.init)['X-API-key']).toBe(TOKEN);
    expect(headersOf(call.init)['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({
      contract_id: 'c-1',
      product_name: 'Store Traffic & Labor',
      product_type: 'source-aligned',
      version: '1.0.0',
    });
  });

  it('humanizes non-2xx responses with the status code', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(500, { detail: 'Creation failed' }));
    await expect(h.client.createProductFromContract('c-1', 'X')).rejects.toThrow(
      /status 500.*Creation failed/
    );
  });
});

describe('activateContract', () => {
  it('walks the ODCS lifecycle one status at a time', async () => {
    const h = makeHarness();
    h.respondWith((url) => jsonResponse(200, { status: url.split('/').pop() }));
    await h.client.activateContract('c-1');
    expect(h.calls.map((c) => c.url)).toEqual([
      `${BASE}/api/data-contracts/c-1/change-status`,
      `${BASE}/api/data-contracts/c-1/change-status`,
      `${BASE}/api/data-contracts/c-1/change-status`,
      `${BASE}/api/data-contracts/c-1/change-status`,
    ]);
    const bodies = h.calls.map((c) => JSON.parse(c.init.body as string));
    expect(bodies).toEqual([
      { new_status: 'proposed' },
      { new_status: 'under_review' },
      { new_status: 'approved' },
      { new_status: 'active' },
    ]);
  });

  it('humanizes a rejected lifecycle transition', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(409, { detail: 'Invalid transition' }));
    await expect(h.client.activateContract('c-1')).rejects.toThrow(/status 409.*Invalid transition/);
  });
});

describe('getProduct', () => {
  it('maps the product document onto the summary and tolerates unknown fields', async () => {
    const h = makeHarness();
    h.respondWith(() =>
      jsonResponse(200, {
        id: 'dp-1',
        name: 'Store Day Efficiency',
        status: 'draft',
        domain: 'store-operations',
        owner_team_name: 'jai team',
        owner_team_id: 'team-9',
        inputPorts: [{ not: 'in the summary' }],
      })
    );
    const p = await h.client.getProduct('dp-1');
    expect(p).toEqual({
      id: 'dp-1',
      name: 'Store Day Efficiency',
      status: 'draft',
      domain: 'store-operations',
      owner: 'jai team',
    });
    const call = h.calls[0];
    expect(call.url).toBe(`${BASE}/api/data-products/dp-1`);
    expect(call.init.method).toBe('GET');
    expect(headersOf(call.init)['X-API-key']).toBe(TOKEN);
  });

  it('returns null for a 404', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(404, { detail: 'Data product not found' }));
    await expect(h.client.getProduct('nope')).resolves.toBeNull();
  });

  it('defaults safely when response fields are missing', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(200, { id: 'dp-9', owner_team_name: 'ops' }));
    const p = await h.client.getProduct('dp-9');
    expect(p).toEqual({ id: 'dp-9', name: 'dp-9', owner: 'ops' });
  });
});

describe('getContractValidationState', () => {
  it('polls the contract and infers state from its lifecycle status', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(200, { id: 'c-1', status: 'active', noise: [1, 2] }));
    const s = await h.client.getContractValidationState('c-1');
    expect(s).toEqual({ contract_id: 'c-1', status: 'pass', checks: [], raw: s.raw });
    expect(s.raw).toEqual({ id: 'c-1', status: 'active', noise: [1, 2] });
    const call = h.calls[0];
    expect(call.url).toBe(`${BASE}/api/data-contracts/c-1`);
    expect(call.init.method).toBe('GET');
    expect(headersOf(call.init)['X-API-key']).toBe(TOKEN);
  });

  it('treats an in-flight lifecycle status as pending and unknown statuses as unknown', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(200, { id: 'c-1', status: 'draft' }));
    expect((await h.client.getContractValidationState('c-1')).status).toBe('pending');
    h.respondWith(() => jsonResponse(200, { id: 'c-1' }));
    expect((await h.client.getContractValidationState('c-1')).status).toBe('unknown');
    h.respondWith(() => jsonResponse(200, { id: 'c-1', status: 'mystery' }));
    expect((await h.client.getContractValidationState('c-1')).status).toBe('unknown');
  });

  it('maps a validation payload when the contract carries one', async () => {
    const h = makeHarness();
    h.respondWith(() =>
      jsonResponse(200, {
        id: 'c-1',
        validation: {
          status: 'succeeded',
          checks: [
            { name: 'sla_freshness', passed: true },
            { name: 'dq_unique_grain', status: 'failed', message: 'grain violated' },
          ],
        },
      })
    );
    const s = await h.client.getContractValidationState('c-1');
    expect(s.contract_id).toBe('c-1');
    expect(s.status).toBe('fail');
    expect(s.checks).toEqual([
      { name: 'sla_freshness', status: 'pass' },
      { name: 'dq_unique_grain', status: 'fail', message: 'grain violated' },
    ]);
  });

  it('humanizes non-2xx responses with the status code', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(403, { detail: 'Not a member' }));
    await expect(h.client.getContractValidationState('c-1')).rejects.toThrow(
      /status 403.*Not a member/
    );
  });
});

describe('connection failures', () => {
  it('reports an unreachable ontos app without leaking fetch internals', async () => {
    const h = makeHarness();
    h.respondWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(h.client.getProduct('dp-1')).rejects.toThrow(
      /could not reach the ontos app at https:\/\/ontos\.example \(fetch failed\)/
    );
  });
});

describe('gate token — Authorization header', () => {
  it('adds Authorization: Bearer to every request kind when a gate token resolves', async () => {
    const h = makeHarness({ gateToken: () => Promise.resolve(SP_TOKEN) });
    h.respondWith(() => jsonResponse(200, { id: 'x' }));
    await h.client.importOdcsContract('apiVersion: v3.1.0');
    await h.client.createProductFromContract('c-1', 'X');
    await h.client.getProduct('dp-1');
    await h.client.getContractValidationState('c-1');
    expect(h.calls.length).toBe(4);
    for (const call of h.calls) {
      expect(headersOf(call.init).Authorization).toBe(`Bearer ${SP_TOKEN}`);
      // the app-level X-API-key header stays untouched alongside the gate auth
      expect(headersOf(call.init)['X-API-key']).toBe(TOKEN);
    }
  });

  it('sends no Authorization header when the gate token resolves null (offline passthrough)', async () => {
    const h = makeHarness({ gateToken: () => Promise.resolve(null) });
    h.respondWith(() => jsonResponse(200, { id: 'x' }));
    await h.client.importOdcsContract('apiVersion: v3.1.0');
    await h.client.createProductFromContract('c-1', 'X');
    await h.client.getProduct('dp-1');
    await h.client.getContractValidationState('c-1');
    expect(h.calls.length).toBe(4);
    for (const call of h.calls) {
      expect(headersOf(call.init).Authorization).toBeUndefined();
      expect(headersOf(call.init)['X-API-key']).toBe(TOKEN);
    }
  });

  it('propagates a humanized mint failure from the gate-token resolver', async () => {
    const h = makeHarness({
      gateToken: () =>
        Promise.reject(new Error('the SP gate-token mint failed with status 400')),
    });
    h.respondWith(() => jsonResponse(200, { id: 'x' }));
    await expect(h.client.getProduct('dp-1')).rejects.toThrow(
      /SP gate-token mint failed with status 400/
    );
    expect(h.calls.length).toBe(0); // nothing went out after the failed mint
  });
});
