import { createApp, analytics, server, serving } from '@databricks/appkit';

// The serving plugin is wired to a Foundation Model endpoint (alias "llm",
// endpoint name from DATABRICKS_SERVING_ENDPOINT_NAME). It powers the optional
// /api/generate-catalog route that refines the heuristic catalog draft. If no
// endpoint is configured the route reports llm:false and callers fall back to the
// heuristic — the feature never blocks on the model.
const hasLlm = Boolean(process.env.DATABRICKS_SERVING_ENDPOINT_NAME);

createApp({
  plugins: [
    analytics(),
    serving({ endpoints: { llm: { env: 'DATABRICKS_SERVING_ENDPOINT_NAME' } } }),
    server(),
  ],
  onPluginsReady(appkit) {
    // Server-side SQL via the analytics plugin (service-principal creds, attached
    // warehouse). Returns an array of row objects.
    const runSql = async (q: string): Promise<Record<string, unknown>[]> => {
      const out = (await appkit.analytics.query(q)) as unknown;
      if (Array.isArray(out)) return out as Record<string, unknown>[];
      const rows = (out as { rows?: unknown[]; data?: unknown[] })?.rows ?? (out as { data?: unknown[] })?.data;
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    };
    const likePat = (v: string | undefined): string => {
      const s = (v ?? '').trim();
      if (!s) return '%';
      return s.replace(/\*/g, '%'); // wildcard: * or % both → %
    };
    const safeIdent = (v: string): string => v.replace(/[^a-zA-Z0-9_]/g, '');

    appkit.server.extend((app) => {
      // Tells the client whether the LLM-polish path is available.
      app.get('/api/llm-status', (_req, res) => {
        res.json({ available: hasLlm });
      });

      // List catalogs the app SP can see.
      app.get('/api/catalogs', async (_req, res) => {
        try {
          const rows = await runSql('SHOW CATALOGS');
          const catalogs = rows
            .map((r) => String(r.catalog ?? r.catalog_name ?? Object.values(r)[0] ?? ''))
            .filter(Boolean)
            .sort();
          res.json({ catalogs });
        } catch (err) {
          res.status(200).json({ catalogs: [], error: String(err) });
        }
      });

      // List schemas in a catalog (single catalog, no wildcard here).
      app.get('/api/schemas', async (req, res) => {
        const catalog = safeIdent(String(req.query.catalog ?? ''));
        if (!catalog) {
          res.status(400).json({ schemas: [], error: 'catalog is required' });
          return;
        }
        try {
          const rows = await runSql(
            `SELECT schema_name FROM ${catalog}.information_schema.schemata ORDER BY schema_name`
          );
          const schemas = rows
            .map((r) => String(r.schema_name ?? Object.values(r)[0] ?? ''))
            .filter(Boolean);
          res.json({ schemas });
        } catch (err) {
          res.status(200).json({ schemas: [], error: humanizeSqlError(err) });
        }
      });

      // Introspect column metadata → the same schema map the CSV upload produces.
      // Body: { catalog, schema, table } — catalog may be a wildcard (enumerated);
      // schema/table support * or % wildcards.
      app.post('/api/introspect-schema', async (req, res) => {
        const body = (req.body ?? {}) as { catalog?: string; schema?: string; table?: string };
        const catRaw = (body.catalog ?? '').trim();
        const schemaPat = likePat(body.schema);
        const tablePat = likePat(body.table);
        if (!catRaw) {
          res.status(400).json({ error: 'catalog is required' });
          return;
        }

        try {
          // resolve catalogs: wildcard → enumerate + filter; else single
          let catalogs: string[];
          if (catRaw.includes('*') || catRaw.includes('%')) {
            const all = await runSql('SHOW CATALOGS');
            const re = new RegExp(
              '^' + catRaw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*') + '$',
              'i'
            );
            catalogs = all
              .map((r) => String(r.catalog ?? r.catalog_name ?? Object.values(r)[0] ?? ''))
              .filter((c) => c && re.test(c));
          } else {
            catalogs = [catRaw];
          }
          if (catalogs.length === 0) {
            res.json({ schema: {}, matchedCatalogs: [], warnings: ['No catalogs matched the pattern.'] });
            return;
          }

          const schema: Record<string, { name: string; type: string; comment?: string }[]> = {};
          const matched: string[] = [];
          const warnings: string[] = [];
          for (const cat of catalogs.slice(0, 12)) {
            const c = safeIdent(cat);
            const q = `SELECT table_schema, table_name, column_name, full_data_type AS data_type, comment
              FROM ${c}.information_schema.columns
              WHERE table_schema LIKE '${schemaPat.replace(/'/g, "''")}'
                AND table_name LIKE '${tablePat.replace(/'/g, "''")}'
              ORDER BY table_schema, table_name, ordinal_position
              LIMIT 8000`;
            try {
              const rows = await runSql(q);
              if (rows.length > 0) matched.push(cat);
              for (const r of rows) {
                const key = `${String(r.table_schema)}.${String(r.table_name)}`;
                const cmt = r.comment != null ? String(r.comment) : '';
                (schema[key] = schema[key] ?? []).push({
                  name: String(r.column_name),
                  type: String(r.data_type),
                  comment: cmt && cmt !== 'null' ? cmt : undefined,
                });
              }
            } catch (err) {
              warnings.push(`${cat}: ${humanizeSqlError(err)}`);
            }
          }
          const tableCount = Object.keys(schema).length;
          if (tableCount === 0 && warnings.length === 0) {
            warnings.push('No tables matched the catalog/schema/table filters.');
          }
          res.json({ schema, matchedCatalogs: matched, tableCount, warnings });
        } catch (err) {
          res.status(200).json({ schema: {}, error: humanizeSqlError(err) });
        }
      });

      // Catalog-polish endpoint: refine a heuristic catalog draft with the LLM.
      // Body: { draft: Catalog, summary: string }. Returns { catalog, llm }.
      app.post('/api/generate-catalog', async (req, res) => {
        const draft = (req.body as { draft?: { domains?: unknown[] }; summary?: string })?.draft;
        const summary = (req.body as { summary?: string })?.summary ?? '';
        if (!draft || !Array.isArray(draft.domains)) {
          res.status(400).json({ error: 'body.draft (a catalog with domains[]) is required' });
          return;
        }
        if (!hasLlm) {
          res.json({ catalog: draft, llm: false, reason: 'no serving endpoint configured' });
          return;
        }
        try {
          const sys =
            'You are a data-product catalog designer. Given a heuristic draft catalog and a schema ' +
            'summary, REFINE it: improve domain labels, product display_name and business_outcome, ' +
            'and pick the best 1-3 kpis per product from its fact columns. Keep <=4 products per ' +
            'domain. Do NOT invent tables or columns not present in the draft. Return ONLY JSON of ' +
            'the same shape as the draft (domains[].products[] with product_name, display_name, ' +
            'business_outcome, fact_tables, dim_tables, kpis, maturity).';
          // Fold the system instruction into the user turn — the generated
          // serving request type for this endpoint only permits user/assistant
          // roles. Body is cast loose so it works whether or not serving types
          // are generated at build time.
          const user = `${sys}\n\nSCHEMA SUMMARY:\n${summary}\n\nDRAFT CATALOG JSON:\n${JSON.stringify(
            draft
          ).slice(0, 90000)}`;
          // serving.invoke() returns an ExecutionResult { ok, status, message, data }
          const invokeBody = {
            messages: [{ role: 'user', content: user }],
            max_tokens: 8000,
            temperature: 0.2,
          } as Parameters<ReturnType<typeof appkit.serving>['invoke']>[0];
          const result = (await appkit.serving('llm').invoke(invokeBody)) as {
            ok?: boolean;
            message?: string;
            data?: { choices?: { message?: { content?: string } }[] };
          };
          if (result && result.ok === false) {
            res.json({ catalog: draft, llm: false, reason: result.message ?? 'serving invoke failed' });
            return;
          }
          const payload = result?.data ?? (result as unknown as { choices?: { message?: { content?: string } }[] });
          const content = payload?.choices?.[0]?.message?.content ?? '';
          const json = extractJson(content);
          if (json && Array.isArray(json.domains)) {
            res.json({ catalog: json, llm: true });
            return;
          }
          res.json({ catalog: draft, llm: false, reason: 'model returned no usable JSON' });
        } catch (err) {
          res.json({ catalog: draft, llm: false, reason: String(err) });
        }
      });
    });
  },
}).catch(console.error);

function humanizeSqlError(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err);
  if (/permission|access|denied|not authorized|PERMISSION_DENIED|forbidden/i.test(msg)) {
    return 'No access — the app service principal lacks permission on this catalog/schema.';
  }
  if (/does not exist|not found|cannot be found|TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND/i.test(msg)) {
    return 'Not found — no matching catalog/schema/tables (or no access).';
  }
  return msg.slice(0, 300);
}

function extractJson(text: string): { domains?: unknown[] } | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
