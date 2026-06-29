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
    appkit.server.extend((app) => {
      // Tells the client whether the LLM-polish path is available.
      app.get('/api/llm-status', (_req, res) => {
        res.json({ available: hasLlm });
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
