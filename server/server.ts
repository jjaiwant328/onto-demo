import { createApp, analytics, server, serving, getWorkspaceClient } from '@databricks/appkit';
import { randomUUID } from 'node:crypto';
import {
  demoExceptionSql,
  demoAggregateSql,
  demoSnapshotSql,
  isDemoProduct,
  DEMO_PRODUCTS,
} from '../shared/demoDomains';

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
    const sqlStr = (v: unknown): string => `'${String(v ?? '').replace(/'/g, "''")}'`;

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
    const SAVED_TABLE = 'jai_ontos.demo_schema.jai_saved_schemas';
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

    appkit.server.extend((app) => {
      // Tells the client whether the LLM-polish path is available.
      app.get('/api/llm-status', (_req, res) => {
        res.json({ available: hasLlm });
      });

      // ---- durable schema store: Volume = content, Delta = index ----
      const INLINE_MAX = 150 * 1024; // inline schema_json in Delta only if small

      // Save a schema: raw JSON → volume; metadata row → Delta.
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

          // 3) index row in Delta (inline JSON only if small)
          const inline = json.length <= INLINE_MAX ? sqlStr(json) : 'NULL';
          await runSql(
            `INSERT INTO ${SAVED_TABLE} ` +
              `(schema_id, customer, schema_name, source, catalog_ref, table_count, created_by, created_at, volume_path, schema_json) ` +
              `VALUES (${sqlStr(schemaId)}, ${sqlStr(customer)}, ${sqlStr(schemaName)}, ${sqlStr(
                b.source ?? 'upload'
              )}, ${sqlStr(b.catalogRef ?? '')}, ${tableCount}, ${sqlStr(createdBy)}, current_timestamp(), ${sqlStr(volPath)}, ${inline})`
          );
          res.json({ ok: true, schema_id: schemaId, volume_path: volPath, table_count: tableCount });
        } catch (err) {
          res.json({ ok: false, error: humanizeSqlError(err) });
        }
      });

      // List saved-schema metadata (no blob).
      app.get('/api/saved-schemas', async (_req, res) => {
        try {
          const rows = await runSql(
            `SELECT schema_id, customer, schema_name, source, catalog_ref, table_count, created_by, ` +
              `cast(created_at as string) as created_at, volume_path FROM ${SAVED_TABLE} ORDER BY created_at DESC`
          );
          res.json({ schemas: rows });
        } catch (err) {
          res.status(200).json({ schemas: [], error: humanizeSqlError(err) });
        }
      });

      // Fetch a saved schema's full content (volume file, or inline schema_json).
      app.get('/api/saved-schema/:id', async (req, res) => {
        const id = safeIdent(String(req.params.id));
        try {
          const rows = await runSql(
            `SELECT volume_path, schema_json FROM ${SAVED_TABLE} WHERE schema_id = ${sqlStr(id)} LIMIT 1`
          );
          if (rows.length === 0) {
            res.status(404).json({ error: 'not found' });
            return;
          }
          const inlineJson = rows[0].schema_json;
          if (inlineJson != null && inlineJson !== '') {
            // analytics may return the column already-parsed (object) or as a string
            const parsed =
              typeof inlineJson === 'string' ? JSON.parse(inlineJson) : inlineJson;
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
              res.json({ schema: parsed });
              return;
            }
          }
          const volPath = String(rows[0].volume_path ?? '');
          const dl = await volumeGet(volPath);
          if (!dl.ok) {
            res.json({ error: `Volume read failed (${dl.status})` });
            return;
          }
          res.json({ schema: JSON.parse(await dl.text()) });
        } catch (err) {
          res.status(200).json({ error: humanizeSqlError(err) });
        }
      });

      // Delete a saved schema (Delta row + volume file).
      app.post('/api/delete-saved-schema', async (req, res) => {
        const id = safeIdent(String((req.body ?? {}).schema_id ?? ''));
        if (!id) {
          res.status(400).json({ error: 'schema_id required' });
          return;
        }
        try {
          const rows = await runSql(
            `SELECT volume_path FROM ${SAVED_TABLE} WHERE schema_id = ${sqlStr(id)} LIMIT 1`
          );
          const volPath = rows[0]?.volume_path ? String(rows[0].volume_path) : '';
          await runSql(`DELETE FROM ${SAVED_TABLE} WHERE schema_id = ${sqlStr(id)}`);
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
        if (!hasLlm) {
          // deterministic fallback: ONE aggregate action from the config framing
          res.json({
            actions: [
              {
                id: `dx-${product}-agg`,
                priority: 'HIGH',
                issue: `${total} exception(s) — ${meta.issue}`,
                root_cause: 'Aggregate of data-backed exception rows.',
                recommended_action: meta.action_hint,
                confidence: 0.6,
                stats,
              },
            ],
            rows,
            stats,
            llm: false,
          });
          return;
        }
        const prompt =
          `You are an ops analyst for the data product "${meta.display_name}" ` +
          `(domain: ${meta.domainLabel}). Below are AGGREGATE stats over the real exception rows ` +
          `(${meta.issue}) plus a few representative examples. Produce a SHORT list of 3-5 HIGH-LEVEL ` +
          `AGGREGATE actions (NOT one per row) — each should summarize a group with its counts, e.g. ` +
          `"12 DQ tests failing (4 critical) across 5 tables — triage critical failures". Return ONLY a ` +
          `JSON array; each item: {id, priority ("HIGH"|"MEDIUM"|"LOW"), issue, root_cause, ` +
          `recommended_action, confidence (0..1)}. Put the concrete counts in "issue". Bucket priority ` +
          `by severity/impact. Keep root_cause and recommended_action to one sentence each. A good ` +
          `action looks like: ${meta.action_hint}\n\nAGGREGATE STATS:\n${JSON.stringify(stats)}\n\n` +
          `REPRESENTATIVE ROWS:\n${JSON.stringify(rows).slice(0, 12000)}`;
        const content = await llmComplete(prompt, 2000);
        const json = extractJsonArray(content ?? '');
        if (json) {
          res.json({ actions: json.slice(0, 6), rows, stats, llm: true, product });
          return;
        }
        res.json({ actions: [], rows, stats, llm: false, reason: 'model returned no usable JSON' });
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
        const prompt =
          `You are the Ontology Copilot for a governed data-product app. Answer the user's question ` +
          `GROUNDED ONLY in the product context (ontology classes, measures/KPIs + formulas, ` +
          `relationships) and any live snapshot provided — do not invent tables, columns, or numbers. ` +
          `Be concise (2-5 sentences). If the user is asking to DO something operational (e.g. fix a ` +
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

      // ---- Feature 3: action log / tracker (persisted to jai_action_log) ----
      const ACTION_LOG_TABLE = 'jai_ontos.demo_schema.jai_action_log';
      const whoami = async (): Promise<string> => {
        try {
          const me = await authFetch('/api/2.0/preview/scim/v2/Me', { method: 'GET' });
          if (me.ok) return ((await me.json()) as { userName?: string })?.userName ?? 'unknown';
        } catch {
          /* ignore */
        }
        return 'unknown';
      };

      // POST /api/log-action — insert a decided action into the log.
      app.post('/api/log-action', async (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const decision = String(b.decision ?? '');
        if (!['approved', 'modified', 'rejected'].includes(decision)) {
          res.status(400).json({ ok: false, error: 'decision must be approved|modified|rejected' });
          return;
        }
        const decidedBy = await whoami();
        const actionId = `act_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        const conf = typeof b.confidence === 'number' ? (b.confidence as number) : Number(b.confidence) || 0;
        try {
          await runSql(
            `INSERT INTO ${ACTION_LOG_TABLE} ` +
              `(action_id, created_at, updated_at, schema_label, domain, product, source, priority, ` +
              `issue, root_cause, recommended_action, confidence, decision, track_status, decided_by, ` +
              `decided_at, ref_entity, notes) VALUES (` +
              `${sqlStr(actionId)}, current_timestamp(), current_timestamp(), ` +
              `${sqlStr(b.schema_label)}, ${sqlStr(b.domain)}, ${sqlStr(b.product)}, ${sqlStr(b.source)}, ` +
              `${sqlStr(b.priority)}, ${sqlStr(b.issue)}, ${sqlStr(b.root_cause)}, ` +
              `${sqlStr(b.recommended_action)}, ${conf}, ${sqlStr(decision)}, 'open', ` +
              `${sqlStr(decidedBy)}, current_timestamp(), ${sqlStr(b.ref_entity)}, ${sqlStr(b.notes)})`
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
        if (product) where.push(`product = ${sqlStr(product)}`);
        if (status) where.push(`track_status = ${sqlStr(status)}`);
        const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        try {
          const rows = await runSql(
            `SELECT action_id, cast(created_at as string) AS created_at, ` +
              `cast(updated_at as string) AS updated_at, schema_label, domain, product, source, ` +
              `priority, issue, root_cause, recommended_action, confidence, decision, track_status, ` +
              `decided_by, cast(decided_at as string) AS decided_at, ref_entity, notes ` +
              `FROM ${ACTION_LOG_TABLE}${clause} ORDER BY created_at DESC LIMIT 500`
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
          await runSql(
            `UPDATE ${ACTION_LOG_TABLE} SET track_status = ${sqlStr(st)}, ` +
              `updated_at = current_timestamp() WHERE action_id = ${sqlStr(id)}`
          );
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // ---- Feature 4: product links (Genie Space / AI-BI dashboard) ----
      const PRODUCT_LINKS_TABLE = 'jai_ontos.demo_schema.jai_product_links';

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
          await runSql(
            `INSERT INTO ${PRODUCT_LINKS_TABLE} ` +
              `(link_id, schema_label, domain, product, link_type, url, label, created_by, created_at) VALUES (` +
              `${sqlStr(linkId)}, ${sqlStr(b.schema_label)}, ${sqlStr(b.domain)}, ${sqlStr(b.product)}, ` +
              `${sqlStr(linkType)}, ${sqlStr(url)}, ${sqlStr(b.label)}, ${sqlStr(createdBy)}, current_timestamp())`
          );
          res.json({ ok: true, link_id: linkId, created_by: createdBy });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
        }
      });

      // GET /api/product-links — list links (optional ?product=).
      app.get('/api/product-links', async (req, res) => {
        const product = (req.query.product as string | undefined)?.trim();
        const clause = product ? ` WHERE product = ${sqlStr(product)}` : '';
        try {
          const rows = await runSql(
            `SELECT link_id, schema_label, domain, product, link_type, url, label, created_by, ` +
              `cast(created_at as string) AS created_at FROM ${PRODUCT_LINKS_TABLE}${clause} ` +
              `ORDER BY created_at DESC LIMIT 500`
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
          await runSql(`DELETE FROM ${PRODUCT_LINKS_TABLE} WHERE link_id = ${sqlStr(id)}`);
          res.json({ ok: true });
        } catch (err) {
          res.json({ ok: false, error: String(err) });
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
