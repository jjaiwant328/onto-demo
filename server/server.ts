import { createApp, analytics, server, serving, getWorkspaceClient } from '@databricks/appkit';
import { randomUUID, createHash } from 'node:crypto';
import {
  demoExceptionSql,
  demoAggregateSql,
  demoSnapshotSql,
  isDemoProduct,
  DEMO_PRODUCTS,
  ALL_DEMO_DOMAINS,
  QSR_SC_REASONING_RULES,
} from '../shared/demoDomains';
import {
  serializeTtl,
  serializeJsonLd,
  artifactCounts,
  type OntologyArtifact,
} from '../shared/ontologyArtifact';
import { lbQuery, ensureLakebaseTables, lakebaseConfigured } from './lakebase';

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

    // ---- SP-authenticated Databricks REST (host + bearer via the SDK config) ----
    // Works locally (profile) and on the Apps runtime (injected SP creds).
    let cachedHost: string | null = null;
    const authFetch = async (
      path: string,
      init: { method?: string; headers?: Record<string, string>; rawBody?: string } = {}
    ): Promise<Response> => {
      const w = getWorkspaceClient({});
      await w.config.ensureResolved?.();
      if (!cachedHost) cachedHost = w.config.host ?? process.env.DATABRICKS_HOST ?? '';
      const headers = new Headers(init.headers ?? {});
      await w.config.authenticate(headers);
      const host = cachedHost.startsWith('http') ? cachedHost : `https://${cachedHost}`;
      return fetch(`${host}${path}`, { method: init.method, headers, body: init.rawBody });
    };
    const VOLUME_BASE = '/Volumes/jai_ontos/demo_schema/onto_artifacts';
    // Files API: PUT/GET/DELETE a volume file
    const volumePut = (volPath: string, body: string) =>
      authFetch(`/api/2.0/fs/files${volPath}?overwrite=true`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        rawBody: body,
      });
    const volumeGet = (volPath: string) => authFetch(`/api/2.0/fs/files${volPath}`, { method: 'GET' });
    const volumeDelete = (volPath: string) =>
      authFetch(`/api/2.0/fs/files${volPath}`, { method: 'DELETE' });

    // ---- Lakebase startup: create operational tables + one-time migrate from
    // the Delta backups (jai_ontos.demo_schema.*). Idempotent: CREATE IF NOT
    // EXISTS + INSERT ... ON CONFLICT DO NOTHING, so it never clobbers newer
    // Lakebase writes. Delta copies are left in place as backup. Runs once at
    // startup, best-effort (never blocks the server from serving).
    const initLakebase = async (): Promise<void> => {
      if (!lakebaseConfigured()) {
        console.log('[lakebase] not configured (no PGHOST/LAKEBASE_ENDPOINT) — skipping init');
        return;
      }
      try {
        await ensureLakebaseTables();
        console.log('[lakebase] tables ensured');
      } catch (err) {
        console.error('[lakebase] ensureTables failed:', String(err));
        return; // if DDL fails (e.g. missing CREATE grant), skip migration
      }
      // one-time migration (guarded: only if the Lakebase table is empty)
      try {
        const existing = await lbQuery<{ n: string }>(`SELECT count(*)::text AS n FROM saved_schemas`);
        if (Number(existing[0]?.n ?? '0') === 0) {
          const rows = await runSql(
            `SELECT schema_id, customer, schema_name, source, catalog_ref, table_count, created_by, ` +
              `cast(created_at as string) as created_at, volume_path, schema_json, catalog_json ` +
              `FROM jai_ontos.demo_schema.jai_saved_schemas`
          ).catch(() => [] as Record<string, unknown>[]);
          for (const r of rows) {
            await lbQuery(
              `INSERT INTO saved_schemas (schema_id, customer, schema_name, source, catalog_ref, ` +
                `table_count, created_by, created_at, volume_path, schema_json, catalog_json) ` +
                `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (schema_id) DO NOTHING`,
              [
                r.schema_id, r.customer, r.schema_name, r.source, r.catalog_ref,
                r.table_count == null ? null : Number(r.table_count), r.created_by,
                r.created_at ? new Date(String(r.created_at)) : null, r.volume_path,
                r.schema_json ?? null, r.catalog_json ?? null,
              ]
            ).catch((e) => console.error('[lakebase] migrate saved_schemas row failed:', String(e)));
          }
          console.log(`[lakebase] migrated ${rows.length} saved_schemas row(s) from Delta`);
        }
      } catch (err) {
        console.error('[lakebase] saved_schemas migration skipped:', String(err));
      }
      try {
        const existing = await lbQuery<{ n: string }>(`SELECT count(*)::text AS n FROM action_log`);
        if (Number(existing[0]?.n ?? '0') === 0) {
          const rows = await runSql(
            `SELECT action_id, cast(created_at as string) c, cast(updated_at as string) u, schema_label, ` +
              `domain, product, source, priority, issue, root_cause, recommended_action, confidence, ` +
              `decision, track_status, decided_by, cast(decided_at as string) d, ref_entity, notes ` +
              `FROM jai_ontos.demo_schema.jai_action_log`
          ).catch(() => [] as Record<string, unknown>[]);
          for (const r of rows) {
            await lbQuery(
              `INSERT INTO action_log (action_id, created_at, updated_at, schema_label, domain, product, ` +
                `source, priority, issue, root_cause, recommended_action, confidence, decision, ` +
                `track_status, decided_by, decided_at, ref_entity, notes) VALUES ` +
                `($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (action_id) DO NOTHING`,
              [
                r.action_id, r.c ? new Date(String(r.c)) : null, r.u ? new Date(String(r.u)) : null,
                r.schema_label, r.domain, r.product, r.source, r.priority, r.issue, r.root_cause,
                r.recommended_action, r.confidence == null ? null : Number(r.confidence), r.decision,
                r.track_status, r.decided_by, r.d ? new Date(String(r.d)) : null, r.ref_entity, r.notes,
              ]
            ).catch((e) => console.error('[lakebase] migrate action_log row failed:', String(e)));
          }
          console.log(`[lakebase] migrated ${rows.length} action_log row(s) from Delta`);
        }
      } catch (err) {
        console.error('[lakebase] action_log migration skipped:', String(err));
      }
      try {
        const existing = await lbQuery<{ n: string }>(`SELECT count(*)::text AS n FROM product_links`);
        if (Number(existing[0]?.n ?? '0') === 0) {
          const rows = await runSql(
            `SELECT link_id, schema_label, domain, product, link_type, url, label, created_by, ` +
              `cast(created_at as string) c FROM jai_ontos.demo_schema.jai_product_links`
          ).catch(() => [] as Record<string, unknown>[]);
          for (const r of rows) {
            await lbQuery(
              `INSERT INTO product_links (link_id, schema_label, domain, product, link_type, url, label, ` +
                `created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (link_id) DO NOTHING`,
              [
                r.link_id, r.schema_label, r.domain, r.product, r.link_type, r.url, r.label,
                r.created_by, r.c ? new Date(String(r.c)) : null,
              ]
            ).catch((e) => console.error('[lakebase] migrate product_links row failed:', String(e)));
          }
          console.log(`[lakebase] migrated ${rows.length} product_links row(s) from Delta`);
        }
      } catch (err) {
        console.error('[lakebase] product_links migration skipped:', String(err));
      }
      // seed business rules from the static const on first run (then table is canonical)
      try {
        const existing = await lbQuery<{ n: string }>(`SELECT count(*)::text AS n FROM jai_business_rules`);
        if (Number(existing[0]?.n ?? '0') === 0) {
          for (const r of QSR_SC_REASONING_RULES) {
            await lbQuery(
              `INSERT INTO jai_business_rules (rule_id, domain, name, if_conditions, then_conclusion, concepts, ` +
                `evidence, enabled, origin, created_at, updated_at) ` +
                `VALUES ($1,$2,$3,$4,$5,$6,$7, true, 'seed', now(), now()) ON CONFLICT (rule_id) DO NOTHING`,
              [r.id, r.domain, r.name, JSON.stringify(r.if_conditions), r.then_conclusion,
               JSON.stringify(r.concepts ?? []), r.evidence ?? '']
            ).catch((e) => console.error('[lakebase] seed rule failed:', String(e)));
          }
          console.log(`[lakebase] seeded ${QSR_SC_REASONING_RULES.length} business rule(s)`);
        }
      } catch (err) {
        console.error('[lakebase] business-rules seed skipped:', String(err));
      }
    };
    void initLakebase();

    appkit.server.extend((app) => {
      // Tells the client whether the LLM-polish path is available.
      app.get('/api/llm-status', (_req, res) => {
        res.json({ available: hasLlm });
      });

      // ---- durable schema store: Volume = content, Lakebase = index ----
      // Operational index rows live in Lakebase (Postgres) for fast reads; the
      // raw schema JSON *content* stays in the UC Volume (lazy-loaded), same as
      // before. schema_json is also inlined in Postgres when small.
      const INLINE_MAX = 150 * 1024; // inline schema_json only if small

      // Save a schema: raw JSON → volume; metadata row → Lakebase (UPSERT dedupe).
      app.post('/api/save-schema', async (req, res) => {
        const b = (req.body ?? {}) as {
          customer?: string;
          schemaName?: string;
          source?: string;
          catalogRef?: string;
          schema?: Record<string, unknown>;
        };
        const customer = (b.customer ?? '').trim();
        const schemaName = (b.schemaName ?? '').trim();
        if (!customer || !schemaName || !b.schema || typeof b.schema !== 'object') {
          res.status(400).json({ error: 'customer, schemaName and schema are required' });
          return;
        }
        try {
          const schemaId = `sch_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
          const json = JSON.stringify(b.schema);
          const tableCount = Object.keys(b.schema).length;
          const safeCustomer = customer.replace(/[^a-zA-Z0-9_-]/g, '_') || 'customer';
          const volPath = `${VOLUME_BASE}/${safeCustomer}/${schemaId}.json`;

          // 1) write content to the volume
          const put = await volumePut(volPath, json);
          if (!put.ok) {
            res.json({
              ok: false,
              error: `Volume write failed (${put.status}): ${humanizeSqlError(await put.text())}`,
            });
            return;
          }

          // 2) whoami (created_by) — best-effort
          let createdBy = 'app-service-principal';
          try {
            const me = await authFetch('/api/2.0/preview/scim/v2/Me', { method: 'GET' });
            if (me.ok) createdBy = ((await me.json()) as { userName?: string })?.userName ?? createdBy;
          } catch {
            /* ignore */
          }

          // 3) index row in Lakebase (inline JSON only if small). De-dupe by
          // schema_name + customer: UPDATE in place (clear stale catalog_json)
          // instead of inserting a duplicate.
          const inline = json.length <= INLINE_MAX ? json : null;
          const existing = await lbQuery<{ schema_id: string }>(
            `SELECT schema_id FROM saved_schemas WHERE schema_name = $1 AND customer = $2 LIMIT 1`,
            [schemaName, customer]
          );
          if (existing.length > 0) {
            const existingId = existing[0].schema_id;
            await lbQuery(
              `UPDATE saved_schemas SET source = $1, catalog_ref = $2, table_count = $3, ` +
                `volume_path = $4, schema_json = $5, catalog_json = NULL WHERE schema_id = $6`,
              [b.source ?? 'upload', b.catalogRef ?? '', tableCount, volPath, inline, existingId]
            );
            res.json({ ok: true, schema_id: existingId, volume_path: volPath, table_count: tableCount, updated: true });
            return;
          }
          await lbQuery(
            `INSERT INTO saved_schemas ` +
              `(schema_id, customer, schema_name, source, catalog_ref, table_count, created_by, created_at, volume_path, schema_json) ` +
              `VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)`,
            [schemaId, customer, schemaName, b.source ?? 'upload', b.catalogRef ?? '', tableCount, createdBy, volPath, inline]
          );
          res.json({ ok: true, schema_id: schemaId, volume_path: volPath, table_count: tableCount });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // Persist a refined catalog for a saved schema (skip the LLM next time).
      app.post('/api/save-catalog', async (req, res) => {
        const b = (req.body ?? {}) as { schema_id?: string; catalog_json?: unknown };
        const id = String(b.schema_id ?? '').trim();
        if (!id || b.catalog_json == null) {
          res.status(400).json({ ok: false, error: 'schema_id and catalog_json required' });
          return;
        }
        const cat = typeof b.catalog_json === 'string' ? b.catalog_json : JSON.stringify(b.catalog_json);
        try {
          await lbQuery(`UPDATE saved_schemas SET catalog_json = $1 WHERE schema_id = $2`, [cat, id]);
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // ---- Scope-signature-keyed catalog cache (the "AI refining labels" cache) ----
      // GET returns a previously-refined catalog for a scope sig, or null (miss).
      // Covers ALL scopes (combined + built-in), not just single saved schemas.
      app.get('/api/catalog-cache', async (req, res) => {
        const sig = String(req.query.sig ?? '').trim();
        if (!sig) {
          res.json({ catalog: null });
          return;
        }
        try {
          const rows = await lbQuery<{ catalog_json: string | null }>(
            `SELECT catalog_json FROM catalog_cache WHERE sig = $1 LIMIT 1`,
            [sig]
          );
          const raw = rows[0]?.catalog_json;
          if (!raw) {
            res.json({ catalog: null });
            return;
          }
          res.json({ catalog: typeof raw === 'string' ? JSON.parse(raw) : raw });
        } catch (err) {
          res.json({ catalog: null, error: humanizeSqlError(err) });
        }
      });

      // POST upserts a refined catalog for a scope sig (called after LLM polish).
      app.post('/api/catalog-cache', async (req, res) => {
        const b = (req.body ?? {}) as { sig?: string; catalog_json?: unknown };
        const sig = String(b.sig ?? '').trim();
        if (!sig || b.catalog_json == null) {
          res.status(400).json({ ok: false, error: 'sig and catalog_json required' });
          return;
        }
        const cat = typeof b.catalog_json === 'string' ? b.catalog_json : JSON.stringify(b.catalog_json);
        try {
          await lbQuery(
            `INSERT INTO catalog_cache (sig, catalog_json, created_at) VALUES ($1, $2, now()) ` +
              `ON CONFLICT (sig) DO UPDATE SET catalog_json = EXCLUDED.catalog_json, created_at = now()`,
            [sig, cat]
          );
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // List saved-schema metadata (no blob).
      app.get('/api/saved-schemas', async (_req, res) => {
        try {
          const rows = await lbQuery(
            `SELECT schema_id, customer, schema_name, source, catalog_ref, table_count, created_by, ` +
              `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at, volume_path ` +
              `FROM saved_schemas ORDER BY created_at DESC`
          );
          res.json({ schemas: rows });
        } catch (err) {
          res.status(200).json({ schemas: [], error: humanizeSqlError(err) });
        }
      });

      // Fetch a saved schema's full content (volume file, or inline schema_json)
      // plus the cached refined catalog (catalog_json) when present.
      app.get('/api/saved-schema/:id', async (req, res) => {
        const id = String(req.params.id);
        try {
          const rows = await lbQuery<{ volume_path: string | null; schema_json: string | null; catalog_json: string | null }>(
            `SELECT volume_path, schema_json, catalog_json FROM saved_schemas WHERE schema_id = $1 LIMIT 1`,
            [id]
          );
          if (rows.length === 0) {
            res.status(404).json({ error: 'not found' });
            return;
          }
          // parse the cached refined catalog if present
          let catalog: unknown = undefined;
          const catRaw = rows[0].catalog_json;
          if (catRaw != null && catRaw !== '') {
            try {
              const c = typeof catRaw === 'string' ? JSON.parse(catRaw) : catRaw;
              if (c && typeof c === 'object') catalog = c;
            } catch {
              /* ignore bad cache */
            }
          }
          const inlineJson = rows[0].schema_json;
          if (inlineJson != null && inlineJson !== '') {
            const parsed = typeof inlineJson === 'string' ? JSON.parse(inlineJson) : inlineJson;
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
              res.json({ schema: parsed, catalog });
              return;
            }
          }
          const volPath = String(rows[0].volume_path ?? '');
          const dl = await volumeGet(volPath);
          if (!dl.ok) {
            res.json({ error: `Volume read failed (${dl.status})` });
            return;
          }
          res.json({ schema: JSON.parse(await dl.text()), catalog });
        } catch (err) {
          res.status(200).json({ error: humanizeSqlError(err) });
        }
      });

      // Delete a saved schema (Lakebase row + volume file).
      app.post('/api/delete-saved-schema', async (req, res) => {
        const id = String((req.body ?? {}).schema_id ?? '').trim();
        if (!id) {
          res.status(400).json({ error: 'schema_id required' });
          return;
        }
        try {
          const rows = await lbQuery<{ volume_path: string | null }>(
            `SELECT volume_path FROM saved_schemas WHERE schema_id = $1 LIMIT 1`,
            [id]
          );
          const volPath = rows[0]?.volume_path ? String(rows[0].volume_path) : '';
          await lbQuery(`DELETE FROM saved_schemas WHERE schema_id = $1`, [id]);
          if (volPath) {
            try {
              await volumeDelete(volPath);
            } catch {
              /* row is gone; volume file orphan is harmless */
            }
          }
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
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

      // single-turn LLM completion helper (graceful: returns null if unavailable)
      const llmComplete = async (prompt: string, maxTokens = 2000): Promise<string | null> => {
        if (!hasLlm) return null;
        try {
          const body = {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.3,
          } as Parameters<ReturnType<typeof appkit.serving>['invoke']>[0];
          const r = (await appkit.serving('llm').invoke(body)) as {
            ok?: boolean;
            data?: { choices?: { message?: { content?: string } }[] };
            choices?: { message?: { content?: string } }[];
          };
          if (r && r.ok === false) return null;
          const payload = r?.data ?? (r as { choices?: { message?: { content?: string } }[] });
          return payload?.choices?.[0]?.message?.content ?? null;
        } catch {
          return null;
        }
      };

      // ---- Feature 1: recommend actions (exceptions enrichment OR scenario) ----
      // Body: { mode, product, componentsSummary, signals?, opportunities? }
      // → JSON array [{id,priority,issue,root_cause,recommended_action,confidence,store?}]
      app.post('/api/recommend-actions', async (req, res) => {
        const b = (req.body ?? {}) as {
          mode?: 'exceptions' | 'scenario';
          product?: string;
          componentsSummary?: string;
          signals?: Record<string, unknown>;
          opportunities?: unknown[];
        };
        const mode = b.mode === 'scenario' ? 'scenario' : 'exceptions';
        if (!hasLlm) {
          res.json({ actions: [], llm: false, reason: 'no serving endpoint configured' });
          return;
        }
        const prompt =
          mode === 'exceptions'
            ? `You are an ops analyst for the data product "${b.product}". For EACH opportunity row ` +
              `below (stores running labor cost per customer over their peer benchmark), produce a ` +
              `prescriptive action. Return ONLY a JSON array; each item: {id, store, priority ` +
              `("HIGH"|"MEDIUM"|"LOW"), issue, root_cause, recommended_action, confidence (0..1)}. ` +
              `Base priority on opportunity_usd. Keep root_cause and recommended_action one sentence ` +
              `each, concrete and labor/staffing-focused.\n\nPRODUCT CONTEXT:\n${b.componentsSummary ?? ''}` +
              `\n\nOPPORTUNITY ROWS:\n${JSON.stringify(b.opportunities ?? []).slice(0, 40000)}`
            : `You are an ops analyst for the data product "${b.product}". Given operating SIGNALS ` +
              `and the product's semantics, produce a prioritized list of prescriptive actions the ` +
              `team should take. Return ONLY a JSON array; each item: {id, priority ` +
              `("HIGH"|"MEDIUM"|"LOW"), issue, root_cause, recommended_action, confidence (0..1)}. ` +
              `Ground the actions in the product's measures/KPIs.\n\nPRODUCT CONTEXT:\n` +
              `${b.componentsSummary ?? ''}\n\nSIGNALS:\n${JSON.stringify(b.signals ?? {})}`;
        const content = await llmComplete(prompt, 4000);
        const json = extractJsonArray(content ?? '');
        if (json) {
          res.json({ actions: json, llm: true, mode });
          return;
        }
        res.json({ actions: [], llm: false, mode, reason: 'model returned no usable JSON' });
      });

      // ---- Data-backed exceptions for a "Data Avlbl" product (AGGREGATED) ----
      // Body: { product }  → computes SUMMARY STATS + a few representative rows,
      // then asks the LLM for a HANDFUL (~3-5) of high-level AGGREGATE actions
      // (each carrying the underlying counts). Row detail is returned for expand.
      app.post('/api/data-exceptions', async (req, res) => {
        const b = (req.body ?? {}) as { product?: string };
        const product = (b.product ?? '').trim();
        const meta = DEMO_PRODUCTS[product];
        const aggSql = demoAggregateSql(product);
        const rowSql = demoExceptionSql(product, 8); // a few representative examples
        if (!meta || !aggSql || !rowSql) {
          res.status(400).json({ actions: [], reason: 'not a data-backed product', rows: [], stats: null });
          return;
        }
        let stats: Record<string, unknown> = {};
        let rows: Record<string, unknown>[] = [];
        try {
          const [aggRows, exRows] = await Promise.all([runSql(aggSql), runSql(rowSql)]);
          stats = aggRows[0] ?? {};
          rows = exRows;
        } catch (err) {
          res.json({ actions: [], rows: [], stats: null, llm: false, reason: `query failed: ${String(err)}` });
          return;
        }
        const total = Number(stats.failed_tests ?? stats.stale_tables ?? stats.failed_runs ?? stats.high_mape_items ?? stats.at_risk_items ?? stats.late_pos ?? rows.length) || 0;
        if (total === 0 && rows.length === 0) {
          res.json({ actions: [], rows: [], stats, llm: hasLlm, reason: 'no exceptions found' });
          return;
        }
        // supporting-data + prescriptive playbook returned on every response so the
        // panel can drill to the exact query and render guidance even without the LLM
        const extra = {
          sql: { aggregate: aggSql, rows: rowSql },
          full_count: total,
          playbook: meta.playbook ?? [],
        };
        if (!hasLlm) {
          // deterministic fallback grounded in the curated playbook (renders w/o a model)
          const pb = meta.playbook ?? [];
          res.json({
            actions: [
              {
                id: `dx-${product}-agg`,
                priority: 'HIGH',
                issue: `${total} exception(s) — ${meta.issue}`,
                root_cause: pb[0]?.root_cause ?? 'Aggregate of data-backed exception rows.',
                recommended_action: pb[0]?.recommended_action ?? meta.action_hint,
                confidence: 0.6,
                stats,
              },
            ],
            rows,
            stats,
            llm: false,
            ...extra,
          });
          return;
        }
        const playbookText = (meta.playbook ?? [])
          .map((p) => `- (${p.source}) ${p.root_cause} → ${p.recommended_action}`)
          .join('\n');
        const prompt =
          `You are an ops analyst for the data product "${meta.display_name}" ` +
          `(domain: ${meta.domainLabel}). Below are AGGREGATE stats over the real exception rows ` +
          `(${meta.issue}) plus a few representative examples. Produce a SHORT list of 3-5 HIGH-LEVEL ` +
          `AGGREGATE actions (NOT one per row) — each should summarize a group with its counts, e.g. ` +
          `"12 DQ tests failing (4 critical) across 5 tables — triage critical failures". Return ONLY a ` +
          `JSON array; each item: {id, priority ("HIGH"|"MEDIUM"|"LOW"), issue, root_cause, ` +
          `recommended_action, confidence (0..1)}. Put the concrete counts in "issue". Bucket priority ` +
          `by severity/impact. Keep root_cause and recommended_action to one sentence each. ` +
          (playbookText
            ? `GROUND your root_cause/recommended_action in this curated playbook and do not contradict it:\n${playbookText}\n\n`
            : `A good action looks like: ${meta.action_hint}\n\n`) +
          `AGGREGATE STATS:\n${JSON.stringify(stats)}\n\n` +
          `REPRESENTATIVE ROWS:\n${JSON.stringify(rows).slice(0, 12000)}`;
        const content = await llmComplete(prompt, 2000);
        const json = extractJsonArray(content ?? '');
        if (json) {
          res.json({ actions: json.slice(0, 6), rows, stats, llm: true, product, ...extra });
          return;
        }
        res.json({ actions: [], rows, stats, llm: false, reason: 'model returned no usable JSON', ...extra });
      });

      // ---- Feature 2: Ontology Copilot ----
      // Body: { question, productContext, history?, product?, live?, useData? }
      // → { answer, action? }. For live products may attach a kpi_summary snapshot;
      //    for data-backed products with useData, attaches a real exception snapshot.
      app.post('/api/copilot', async (req, res) => {
        const b = (req.body ?? {}) as {
          question?: string;
          productContext?: string;
          history?: { role: string; content: string }[];
          product?: string;
          live?: boolean;
          useData?: boolean;
          execMode?: boolean; // Executive Copilot — structured exec answer
        };
        const question = (b.question ?? '').trim();
        if (!question) {
          res.status(400).json({ answer: 'Ask a question about the selected data product.' });
          return;
        }
        if (!hasLlm) {
          res.json({
            answer:
              'The Foundation Model endpoint is not configured for this deployment, so the Copilot is unavailable. The ontology, contract, and graph views still work without it.',
          });
          return;
        }

        // optional live snapshot for the flagship (best-effort)
        let snapshot = '';
        if (b.live) {
          try {
            const rows = await appkit.analytics.query(
              "SELECT * FROM jai_ontos.demo_schema.jai_store_efficiency_opportunities ORDER BY opportunity_rank LIMIT 10"
            );
            snapshot = `\n\nLIVE SNAPSHOT (top opportunities):\n${JSON.stringify(rows).slice(0, 6000)}`;
          } catch {
            /* ignore snapshot failures */
          }
        }
        // data-backed snapshot for a "Data Avlbl" product when the toggle is on
        if (b.useData && isDemoProduct(b.product)) {
          const snap = demoSnapshotSql(b.product!, 10);
          if (snap) {
            try {
              const [countRows, topRows] = await Promise.all([runSql(snap.count), runSql(snap.top)]);
              const count = (countRows[0]?.exception_count ?? countRows[0]?.EXCEPTION_COUNT ?? '?');
              snapshot += `\n\nDATA AVLBL SNAPSHOT (${count} exception rows total; top rows):\n${JSON.stringify(topRows).slice(0, 8000)}`;
            } catch {
              /* ignore snapshot failures */
            }
          }
        }

        const hist = (b.history ?? [])
          .slice(-6)
          .map((h) => `${h.role}: ${h.content}`)
          .join('\n');
        const execInstr = b.execMode
          ? `You are an EXECUTIVE COPILOT for a supply-chain control tower. Structure the answer as ` +
            `short labeled lines — "Explanation:", "Evidence:" (cite the counts/numbers from the ` +
            `snapshot), "Recommendation:", "Confidence:" (Low/Medium/High), "Business impact:" (a ` +
            `qualitative or $ estimate). Keep each to one sentence. `
          : `Be concise (2-5 sentences). `;
        const prompt =
          `You are the Ontology Copilot for a governed data-product app. Answer the user's question ` +
          `GROUNDED ONLY in the product context (ontology classes, measures/KPIs + formulas, ` +
          `relationships) and any live snapshot provided — do not invent tables, columns, or numbers. ` +
          execInstr +
          `If the user is asking to DO something operational (e.g. fix a ` +
          `store, adjust staffing), you MAY additionally propose ONE action as a fenced \`\`\`json ` +
          `block with {priority, issue, root_cause, recommended_action, confidence}. Otherwise omit it.` +
          `\n\nPRODUCT (${b.product ?? ''}) CONTEXT:\n${b.productContext ?? ''}${snapshot}` +
          (hist ? `\n\nCONVERSATION:\n${hist}` : '') +
          `\n\nUSER QUESTION:\n${question}`;
        const content = (await llmComplete(prompt, 2000)) ?? '';
        if (!content) {
          res.json({ answer: 'The model did not return a response. Please try again.' });
          return;
        }
        const action = extractJsonObject(content);
        // strip the fenced json from the visible answer
        const answer = content.replace(/```(?:json)?\s*[\s\S]*?```/g, '').trim() || content;
        res.json({ answer, action: action && action.recommended_action ? action : undefined });
      });

      // ---- Feature 3: action log / tracker (persisted to Lakebase action_log) ----
      const whoami = async (): Promise<string> => {
        try {
          const me = await authFetch('/api/2.0/preview/scim/v2/Me', { method: 'GET' });
          if (me.ok) return ((await me.json()) as { userName?: string })?.userName ?? 'unknown';
        } catch {
          /* ignore */
        }
        return 'unknown';
      };

      // POST /api/log-action — insert a decided action into the Lakebase log.
      app.post('/api/log-action', async (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const decision = String(b.decision ?? '');
        if (!['approved', 'modified', 'rejected'].includes(decision)) {
          res.status(400).json({ ok: false, error: 'decision must be approved|modified|rejected' });
          return;
        }
        const decidedBy = await whoami();
        // Deterministic id from product+issue so re-deciding a regenerated (non-
        // persisted) exception UPSERTS instead of creating a duplicate log row.
        const dedupKey = `${String(b.product ?? '')}|${String(b.issue ?? '')}`;
        const actionId = `act_${createHash('sha1').update(dedupKey).digest('hex').slice(0, 16)}`;
        const conf = typeof b.confidence === 'number' ? (b.confidence as number) : Number(b.confidence) || 0;
        try {
          await lbQuery(
            `INSERT INTO action_log ` +
              `(action_id, created_at, updated_at, schema_label, domain, product, source, priority, ` +
              `issue, root_cause, recommended_action, confidence, decision, track_status, decided_by, ` +
              `decided_at, ref_entity, notes) VALUES (` +
              `$1, now(), now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12, now(), $13, $14) ` +
              `ON CONFLICT (action_id) DO UPDATE SET updated_at = now(), priority = EXCLUDED.priority, ` +
              `root_cause = EXCLUDED.root_cause, recommended_action = EXCLUDED.recommended_action, ` +
              `confidence = EXCLUDED.confidence, decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, ` +
              `decided_at = now()`,
            [
              actionId,
              String(b.schema_label ?? ''),
              String(b.domain ?? ''),
              String(b.product ?? ''),
              String(b.source ?? ''),
              String(b.priority ?? ''),
              String(b.issue ?? ''),
              String(b.root_cause ?? ''),
              String(b.recommended_action ?? ''),
              conf,
              decision,
              decidedBy,
              String(b.ref_entity ?? ''),
              String(b.notes ?? ''),
            ]
          );
          res.json({ ok: true, action_id: actionId, decided_by: decidedBy });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // GET /api/action-log — list logged actions (optional ?product= &status=).
      app.get('/api/action-log', async (req, res) => {
        const product = (req.query.product as string | undefined)?.trim();
        const status = (req.query.status as string | undefined)?.trim();
        const where: string[] = [];
        const params: unknown[] = [];
        if (product) { params.push(product); where.push(`product = $${params.length}`); }
        if (status) { params.push(status); where.push(`track_status = $${params.length}`); }
        const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        try {
          const rows = await lbQuery(
            `SELECT action_id, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at, ` +
              `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at, schema_label, domain, product, source, ` +
              `priority, issue, root_cause, recommended_action, confidence, decision, track_status, ` +
              `decided_by, to_char(decided_at, 'YYYY-MM-DD HH24:MI:SS') AS decided_at, ref_entity, notes ` +
              `FROM action_log${clause} ORDER BY created_at DESC LIMIT 500`,
            params
          );
          res.json({ actions: rows });
        } catch (err) {
          res.json({ actions: [], error: String(err) });
        }
      });

      // POST /api/update-action-status — advance open→in_progress→done.
      app.post('/api/update-action-status', async (req, res) => {
        const b = (req.body ?? {}) as { action_id?: string; track_status?: string };
        const id = (b.action_id ?? '').trim();
        const st = (b.track_status ?? '').trim();
        if (!id || !['open', 'in_progress', 'done'].includes(st)) {
          res.status(400).json({ ok: false, error: 'action_id + track_status(open|in_progress|done) required' });
          return;
        }
        try {
          await lbQuery(
            `UPDATE action_log SET track_status = $1, updated_at = now() WHERE action_id = $2`,
            [st, id]
          );
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // ---- Feature 4: product links (Genie Space / AI-BI dashboard) ----
      // POST /api/attach-link — attach a Genie/dashboard URL to a product.
      app.post('/api/attach-link', async (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const linkType = String(b.link_type ?? '');
        const url = String(b.url ?? '').trim();
        if (!['genie', 'dashboard'].includes(linkType) || !url) {
          res.status(400).json({ ok: false, error: 'link_type(genie|dashboard) + url required' });
          return;
        }
        const createdBy = await whoami();
        const linkId = `lnk_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        try {
          await lbQuery(
            `INSERT INTO product_links ` +
              `(link_id, schema_label, domain, product, link_type, url, label, created_by, created_at) ` +
              `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
            [
              linkId,
              String(b.schema_label ?? ''),
              String(b.domain ?? ''),
              String(b.product ?? ''),
              linkType,
              url,
              String(b.label ?? ''),
              createdBy,
            ]
          );
          res.json({ ok: true, link_id: linkId, created_by: createdBy });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // GET /api/product-links — list links (optional ?product=).
      app.get('/api/product-links', async (req, res) => {
        const product = (req.query.product as string | undefined)?.trim();
        const params: unknown[] = [];
        let clause = '';
        if (product) { params.push(product); clause = ` WHERE product = $1`; }
        try {
          const rows = await lbQuery(
            `SELECT link_id, schema_label, domain, product, link_type, url, label, created_by, ` +
              `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at FROM product_links${clause} ` +
              `ORDER BY created_at DESC LIMIT 500`,
            params
          );
          res.json({ links: rows });
        } catch (err) {
          res.json({ links: [], error: String(err) });
        }
      });

      // POST /api/delete-link — remove a link.
      app.post('/api/delete-link', async (req, res) => {
        const id = String((req.body as { link_id?: string })?.link_id ?? '').trim();
        if (!id) {
          res.status(400).json({ ok: false, error: 'link_id required' });
          return;
        }
        try {
          await lbQuery(`DELETE FROM product_links WHERE link_id = $1`, [id]);
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // ---- Ontology curation: user overrides layered over derived components ----
      // POST /api/ontology-override — upsert one override (unique per
      // schema_label + product + kind + ref + action).
      app.post('/api/ontology-override', async (req, res) => {
        const b = (req.body ?? {}) as {
          schema_label?: string;
          product?: string;
          kind?: string;
          ref?: string;
          action?: string;
          value?: unknown;
        };
        const kinds = ['entity', 'relationship', 'mapping', 'edge_status', 'glossary', 'suggest_status'];
        const actions = ['rename', 'merge', 'set_role', 'set_pii', 'delete', 'confirm', 'reject', 'add', 'define'];
        if (!b.schema_label || !kinds.includes(String(b.kind)) || !actions.includes(String(b.action)) || !b.ref) {
          res.status(400).json({ ok: false, error: 'schema_label, kind, action, ref required' });
          return;
        }
        const createdBy = await whoami();
        const value = b.value == null ? '' : typeof b.value === 'string' ? b.value : JSON.stringify(b.value);
        // deterministic id so the same target+action upserts in place
        const id = `ov_${Buffer.from(`${b.schema_label}|${b.product ?? ''}|${b.kind}|${b.ref}|${b.action}`).toString('base64url').slice(0, 48)}`;
        try {
          await lbQuery(
            `INSERT INTO ontology_overrides (id, schema_label, product, kind, ref, action, value, created_by, created_at) ` +
              `VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) ` +
              `ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, created_by = EXCLUDED.created_by, created_at = now()`,
            [id, b.schema_label, b.product ?? '', b.kind, b.ref, b.action, value, createdBy]
          );
          res.json({ ok: true, id });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // GET /api/ontology-overrides?schema=<label>[&product=<name>]
      app.get('/api/ontology-overrides', async (req, res) => {
        const schema = (req.query.schema as string | undefined)?.trim();
        const product = (req.query.product as string | undefined)?.trim();
        if (!schema) {
          res.status(400).json({ overrides: [], error: 'schema required' });
          return;
        }
        const params: unknown[] = [schema];
        let clause = `schema_label = $1`;
        if (product) {
          params.push(product);
          clause += ` AND product = $2`;
        }
        try {
          const rows = await lbQuery(
            `SELECT id, schema_label, product, kind, ref, action, value, created_by, ` +
              `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at ` +
              `FROM ontology_overrides WHERE ${clause} ORDER BY created_at DESC LIMIT 2000`,
            params
          );
          res.json({ overrides: rows });
        } catch (err) {
          res.json({ overrides: [], error: String(err) });
        }
      });

      // POST /api/delete-ontology-override {id}
      app.post('/api/delete-ontology-override', async (req, res) => {
        const id = String((req.body as { id?: string })?.id ?? '').trim();
        if (!id) {
          res.status(400).json({ ok: false, error: 'id required' });
          return;
        }
        try {
          await lbQuery(`DELETE FROM ontology_overrides WHERE id = $1`, [id]);
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // ---- B) LLM-suggested relationships the shared-key heuristic missed ----
      // Body: { product, componentsSummary, tables:[{table, columns:[]}] }.
      // Returns sanitized [{from,to,predicate,column,rationale,confidence}] that
      // only reference tables/columns present in `tables`. [] if LLM unavailable.
      app.post('/api/suggest-relationships', async (req, res) => {
        const b = (req.body ?? {}) as {
          product?: string;
          componentsSummary?: string;
          tables?: { table: string; columns: string[] }[];
        };
        const tables = Array.isArray(b.tables) ? b.tables : [];
        if (!hasLlm || tables.length < 2) {
          res.json({ suggestions: [], llm: hasLlm, reason: hasLlm ? 'need >=2 tables' : 'no serving endpoint' });
          return;
        }
        const tableCols = new Map<string, Set<string>>();
        for (const t of tables) tableCols.set(t.table, new Set((t.columns ?? []).map((c) => String(c))));
        const shape = tables
          .map((t) => `${t.table}: ${(t.columns ?? []).slice(0, 30).join(', ')}`)
          .join('\n')
          .slice(0, 12000);
        const prompt =
          `You are a data modeler. Below are the REAL tables and columns of the data product ` +
          `"${b.product}". Propose plausible JOIN relationships (foreign keys) that a naive shared-` +
          `key match would MISS — e.g. semantically-equivalent column names (customer_id ↔ cust_id), ` +
          `or a dimension key referenced under a different name. ONLY use tables and columns listed ` +
          `below; do NOT invent any. Return ONLY a JSON array; each item: ` +
          `{from (table), to (table), predicate (short label), column (the join column on 'from'), ` +
          `toColumn (the matching column on 'to' — may differ in name from column), ` +
          `rationale (one sentence), confidence (0..1)}.\n\nTABLES:\n${shape}`;
        const content = await llmComplete(prompt, 2000);
        const raw = extractJsonArray(content ?? '') ?? [];
        // sanitize: keep only suggestions referencing real tables (drop hallucinations)
        const suggestions = raw
          .map((s) => {
            const column = String(s.column ?? '');
            // fall back to the from-column name when the LLM omits toColumn
            const toColumn = String(s.toColumn ?? s.to_column ?? column);
            return {
              from: String(s.from ?? ''),
              to: String(s.to ?? ''),
              predicate: String(s.predicate ?? s.column ?? 'related'),
              column,
              toColumn,
              rationale: String(s.rationale ?? ''),
              confidence: typeof s.confidence === 'number' ? s.confidence : 0.4,
            };
          })
          .filter(
            (s) =>
              s.from &&
              s.to &&
              s.from !== s.to &&
              tableCols.has(s.from) &&
              tableCols.has(s.to) &&
              // named columns must exist on their respective tables
              (!s.column || tableCols.get(s.from)!.has(s.column)) &&
              (!s.toColumn || tableCols.get(s.to)!.has(s.toColumn))
          )
          .slice(0, 12);
        res.json({ suggestions, llm: true });
      });

      // ---- C) Validate ontology against live warehouse data (opt-in) ----
      // Body: { product, tables:[<catalog.schema.table>], relationships:[{from,to,column}] }
      // Returns per-table row_count + per-key null/distinct %, per-FK join hit-rate.
      // Per-target errors (inaccessible catalog) are caught → "no access".
      app.post('/api/validate-ontology', async (req, res) => {
        const b = (req.body ?? {}) as {
          product?: string;
          tables?: { table: string; keys?: string[] }[];
          // `column` is the shared-name fallback; fromColumn/toColumn let a FK
          // join differently-named keys (e.g. cust_id ↔ customer_id).
          relationships?: {
            from: string;
            to: string;
            column: string;
            fromColumn?: string;
            toColumn?: string;
          }[];
        };
        const tables = Array.isArray(b.tables) ? b.tables.slice(0, 40) : [];
        const rels = Array.isArray(b.relationships) ? b.relationships.slice(0, 40) : [];
        const okIdent = (t: string) => /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){1,2}$/.test(t);
        const okCol = (c: string) => /^[A-Za-z0-9_]+$/.test(c);

        const tableResults: Record<string, unknown>[] = [];
        for (const t of tables) {
          if (!okIdent(t.table)) {
            tableResults.push({ table: t.table, error: 'invalid identifier' });
            continue;
          }
          try {
            const cnt = await runSql(`SELECT count(*) AS n FROM ${t.table}`);
            const rowCount = Number((cnt[0]?.n ?? cnt[0]?.N) ?? 0);
            const keyStats: Record<string, unknown>[] = [];
            for (const k of (t.keys ?? []).filter(okCol).slice(0, 8)) {
              try {
                const s = await runSql(
                  `SELECT count(*) AS total, count(${k}) AS non_null, approx_count_distinct(${k}) AS distinct_ct ` +
                    `FROM ${t.table}`
                );
                const total = Number(s[0]?.total ?? 0) || 0;
                const nonNull = Number(s[0]?.non_null ?? 0) || 0;
                const distinct = Number(s[0]?.distinct_ct ?? 0) || 0;
                keyStats.push({
                  column: k,
                  null_pct: total ? Math.round(((total - nonNull) / total) * 1000) / 10 : 0,
                  distinct_pct: total ? Math.round((distinct / total) * 1000) / 10 : 0,
                });
              } catch (e) {
                keyStats.push({ column: k, error: humanizeSqlError(e) });
              }
            }
            tableResults.push({ table: t.table, row_count: rowCount, keys: keyStats });
          } catch (e) {
            tableResults.push({ table: t.table, error: humanizeSqlError(e) || 'no access / cannot validate' });
          }
        }

        const relResults: Record<string, unknown>[] = [];
        for (const r of rels) {
          // fromColumn lives on the child (from) table, toColumn on the parent
          // (to). Both default to `column` for same-named heuristic FKs.
          const fromCol = r.fromColumn || r.column;
          const toCol = r.toColumn || r.column;
          if (!okIdent(r.from) || !okIdent(r.to) || !okCol(fromCol) || !okCol(toCol)) {
            relResults.push({ ...r, error: 'invalid identifier' });
            continue;
          }
          try {
            // hit-rate = fraction of child (from) rows whose key matches a parent (to) row
            const q =
              `SELECT count(*) AS child_rows, ` +
              `count(p.k) AS matched FROM ${r.from} c ` +
              `LEFT JOIN (SELECT DISTINCT ${toCol} AS k FROM ${r.to}) p ON c.${fromCol} = p.k ` +
              `WHERE c.${fromCol} IS NOT NULL`;
            const s = await runSql(q);
            const child = Number(s[0]?.child_rows ?? 0) || 0;
            const matched = Number(s[0]?.matched ?? 0) || 0;
            relResults.push({
              from: r.from,
              to: r.to,
              column: r.column,
              from_column: fromCol,
              to_column: toCol,
              hit_rate: child ? Math.round((matched / child) * 1000) / 10 : null,
              child_rows: child,
            });
          } catch (e) {
            relResults.push({ ...r, error: humanizeSqlError(e) || 'no access / cannot validate' });
          }
        }

        res.json({ product: b.product, tables: tableResults, relationships: relResults });
      });

      // ---- D) Dry-run a generated serving-view's SELECT against the warehouse ----
      // Body: { sql } — the full generated `CREATE ... VIEW ... AS <select>;`.
      // We strip the DDL wrapper + comments and EXPLAIN the SELECT so the planner
      // resolves every column/join WITHOUT creating the view or scanning data.
      // Returns { ok, error? } so the UI can prove the DDL will run before anyone
      // copies it. Read-only: only EXPLAIN of a single SELECT is allowed.
      app.post('/api/verify-view-sql', async (req, res) => {
        const raw = String((req.body as { sql?: string })?.sql ?? '');
        // drop line comments, then take the body after the first `AS`, minus `;`
        const noComments = raw.replace(/^\s*--.*$/gm, '').trim();
        const asMatch = noComments.match(/\bAS\b([\s\S]*)$/i);
        const select = (asMatch ? asMatch[1] : noComments).trim().replace(/;\s*$/, '');
        if (!/^select\b/i.test(select)) {
          res.json({ ok: false, error: 'No SELECT body found to verify.' });
          return;
        }
        // reject anything that could mutate — EXPLAIN of one read-only SELECT only
        if (/;|\b(insert|update|delete|drop|create|alter|merge|grant|truncate)\b/i.test(select)) {
          res.json({ ok: false, error: 'Only a single read-only SELECT can be verified.' });
          return;
        }
        try {
          const rows = await runSql(`EXPLAIN ${select}`);
          // DBSQL EXPLAIN may embed an analysis error in the plan text instead
          // of failing the statement — inspect the returned plan for errors.
          const plan = rows.map((r) => Object.values(r).join(' ')).join('\n');
          if (/AnalysisException|cannot be resolved|UNRESOLVED_COLUMN|UnresolvedRelation|TABLE_OR_VIEW_NOT_FOUND/i.test(plan)) {
            // reuse humanizeSqlError so unresolved tables get the friendly message
            res.json({ ok: false, error: humanizeSqlError(plan) });
            return;
          }
          res.json({ ok: true });
        } catch (e) {
          res.json({ ok: false, error: humanizeSqlError(e) || 'verification failed' });
        }
      });

      // ======================================================================
      // Domain-level MONITORING JOB builder (Action Center).
      // Aggregate-only by construction: computation runs ONLY demoAggregateSql
      // (one summary row per product) and stores results in jai_monitor_run,
      // which has NO decision/recommendation columns. It never proposes or takes
      // action — that stays in action_log. Everything keys on `domain`.
      // ======================================================================
      const monitorJobId = (domain: string) => `jai_monitor_${domain}`;
      const monitorJobName = (domain: string) => `jai_monitor_${domain}_daily`;
      const monitorDomain = (name: string) => ALL_DEMO_DOMAINS.find((d) => d.name === name);
      // the aggregate column aliases a product's aggregate_select emits (AS <key>)
      const metricKeys = (productName: string): string[] => {
        const sql = demoAggregateSql(productName) ?? '';
        const keys: string[] = [];
        const re = /\bAS\s+([A-Za-z0-9_]+)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sql)) !== null) keys.push(m[1]);
        return keys;
      };

      // Shared run helper — mirrored by the Phase-2 scheduled Databricks Job.
      // Loops all products in the domain, runs the aggregate SQL, and upserts one
      // jai_monitor_run row per (job, product, day). Returns per-product results.
      const runMonitorJob = async (
        domain: string,
        trigger: 'scheduled' | 'on_demand'
      ): Promise<{ ok: boolean; run_id?: string; results?: Record<string, unknown>[]; error?: string }> => {
        const dom = monitorDomain(domain);
        if (!dom) return { ok: false, error: 'unknown domain' };
        const jobId = monitorJobId(domain);
        const runDate = new Date().toISOString().slice(0, 10);
        // run-level id for the response; each stored row gets its own unique id
        // (run_id is the table PK, so it must be unique per product row).
        const runId = `jai_run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

        // 1) compute aggregate stats per product
        const results: Record<string, unknown>[] = [];
        for (const p of dom.products) {
          const aggSql = demoAggregateSql(p.product_name);
          if (!aggSql) {
            results.push({ product: p.product_name, status: 'error', error: 'no aggregate SQL' });
            continue;
          }
          try {
            const rows = await runSql(aggSql);
            const stats = rows[0] ?? {};
            // headline count = first numeric aggregate column (generalizes across domains)
            const firstNum = Object.values(stats).find((v) => typeof v === 'number' || (!isNaN(Number(v)) && v !== null && v !== ''));
            const total = Number(firstNum ?? 0) || 0;
            results.push({
              product: p.product_name,
              display_name: p.display_name,
              status: total > 0 ? 'breach' : 'ok',
              exception_total: total,
              metrics: stats,
            });
          } catch (e) {
            results.push({ product: p.product_name, status: 'error', error: humanizeSqlError(e) });
          }
        }

        // 2) optional ONE domain-level narrative (aggregate-only; no actions).
        // Best-effort: an LLM failure must NOT abort the run (the aggregate counts
        // are the real deliverable) — otherwise the whole request 500s as HTML.
        let llmSummary: string | null = null;
        if (hasLlm) {
          try {
            const prompt =
              `You are a monitoring analyst for the "${dom.label}" domain. Below are AGGREGATE health ` +
              `metrics for each data product (one summary row each). Write a 1-2 sentence AGGREGATE status ` +
              `summary of the domain's health — cite the key counts. Do NOT propose actions, do NOT resolve ` +
              `anything, do NOT list individual rows. Plain text only.\n\n${JSON.stringify(results).slice(0, 8000)}`;
            llmSummary = await llmComplete(prompt, 400);
          } catch {
            llmSummary = null;
          }
        }

        // 3) upsert one row per product (idempotent per day)
        try {
          for (const r of results) {
            await lbQuery(
              `INSERT INTO jai_monitor_run (run_id, job_id, domain, run_ts, run_date, trigger, product, ` +
                `metrics_json, exception_total, status, error, llm_summary, created_at) ` +
                `VALUES ($1,$2,$3, now(), $4::date, $5, $6, $7, $8, $9, $10, $11, now()) ` +
                `ON CONFLICT (job_id, product, run_date) DO UPDATE SET ` +
                `run_id = EXCLUDED.run_id, run_ts = EXCLUDED.run_ts, trigger = EXCLUDED.trigger, ` +
                `metrics_json = EXCLUDED.metrics_json, exception_total = EXCLUDED.exception_total, ` +
                `status = EXCLUDED.status, error = EXCLUDED.error, llm_summary = EXCLUDED.llm_summary`,
              [
                `${runId}_${String(r.product)}`,
                jobId,
                domain,
                runDate,
                trigger,
                String(r.product),
                JSON.stringify(r.metrics ?? {}),
                Number(r.exception_total ?? 0) || 0,
                String(r.status ?? 'ok'),
                r.error ? String(r.error) : null,
                llmSummary,
              ]
            );
          }
        } catch (e) {
          return { ok: false, error: humanizeSqlError(e) };
        }
        return { ok: true, run_id: runId, results };
      };

      // GET saved definition for a domain (or null).
      app.get('/api/monitor-job', async (req, res) => {
        const domain = String(req.query.domain ?? '').trim();
        if (!domain) {
          res.json({ job: null });
          return;
        }
        try {
          const rows = await lbQuery(
            `SELECT job_id, domain, domain_label, job_name, schedule_cron, schedule_tz, products_json, ` +
              `aggregates_json, summary_prompt, enabled, version, created_by, ` +
              `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at ` +
              `FROM jai_monitor_job WHERE domain = $1 LIMIT 1`,
            [domain]
          );
          res.json({ job: rows[0] ?? null });
        } catch (err) {
          res.json({ job: null, error: humanizeSqlError(err) });
        }
      });

      // Upsert (save/revise) a domain's monitoring definition; bumps version.
      app.post('/api/monitor-job', async (req, res) => {
        const b = (req.body ?? {}) as {
          domain?: string;
          schedule_cron?: string;
          schedule_tz?: string;
          aggregates_json?: unknown;
          summary_prompt?: string;
          enabled?: boolean;
        };
        const domain = String(b.domain ?? '').trim();
        const dom = monitorDomain(domain);
        if (!dom) {
          res.status(400).json({ ok: false, error: 'unknown or non-data-backed domain' });
          return;
        }
        const jobId = monitorJobId(domain);
        const jobName = monitorJobName(domain);
        const products = dom.products.map((p) => p.product_name);
        const agg =
          b.aggregates_json == null
            ? '[]'
            : typeof b.aggregates_json === 'string'
              ? b.aggregates_json
              : JSON.stringify(b.aggregates_json);
        try {
          const who = await whoami();
          const rows = await lbQuery<{ version: number }>(
            `INSERT INTO jai_monitor_job (job_id, domain, domain_label, job_name, schedule_cron, schedule_tz, ` +
              `products_json, aggregates_json, summary_prompt, enabled, version, created_by, created_at, updated_at) ` +
              `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 1, $11, now(), now()) ` +
              `ON CONFLICT (domain) DO UPDATE SET ` +
              `job_name = EXCLUDED.job_name, schedule_cron = EXCLUDED.schedule_cron, ` +
              `schedule_tz = EXCLUDED.schedule_tz, products_json = EXCLUDED.products_json, ` +
              `aggregates_json = EXCLUDED.aggregates_json, summary_prompt = EXCLUDED.summary_prompt, ` +
              `enabled = EXCLUDED.enabled, version = jai_monitor_job.version + 1, updated_at = now() ` +
              `RETURNING version`,
            [
              jobId,
              domain,
              dom.label,
              jobName,
              String(b.schedule_cron ?? '0 0 7 * * ?'),
              String(b.schedule_tz ?? 'America/New_York'),
              JSON.stringify(products),
              agg,
              b.summary_prompt ? String(b.summary_prompt) : null,
              b.enabled === false ? false : true,
              who,
            ]
          );
          res.json({ ok: true, job_id: jobId, job_name: jobName, version: rows[0]?.version ?? 1 });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // Chat builder — helps the user assemble an AGGREGATE monitoring spec.
      // Guardrailed: may only propose metrics/thresholds, never actions.
      app.post('/api/monitor-chat', async (req, res) => {
        const b = (req.body ?? {}) as {
          domain?: string;
          question?: string;
          history?: { role: string; content: string }[];
          currentSpec?: unknown;
        };
        const dom = monitorDomain(String(b.domain ?? ''));
        if (!dom) {
          res.status(400).json({ answer: 'Unknown domain.', spec: null });
          return;
        }
        if (!hasLlm) {
          res.json({ answer: 'The assistant is unavailable (no serving endpoint configured).', spec: null, llm: false });
          return;
        }
        const catalog = dom.products
          .map((p) => `- ${p.product_name} (${p.display_name}): metrics [${metricKeys(p.product_name).join(', ')}]`)
          .join('\n');
        const hist = Array.isArray(b.history)
          ? b.history.slice(-6).map((h) => `${h.role}: ${h.content}`).join('\n')
          : '';
        const prompt =
          `You are helping define a DAILY AGGREGATE monitoring job for the "${dom.label}" domain. It runs ` +
          `across ALL products in the domain and stores only aggregate counts — it must NEVER resolve issues, ` +
          `take action, or reference individual rows. Your job is ONLY to help the user choose which aggregate ` +
          `metrics (and optional numeric thresholds) to watch per product.\n\n` +
          `AVAILABLE PRODUCTS AND METRIC KEYS (use ONLY these keys):\n${catalog}\n\n` +
          (b.currentSpec ? `CURRENT SPEC:\n${JSON.stringify(b.currentSpec).slice(0, 4000)}\n\n` : '') +
          (hist ? `CONVERSATION:\n${hist}\n\n` : '') +
          `USER: ${String(b.question ?? '')}\n\n` +
          `Reply with a short plain-text explanation, then a fenced \`\`\`json block containing the updated spec: ` +
          `{"aggregates":[{"product_name","metrics":[{"key","label"}],"threshold":{"metric","op":">"|">="|"<"|"<=","value":number}?}]}. ` +
          `Only include products/metric keys from the list above.`;
        try {
          const content = await llmComplete(prompt, 1500);
          const spec = extractJsonObject(content ?? '');
          // strip the fenced json from the displayed answer
          const answer = (content ?? '').replace(/```(?:json)?[\s\S]*?```/g, '').trim() || 'Updated the monitoring spec below.';
          res.json({ answer, spec: spec ?? null, llm: true });
        } catch (err) {
          res.json({ answer: `The assistant hit an error: ${humanizeSqlError(err)}`, spec: null, llm: false });
        }
      });

      // Run the domain's aggregates now (on-demand) and store the results.
      app.post('/api/monitor-run', async (req, res) => {
        const b = (req.body ?? {}) as { domain?: string; trigger?: string };
        const trigger = b.trigger === 'scheduled' ? 'scheduled' : 'on_demand';
        try {
          const out = await runMonitorJob(String(b.domain ?? ''), trigger);
          res.json(out);
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // List recent run outputs for a domain (newest first).
      app.get('/api/monitor-runs', async (req, res) => {
        const domain = String(req.query.domain ?? '').trim();
        const limit = Math.min(Math.max(Number(req.query.limit ?? 60) || 60, 1), 500);
        if (!domain) {
          res.json({ runs: [] });
          return;
        }
        try {
          const rows = await lbQuery(
            `SELECT run_id, job_id, domain, to_char(run_ts, 'YYYY-MM-DD HH24:MI:SS') AS run_ts, ` +
              `to_char(run_date, 'YYYY-MM-DD') AS run_date, trigger, product, metrics_json, ` +
              `exception_total, status, error, llm_summary ` +
              `FROM jai_monitor_run WHERE domain = $1 ORDER BY run_ts DESC LIMIT ${limit}`,
            [domain]
          );
          res.json({ runs: rows });
        } catch (err) {
          res.json({ runs: [], error: humanizeSqlError(err) });
        }
      });

      // Preview the generated aggregate SQL per product (no execution).
      app.get('/api/monitor-preview', (req, res) => {
        const dom = monitorDomain(String(req.query.domain ?? ''));
        if (!dom) {
          res.json({ products: [] });
          return;
        }
        res.json({
          job_name: monitorJobName(dom.name),
          products: dom.products.map((p) => ({
            product_name: p.product_name,
            display_name: p.display_name,
            metric_keys: metricKeys(p.product_name),
            sql: demoAggregateSql(p.product_name),
          })),
        });
      });

      // ================= Ontology artifact (OWL/TTL + JSON-LD) =================
      const artifactId = (schema: string, product: string) => `${schema}:${product}`;
      // POST — client sends the assembled OntologyArtifact model; server serializes,
      // mirrors to the UC Volume (best-effort), and upserts the canonical row.
      app.post('/api/ontology-artifact', async (req, res) => {
        const b = (req.body ?? {}) as { schema_label?: string; product?: string; model?: OntologyArtifact };
        const schema = String(b.schema_label ?? '').trim();
        const product = String(b.product ?? '').trim();
        const model = b.model;
        if (!schema || !product || !model) {
          res.status(400).json({ ok: false, error: 'schema_label, product, model required' });
          return;
        }
        let ttl = '';
        let jsonld = '';
        try {
          ttl = serializeTtl(model);
          jsonld = JSON.stringify(serializeJsonLd(model), null, 2);
        } catch (e) {
          res.json({ ok: false, error: `serialize failed: ${String(e)}` });
          return;
        }
        const volPath = `${VOLUME_BASE}/${product}.ttl`;
        let volumeWarning: string | undefined;
        try {
          await volumePut(volPath, ttl);
          await volumePut(`${VOLUME_BASE}/${product}.jsonld`, jsonld);
        } catch (e) {
          volumeWarning = `volume mirror skipped: ${String(e).slice(0, 120)}`;
        }
        const counts = artifactCounts(model);
        try {
          const who = await whoami();
          await lbQuery(
            `INSERT INTO jai_ontology_artifact (artifact_id, schema_label, product, product_label, iri, ` +
              `ttl, jsonld, graph_json, model_json, volume_path, class_count, objprop_count, generated_by, generated_at) ` +
              `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now()) ` +
              `ON CONFLICT (artifact_id) DO UPDATE SET product_label=EXCLUDED.product_label, iri=EXCLUDED.iri, ` +
              `ttl=EXCLUDED.ttl, jsonld=EXCLUDED.jsonld, graph_json=EXCLUDED.graph_json, model_json=EXCLUDED.model_json, ` +
              `volume_path=EXCLUDED.volume_path, class_count=EXCLUDED.class_count, objprop_count=EXCLUDED.objprop_count, ` +
              `generated_by=EXCLUDED.generated_by, generated_at=now()`,
            [
              artifactId(schema, product),
              schema,
              product,
              String(model.productLabel ?? product),
              String(model.iri ?? ''),
              ttl,
              jsonld,
              JSON.stringify(model.graph ?? null),
              JSON.stringify(model),
              volPath,
              counts.class_count,
              counts.objprop_count,
              who,
            ]
          );
          res.json({ ok: true, artifact_id: artifactId(schema, product), volume_path: volPath, ttl_bytes: ttl.length, volume_warning: volumeWarning });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // GET — the stored artifact (viewer + export read this)
      app.get('/api/ontology-artifact', async (req, res) => {
        const schema = String(req.query.schema ?? '').trim();
        const product = String(req.query.product ?? '').trim();
        if (!schema || !product) {
          res.json({ artifact: null });
          return;
        }
        try {
          const rows = await lbQuery(
            `SELECT artifact_id, schema_label, product, product_label, iri, graph_json, model_json, ` +
              `volume_path, class_count, objprop_count, generated_by, ` +
              `to_char(generated_at, 'YYYY-MM-DD HH24:MI:SS') AS generated_at ` +
              `FROM jai_ontology_artifact WHERE artifact_id = $1 LIMIT 1`,
            [artifactId(schema, product)]
          );
          res.json({ artifact: rows[0] ?? null });
        } catch (err) {
          res.json({ artifact: null, error: humanizeSqlError(err) });
        }
      });

      // GET download — stream the stored TTL or JSON-LD as an attachment
      app.get('/api/ontology-artifact/download', async (req, res) => {
        const schema = String(req.query.schema ?? '').trim();
        const product = String(req.query.product ?? '').trim();
        const format = String(req.query.format ?? 'ttl') === 'jsonld' ? 'jsonld' : 'ttl';
        try {
          const rows = await lbQuery<{ ttl: string; jsonld: string }>(
            `SELECT ttl, jsonld FROM jai_ontology_artifact WHERE artifact_id = $1 LIMIT 1`,
            [artifactId(schema, product)]
          );
          if (rows.length === 0) {
            res.status(404).json({ error: 'artifact not found — generate it first' });
            return;
          }
          const body = format === 'jsonld' ? rows[0].jsonld : rows[0].ttl;
          res.setHeader('Content-Type', format === 'jsonld' ? 'application/ld+json' : 'text/turtle');
          res.setHeader('Content-Disposition', `attachment; filename="${product}.${format}"`);
          res.send(body ?? '');
        } catch (err) {
          res.status(200).json({ error: humanizeSqlError(err) });
        }
      });

      // ================= Governed serving-view live check =================
      app.get('/api/serving-view-check', async (req, res) => {
        const object = String(req.query.object ?? '').trim();
        const m = object.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);
        if (!m) {
          res.json({ present: false, error: 'need a 3-part catalog.schema.view name' });
          return;
        }
        const [, cat, sch, view] = m;
        try {
          const rows = await runSql(
            `SELECT count(*) AS n FROM ${cat}.information_schema.tables WHERE table_schema='${sch}' AND table_name='${view}'`
          );
          const n = Number(rows[0]?.n ?? rows[0]?.N ?? 0) || 0;
          res.json({ present: n > 0, object });
        } catch (e) {
          // permission/other error → "cannot verify", not "absent"
          res.json({ present: false, object, error: humanizeSqlError(e) });
        }
      });

      // ================= Business / reasoning rules =================
      app.get('/api/business-rules', async (req, res) => {
        const domain = String(req.query.domain ?? '').trim();
        if (!domain) {
          res.json({ rules: [] });
          return;
        }
        try {
          const rows = await lbQuery(
            `SELECT rule_id, domain, name, if_conditions, then_conclusion, concepts, evidence, eval_sql, eval_table, enabled, origin ` +
              `FROM jai_business_rules WHERE domain = $1 ORDER BY rule_id`,
            [domain]
          );
          res.json({ rules: rows });
        } catch (err) {
          res.json({ rules: [], error: humanizeSqlError(err) });
        }
      });
      app.post('/api/business-rule', async (req, res) => {
        const b = (req.body ?? {}) as {
          rule_id?: string; domain?: string; name?: string; if_conditions?: unknown;
          then_conclusion?: string; concepts?: unknown; evidence?: string; eval_sql?: string; eval_table?: string; enabled?: boolean;
        };
        const domain = String(b.domain ?? '').trim();
        if (!domain || !b.name) {
          res.status(400).json({ ok: false, error: 'domain and name required' });
          return;
        }
        const ruleId = String(b.rule_id ?? '').trim() || `rr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        const asJson = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? []));
        try {
          const who = await whoami();
          await lbQuery(
            `INSERT INTO jai_business_rules (rule_id, domain, name, if_conditions, then_conclusion, concepts, evidence, ` +
              `eval_sql, eval_table, enabled, origin, created_by, created_at, updated_at) ` +
              `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user',$11, now(), now()) ` +
              `ON CONFLICT (rule_id) DO UPDATE SET name=EXCLUDED.name, if_conditions=EXCLUDED.if_conditions, ` +
              `then_conclusion=EXCLUDED.then_conclusion, concepts=EXCLUDED.concepts, evidence=EXCLUDED.evidence, ` +
              `eval_sql=EXCLUDED.eval_sql, eval_table=EXCLUDED.eval_table, enabled=EXCLUDED.enabled, updated_at=now()`,
            [ruleId, domain, String(b.name), asJson(b.if_conditions), String(b.then_conclusion ?? ''),
             asJson(b.concepts), String(b.evidence ?? ''), b.eval_sql ? String(b.eval_sql) : null,
             b.eval_table ? String(b.eval_table) : null, b.enabled === false ? false : true, who]
          );
          res.json({ ok: true, rule_id: ruleId });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });
      app.post('/api/delete-business-rule', async (req, res) => {
        const id = String((req.body as { rule_id?: string })?.rule_id ?? '').trim();
        if (!id) {
          res.status(400).json({ ok: false, error: 'rule_id required' });
          return;
        }
        try {
          await lbQuery(`DELETE FROM jai_business_rules WHERE rule_id = $1`, [id]);
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });
      // Evaluate a rule's IF-condition against its backing table (prescriptive tie-in)
      app.post('/api/evaluate-business-rule', async (req, res) => {
        const b = (req.body ?? {}) as { eval_table?: string; eval_sql?: string };
        const table = String(b.eval_table ?? '').trim();
        const where = String(b.eval_sql ?? '').trim();
        if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){1,2}$/.test(table) || !where) {
          res.json({ ok: false, error: 'need eval_table (qualified) and eval_sql (WHERE predicate)' });
          return;
        }
        // reject mutating / multi-statement predicates
        if (/;|\b(insert|update|delete|drop|create|alter|merge|grant|truncate)\b/i.test(where)) {
          res.json({ ok: false, error: 'eval_sql must be a read-only WHERE predicate' });
          return;
        }
        try {
          const rows = await runSql(`SELECT count(*) AS matches FROM ${table} WHERE ${where}`);
          res.json({ ok: true, matches: Number(rows[0]?.matches ?? 0) || 0 });
        } catch (e) {
          res.json({ ok: false, error: humanizeSqlError(e) });
        }
      });

      // ================= Action Center: full exception rows (drill-through) =====
      app.post('/api/exception-rows', async (req, res) => {
        const b = (req.body ?? {}) as { product?: string; limit?: number };
        const product = String(b.product ?? '').trim();
        const limit = Math.min(Math.max(Number(b.limit ?? 200) || 200, 1), 1000);
        const sql = demoExceptionSql(product, limit);
        const aggregate = demoAggregateSql(product);
        if (!sql) {
          res.status(400).json({ rows: [], error: 'not a data-backed product' });
          return;
        }
        try {
          const rows = await runSql(sql);
          res.json({ rows, sql, aggregate_sql: aggregate, count: rows.length });
        } catch (e) {
          res.json({ rows: [], sql, error: humanizeSqlError(e) });
        }
      });
    });
  },
}).catch(console.error);

// parse a JSON array from possibly-fenced model output
function extractJsonArray(text: string): Record<string, unknown>[] | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// parse a single JSON object (e.g. a proposed action) from fenced model output
function extractJsonObject(text: string): Record<string, string> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!fenced) return null;
  try {
    const obj = JSON.parse(fenced[1].trim());
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function humanizeSqlError(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err);
  if (/permission|access|denied|not authorized|PERMISSION_DENIED|forbidden/i.test(msg)) {
    return 'No access — the app service principal lacks permission on this catalog/schema.';
  }
  // Spark leaves unresolved tables as `'UnresolvedRelation [schema, table]` in the
  // (parsed) plan — surface the missing table + why, instead of the raw plan tree.
  const unresolved = msg.match(/UnresolvedRelation\s*\[([^\]]+)\]/i);
  if (unresolved) {
    const table = unresolved[1].split(',').map((s) => s.trim()).filter(Boolean).join('.');
    return `Table \`${table}\` not found in the connected warehouse. Its catalog isn't qualified (or the schema isn't physically present here), so the view can't be verified against live data.`;
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
