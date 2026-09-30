// OAuth gate-token manager shared by the two integration clients (ontos,
// ontobricks). The Databricks Apps gate on this workspace accepts OAuth
// bearer tokens only — a PAT or an app-level token in `Authorization` is
// 401'd at the gate before the app ever sees the request. Every client
// request therefore carries `Authorization: Bearer <token>`, minted here
// via OAuth client_credentials from the dedicated machine SP
// (`jai_rt_onto_integration`, member of the ontos `data-producers` group).
//
// Config comes from env (app secrets in the deployed runtime, never the
// repo): RT_INTEGRATION_SP_CLIENT_ID / RT_INTEGRATION_SP_SECRET for the
// SP's OAuth client, and DATABRICKS_HOST (always present in the App
// runtime) for the token endpoint's host.
//
// Minting is plain fetch + an HTTP Basic auth header against the
// workspace's POST /oidc/v1/token — no OAuth library, no new deps. Tokens
// live 1h (expires_in 3600) and are re-minted at 50 minutes; a failed mint
// throws humanized (status + short body) and is never cached.
const TOKEN_TTL_MS = 50 * 60 * 1000; // safety margin under the 3600s expires_in
const BODY_SNIPPET_LIMIT = 200;

// Module-level cache shared by both clients (they hit the same SP).
let cache: { token: string; mintedAt: number } | null = null;

// Resolve the SP OAuth token for the Apps gate, or null in offline mode
// (credentials unset), which the clients read as "send exactly the old
// headers". `fetchImpl` is injectable for tests.
export async function getSpGateToken(fetchImpl?: typeof fetch): Promise<string | null> {
  const clientId = process.env.RT_INTEGRATION_SP_CLIENT_ID;
  const clientSecret = process.env.RT_INTEGRATION_SP_SECRET;
  if (!clientId || !clientSecret) return null; // offline: no gate auth
  if (cache && Date.now() - cache.mintedAt < TOKEN_TTL_MS) return cache.token;

  const host = (process.env.DATABRICKS_HOST ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) {
    throw new Error(
      'RT_INTEGRATION_SP_CLIENT_ID/SECRET are set but DATABRICKS_HOST is not set — cannot mint the SP gate token'
    );
  }
  const url = `https://${host}/oidc/v1/token`;
  // client_credentials with HTTP Basic auth, per the deployment's verified mint recipe
  const authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  let res: Response;
  try {
    res = await (fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=all-apis',
    });
  } catch (err) {
    throw new Error(
      `could not reach the SP token endpoint at ${url} (${String((err as { message?: string })?.message ?? err)})`
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, BODY_SNIPPET_LIMIT);
    throw new Error(
      `the SP gate-token mint at ${url} failed with status ${res.status}` +
        (snippet ? ` — ${snippet}` : ' (empty response body)')
    );
  }
  let body: { access_token?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { access_token?: unknown };
  } catch {
    body = null;
  }
  const token = typeof body?.access_token === 'string' ? body.access_token : '';
  if (!token) {
    throw new Error(`the SP gate-token mint at ${url} returned no access_token`);
  }
  // only successful mints are cached — a failure leaves the cache untouched
  cache = { token, mintedAt: Date.now() };
  return token;
}
