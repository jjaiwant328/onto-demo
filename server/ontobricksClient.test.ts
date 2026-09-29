// Unit tests for the ontobricks graph client. All responses are served by an
// injected fetchImpl — no network, no auth. The wire expectations (URLs,
// X-Databricks-* headers, GraphQL body shapes) are the contract with the
// deployed ontobricks app, per its documented API (docs/api.md § GraphQL API).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOntobricksClient } from './ontobricksClient';
import type { GraphNeighbor, OntobricksClientConfig } from '../shared/ontobricksTypes';

const BASE = 'https://ontobricks.example';
const TOKEN = 'dapi-tok-123';
const HOST = 'adb-example.azuredatabricks.net';
const DOMAIN = 'retail_demo';
const GRAPHQL_URL = `${BASE}/api/v1/graphql/${DOMAIN}`;
const SCHEMA_URL = `${GRAPHQL_URL}/schema`;

const IRI_C1 = 'http://onto.example/ontology#Customer/C1';
const IRI_O9 = 'http://onto.example/ontology#Order/O9';
const IRI_C2 = 'http://onto.example/ontology#Customer/C2';

// A small two-class ontology, in the SDL the domain endpoint prints: object
// properties become relationship fields, data properties become scalars.
const SDL = [
  'type Customer {',
  '  id: ID!',
  '  uri: String!',
  '  label: String',
  '  firstName: String',
  '  hasOrder: [Order]',
  '}',
  '',
  'type Order {',
  '  id: ID!',
  '  uri: String!',
  '  label: String',
  '  orderDate: String',
  '  placedBy: [Customer]',
  '}',
  '',
  'type Query {',
  '  """List Customer entities from the knowledge graph."""',
  '  allCustomer(limit: Int = 50, offset: Int = 0, search: String): [Customer!]!',
  '  customer(id: String!): Customer',
  '  """List Order entities from the knowledge graph."""',
  '  allOrder(limit: Int = 50, offset: Int = 0, search: String): [Order!]!',
  '  order(id: String!): Order',
  '}',
].join('\n');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Records every fetch the client makes and serves canned responses.
function makeHarness(cfgOverrides: Partial<OntobricksClientConfig> = {}) {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  let respond: (call: { method: string; url: string; init: RequestInit }) => Response = () => jsonResponse(200, {});
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    const call = { method: (init?.method as string) ?? 'GET', url: input, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return {
    calls,
    respondWith(fn: (call: { method: string; url: string; init: RequestInit }) => Response) {
      respond = fn;
    },
    client: createOntobricksClient({
      baseUrl: BASE,
      token: TOKEN,
      databricksHost: HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...cfgOverrides,
    }),
  };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

// Serves the full three-call flow: schema, probe, expansion.
function serveGraph(h: ReturnType<typeof makeHarness>, probe: unknown, expansion: unknown, sdl: string = SDL) {
  const posts = [jsonResponse(200, probe), jsonResponse(200, expansion)];
  h.respondWith((call) => {
    if (call.url === SCHEMA_URL) return jsonResponse(200, { sdl, ready: true });
    if (call.url === GRAPHQL_URL) return posts.shift() ?? jsonResponse(200, {});
    return jsonResponse(404, { detail: `unexpected ${call.url}` });
  });
}

const PROBE_FOUND = {
  data: { customer: { uri: IRI_C1 }, order: null },
};

describe('fetchNeighbors — wire contract', () => {
  it('requests the documented endpoints with auth headers, id fragment and depth', async () => {
    const h = makeHarness();
    serveGraph(h, PROBE_FOUND, { data: { customer: null } });
    await h.client.fetchNeighbors(DOMAIN, IRI_C1, 2);
    expect(h.calls.length).toBe(3);

    const [schema, probe, expansion] = h.calls;
    expect(schema.method).toBe('GET');
    expect(schema.url).toBe(SCHEMA_URL);
    expect(headersOf(schema.init)['X-Databricks-Host']).toBe(HOST);
    expect(headersOf(schema.init)['X-Databricks-Token']).toBe(TOKEN);

    expect(probe.method).toBe('POST');
    expect(probe.url).toBe(GRAPHQL_URL);
    expect(headersOf(probe.init)['X-Databricks-Host']).toBe(HOST);
    expect(headersOf(probe.init)['X-Databricks-Token']).toBe(TOKEN);
    expect(headersOf(probe.init)['content-type']).toBe('application/json');
    expect(bodyOf(probe).query).toContain('customer(id: $frag)');
    expect(bodyOf(probe).query).toContain('order(id: $frag)');
    // a full IRI must be cut to its trailing fragment to be usable as an id
    expect(bodyOf(probe).variables).toEqual({ frag: 'Customer/C1' });

    expect(expansion.method).toBe('POST');
    expect(expansion.url).toBe(GRAPHQL_URL);
    expect(bodyOf(expansion).query).toBe(
      'query Neighbors($frag: ID!) { customer(id: $frag) { uri label __typename ' +
        'hasOrder { uri label __typename placedBy { uri label __typename } } } }'
    );
    expect(bodyOf(expansion).variables).toEqual({ frag: 'Customer/C1' });
    expect(bodyOf(expansion).depth).toBe(2);
  });

  it('clamps hops to the plan cap of 3', async () => {
    const h = makeHarness();
    serveGraph(h, PROBE_FOUND, { data: { customer: null } });
    await h.client.fetchNeighbors(DOMAIN, IRI_C1, 7);
    const expansion = h.calls[2];
    expect(bodyOf(expansion).depth).toBe(3);
    expect(bodyOf(expansion).query).toBe(
      'query Neighbors($frag: ID!) { customer(id: $frag) { uri label __typename ' +
        'hasOrder { uri label __typename placedBy { uri label __typename ' +
        'hasOrder { uri label __typename } } } } }'
    );
  });
});

describe('fetchNeighbors — mapping', () => {
  it('maps the nested response onto out and in neighbors and tolerates unknown fields', async () => {
    const h = makeHarness();
    serveGraph(h, PROBE_FOUND, {
      data: {
        customer: {
          uri: IRI_C1,
          label: 'Alice',
          __typename: 'Customer',
          firstName: 'Alice',
          hasOrder: [
            {
              uri: IRI_O9,
              label: 'Order 1009',
              __typename: 'Order',
              orderDate: '2026-01-15',
              placedBy: [
                { uri: IRI_C1, label: 'Alice', __typename: 'Customer', extra: 'tolerated' },
                { uri: IRI_C2, id: 'Customer/C2', __typename: 'Customer' },
              ],
            },
          ],
        },
      },
    });
    const neighbors = await h.client.fetchNeighbors(DOMAIN, IRI_C1, 2);
    const expected: GraphNeighbor[] = [
      // O9 reached via the origin's hasOrder edge — walked forward
      { iri: IRI_O9, label: 'Order 1009', types: ['Order'], predicate: 'hasOrder', direction: 'out' },
      // O9's placedBy edge points back at the origin — O9 is an in-neighbor
      { iri: IRI_O9, label: 'Order 1009', types: ['Order'], predicate: 'placedBy', direction: 'in' },
      // C2 reached at hop 2 via O9's placedBy edge — label falls back to id
      { iri: IRI_C2, label: 'Customer/C2', types: ['Customer'], predicate: 'placedBy', direction: 'out' },
    ];
    expect(neighbors).toEqual(expected);
  });

  it('still parses fields after a one-line SDL description (not swallowed)', async () => {
    const h = makeHarness();
    // a SINGLE self-closed """desc""" directly above a relationship field,
    // followed by another field: the old (buggy) parity check toggled into
    // description mode here and swallowed hasOrder, refersTo and the rest of
    // the SDL — silently dropping neighbors from the expansion
    const describedSdl = [
      'type Customer {',
      '  id: ID!',
      '  uri: String!',
      '  label: String',
      '  """Orders placed by this customer."""',
      '  hasOrder: [Order]',
      '  refersTo: [Customer]',
      '}',
      '',
      'type Order {',
      '  id: ID!',
      '  uri: String!',
      '  label: String',
      '  """',
      '  The source system of the order.',
      '  """',
      '  orderDate: String',
      '}',
      '',
      'type Query {',
      '  customer(id: String!): Customer',
      '  order(id: String!): Order',
      '}',
    ].join('\n');
    serveGraph(
      h,
      PROBE_FOUND,
      {
        data: {
          customer: {
            uri: IRI_C1,
            label: 'Alice',
            __typename: 'Customer',
            hasOrder: [{ uri: IRI_O9, label: 'Order 1009', __typename: 'Order' }],
          },
        },
      },
      describedSdl
    );
    const neighbors = await h.client.fetchNeighbors(DOMAIN, IRI_C1, 2);
    // the relationship field under the description still yields neighbors
    expect(neighbors).toEqual([
      { iri: IRI_O9, label: 'Order 1009', types: ['Order'], predicate: 'hasOrder', direction: 'out' },
    ]);
    // and BOTH fields after the description are selected by the expansion
    const query = bodyOf(h.calls[2]).query as string;
    expect(query).toContain('hasOrder {');
    expect(query).toContain('refersTo {');
  });

  it('returns [] for an origin with no relationships', async () => {
    const h = makeHarness();
    serveGraph(h, PROBE_FOUND, {
      data: { customer: { uri: IRI_C1, label: 'Alice', __typename: 'Customer', hasOrder: null } },
    });
    await expect(h.client.fetchNeighbors(DOMAIN, IRI_C1, 2)).resolves.toEqual([]);
  });

  it('returns [] when the origin is not found in the domain', async () => {
    const h = makeHarness();
    serveGraph(h, { data: { customer: null, order: null } }, { data: {} });
    await expect(h.client.fetchNeighbors(DOMAIN, IRI_C1, 1)).resolves.toEqual([]);
    // no expansion is attempted for an unknown origin
    expect(h.calls.length).toBe(2);
  });
});

describe('fetchNeighbors — failures', () => {
  it('humanizes non-2xx responses with the status code and a body snippet', async () => {
    const h = makeHarness();
    h.respondWith(() => jsonResponse(404, { detail: 'Domain not found' }));
    await expect(h.client.fetchNeighbors(DOMAIN, IRI_C1, 2)).rejects.toThrow(/status 404.*Domain not found/);
  });

  it('reports a missing schema for a domain whose ontology is not materialized', async () => {
    const h = makeHarness();
    h.respondWith(() =>
      jsonResponse(200, {
        sdl: null,
        ready: false,
        reason: 'no_classes',
        message: 'Ontology has no classes',
      })
    );
    await expect(h.client.fetchNeighbors(DOMAIN, IRI_C1, 2)).rejects.toThrow(
      /no GraphQL schema for domain 'retail_demo'.*Ontology has no classes/
    );
  });

  it('reports an unreachable ontobricks app without leaking fetch internals', async () => {
    const h = makeHarness();
    h.respondWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(h.client.fetchNeighbors(DOMAIN, IRI_C1, 2)).rejects.toThrow(
      /could not reach the ontobricks app at https:\/\/ontobricks\.example \(fetch failed\)/
    );
  });
});

describe('workspace host resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives the X-Databricks-Host header from DATABRICKS_HOST when not configured', async () => {
    vi.stubEnv('DATABRICKS_HOST', 'https://env-host.example/');
    const h = makeHarness({ databricksHost: undefined });
    serveGraph(h, PROBE_FOUND, { data: { customer: null } });
    await h.client.fetchNeighbors(DOMAIN, IRI_C1, 1);
    // derived at call time (protocol + trailing slash stripped) on every call
    for (const call of h.calls) {
      expect(headersOf(call.init)['X-Databricks-Host']).toBe('env-host.example');
    }
  });
});
