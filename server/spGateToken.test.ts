// Unit tests for the SP gate-token manager. All responses are served by an
// injected fetchImpl — no network, no real credentials. The mint call shape
// (URL, Basic auth header, form-encoded body) is the contract with the
// workspace's /oidc/v1/token endpoint, verified during deployment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSpGateToken } from './spGateToken';

const CLIENT_ID = 'sp-client-id';
const SECRET = 'sp-secret';
const HOST = 'adb-gate.example.azuredatabricks.net';
const TOKEN_URL = `https://${HOST}/oidc/v1/token`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Records every fetch the manager makes and serves canned responses.
function makeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let respond: () => Response = () => jsonResponse(200, { access_token: 'tok-a', expires_in: 3600 });
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init: init ?? {} });
    return Promise.resolve(respond());
  };
  return {
    calls,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    respondWith(fn: () => Response) {
      respond = fn;
    },
  };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

// Stubs the deployed SP env (host with protocol + trailing slash, as the
// App runtime and dev shells may present it — both get stripped).
function stubSpEnv() {
  vi.stubEnv('RT_INTEGRATION_SP_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('RT_INTEGRATION_SP_SECRET', SECRET);
  vi.stubEnv('DATABRICKS_HOST', `https://${HOST}/`);
}

// The token cache is module-level, so tests share it. The fake clock starts
// 3h later in each test: any token cached by an earlier test is then past
// the 50-minute TTL, and every test starts from a known re-mint state.
let clock = Date.UTC(2026, 8, 30);
beforeEach(() => {
  clock += 3 * 60 * 60 * 1000;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(clock));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('offline mode', () => {
  it('resolves null (and never fetches) when the SP credentials are unset', async () => {
    const f = makeFetch();
    vi.stubEnv('DATABRICKS_HOST', `https://${HOST}/`);
    await expect(getSpGateToken(f.fetchImpl)).resolves.toBeNull();
    expect(f.calls.length).toBe(0);
  });

  it('resolves null when only one of the two credentials is set', async () => {
    const f = makeFetch();
    vi.stubEnv('RT_INTEGRATION_SP_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('DATABRICKS_HOST', `https://${HOST}/`);
    await expect(getSpGateToken(f.fetchImpl)).resolves.toBeNull();
    expect(f.calls.length).toBe(0);
  });
});

describe('minting', () => {
  it('mints via client_credentials with Basic auth at the workspace oidc endpoint', async () => {
    const f = makeFetch();
    stubSpEnv();
    const token = await getSpGateToken(f.fetchImpl);
    expect(token).toBe('tok-a');
    expect(f.calls.length).toBe(1);
    const call = f.calls[0];
    expect(call.url).toBe(TOKEN_URL);
    expect(call.init.method).toBe('POST');
    // Basic auth header present and well-formed (decoded, not hardcoded b64)
    const auth = headersOf(call.init).authorization;
    expect(auth?.startsWith('Basic ')).toBe(true);
    expect(Buffer.from((auth ?? '').slice('Basic '.length), 'base64').toString()).toBe(`${CLIENT_ID}:${SECRET}`);
    expect(headersOf(call.init)['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.init.body).toBe('grant_type=client_credentials&scope=all-apis');
  });

  it('throws a humanized error when the host is missing but credentials are set', async () => {
    const f = makeFetch();
    vi.stubEnv('RT_INTEGRATION_SP_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('RT_INTEGRATION_SP_SECRET', SECRET);
    await expect(getSpGateToken(f.fetchImpl)).rejects.toThrow(
      /DATABRICKS_HOST is not set — cannot mint the SP gate token/
    );
    expect(f.calls.length).toBe(0);
  });
});

describe('caching', () => {
  it('reuses a fresh token: a second call within 50 minutes does not re-mint', async () => {
    const f = makeFetch();
    stubSpEnv();
    const first = await getSpGateToken(f.fetchImpl);
    vi.setSystemTime(new Date(clock + 10 * 60 * 1000)); // 10 minutes later
    const second = await getSpGateToken(f.fetchImpl);
    expect(second).toBe(first);
    expect(f.calls.length).toBe(1);
  });

  it('re-mints once the cached token is older than 50 minutes', async () => {
    const f = makeFetch();
    stubSpEnv();
    const first = await getSpGateToken(f.fetchImpl);
    expect(first).toBe('tok-a');
    f.respondWith(() => jsonResponse(200, { access_token: 'tok-b', expires_in: 3600 }));
    vi.setSystemTime(new Date(clock + 51 * 60 * 1000)); // past the TTL
    const second = await getSpGateToken(f.fetchImpl);
    expect(second).toBe('tok-b');
    expect(f.calls.length).toBe(2);
  });
});

describe('mint failures', () => {
  it('humanizes a non-2xx mint and does not cache the failure', async () => {
    const f = makeFetch();
    stubSpEnv();
    f.respondWith(() => jsonResponse(400, { error: 'invalid_client' }));
    await expect(getSpGateToken(f.fetchImpl)).rejects.toThrow(/status 400.*invalid_client/);
    // not cached: the next call attempts a fresh mint
    f.respondWith(() => jsonResponse(200, { access_token: 'tok-c', expires_in: 3600 }));
    await expect(getSpGateToken(f.fetchImpl)).resolves.toBe('tok-c');
    expect(f.calls.length).toBe(2);
  });

  it('humanizes an unreachable token endpoint without leaking fetch internals', async () => {
    const f = makeFetch();
    stubSpEnv();
    f.respondWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(getSpGateToken(f.fetchImpl)).rejects.toThrow(
      /could not reach the SP token endpoint at https:\/\/adb-gate\.example\.azuredatabricks\.net\/oidc\/v1\/token \(fetch failed\)/
    );
  });

  it('humanizes a 200 response that carries no access_token', async () => {
    const f = makeFetch();
    stubSpEnv();
    f.respondWith(() => jsonResponse(200, { expires_in: 3600 }));
    await expect(getSpGateToken(f.fetchImpl)).rejects.toThrow(/returned no access_token/);
  });
});
