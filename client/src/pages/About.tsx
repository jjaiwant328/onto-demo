// About — how a schema becomes Domains, Data Products and Data Contracts.
//
// Written for a business / governance reader, not an engineer. The goal is that
// nobody has to guess which parts of the catalog are facts about their data and
// which are guesses: each step says plainly what is READ vs INFERRED, and the
// badge legend at the bottom is the key for the badges used across the app.
//
// IMPORTANT: this page documents real behaviour. If the derivation rules in
// catalogGen.ts / deriveComponents.ts / contract.ts change, this copy must change
// with them — the caps and domain names below are imported from the source of
// truth so at least those cannot drift silently.
import { Link } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
} from '@databricks/appkit-ui/react';
import {
  Info,
  Database,
  Layers,
  Package,
  FileText,
  Sparkles,
  ShieldAlert,
  ArrowRight,
} from 'lucide-react';
import {
  DOMAIN_LABELS,
  MAX_PRODUCTS_PER_DOMAIN,
  MAX_KPIS_PER_PRODUCT,
} from '../lib/catalogGen';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { PROVENANCE_ORDER, provenanceMeaning } from '../lib/provenance';

// The Foundation Model endpoint the app is wired to (databricks.yml → app.yaml →
// DATABRICKS_SERVING_ENDPOINT_NAME). Shown so users know what is answering.
const MODEL_ENDPOINT = 'databricks-claude-sonnet-4-5';

function Step({
  n,
  icon: Icon,
  title,
  reads,
  infers,
  children,
  to,
  toLabel,
}: {
  n: number;
  icon: typeof Database;
  title: string;
  /** what this step takes as fact */
  reads: string;
  /** what this step guesses — null when the step infers nothing */
  infers: string | null;
  children: React.ReactNode;
  to?: string;
  toLabel?: string;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {n}
          </span>
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="text-muted-foreground">{children}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border bg-muted/30 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <ProvenanceBadge origin="observed" showIcon={false} /> Read from your data
            </div>
            <div className="text-xs text-muted-foreground">{reads}</div>
          </div>
          <div className="rounded-md border bg-muted/30 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <ProvenanceBadge origin="heuristic" showIcon={false} /> Guessed by the app
            </div>
            <div className="text-xs text-muted-foreground">
              {infers ?? 'Nothing — this step makes no guesses.'}
            </div>
          </div>
        </div>
        {to && (
          <Link
            to={to}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {toLabel} <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

export function About() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">About this app</h2>
        <p className="text-muted-foreground">
          How your schema becomes domains, data products and data contracts — and which parts are
          facts vs. proposals.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          You give this app a <span className="font-medium">schema</span> — a list of tables and
          columns. It proposes a <span className="font-medium">domain map</span>, a set of{' '}
          <span className="font-medium">data products</span>, and a{' '}
          <span className="font-medium">draft contract</span> for each. Treat the result as a{' '}
          <span className="font-medium">starting point for curation, not an authoritative catalog</span>
          : most of it is inferred from naming conventions, and a domain expert should correct it.
          Everything is editable in{' '}
          <Link to="/ontology-studio" className="font-medium text-primary hover:underline">
            Ontology Studio
          </Link>
          .
        </span>
      </div>

      <Step
        n={1}
        icon={Database}
        title="Read your schema"
        reads="Table names, column names, data types, and any column comments."
        infers={null}
        to="/data-products"
        toLabel="See the catalog"
      >
        You either upload a <code className="text-xs">describe_table_extended</code> CSV export or
        connect to a live catalog and introspect it. Only <span className="font-medium">metadata</span>{' '}
        is read at this stage — never the values inside your tables. This is the one step that is
        pure fact; everything after it involves judgement.
      </Step>

      <Step
        n={2}
        icon={Layers}
        title="Group tables into Domains"
        reads="The table's name, and which source schema it came from."
        infers="Which business domain a table belongs to — matched on keywords in the table name."
        to="/ontology-studio"
        toLabel="Rename, merge or move domains"
      >
        Each table is matched against {DOMAIN_LABELS.length} business domains —{' '}
        {DOMAIN_LABELS.join(', ')} — using <span className="font-medium">keywords in its name</span>,
        and the app tells you how sure it is. Several matching keywords is a{' '}
        <span className="font-medium">strong</span> match; a single, possibly coincidental hit is
        flagged <Badge variant="outline">weak match</Badge>, and tables that match nothing are put in
        an <Badge variant="outline">unclassified</Badge> group named after their source schema rather
        than being quietly filed under a business domain. Where a table matched more than one domain,
        the runners-up are listed so you can reassign it.
        <br />
        <br />
        <span className="font-medium">
          Be aware: this keyword list was written for convenience retail.
        </span>{' '}
        If your data is from another industry, expect more weak and unclassified groups — that is the
        app being honest rather than guessing, and renaming or merging domains in Ontology Studio is
        the intended next step.
      </Step>

      <Step
        n={3}
        icon={Package}
        title="Propose Data Products"
        reads="Which columns are numeric, and which column names look like keys or dates."
        infers="Which tables are 'facts' worth building a product on, which dimensions belong to them, and which measures are the headline KPIs."
        to="/data-products"
        toLabel="Browse data products"
      >
        A table becomes a <span className="font-medium">fact</span> — the anchor of a data product —
        when it has a number to measure, a key to join on, and a date to trend by. Dimension tables
        attach to it when they <span className="font-medium">share a key column name</span>. The
        first {MAX_KPIS_PER_PRODUCT} numeric measures become the headline KPIs, and each domain
        carries at most {MAX_PRODUCTS_PER_DOMAIN} products. A product is a{' '}
        <span className="font-medium">proposal</span> until a governed serving view actually exists —
        until then it is labelled <Badge variant="outline">schema-derived</Badge>.
      </Step>

      <Step
        n={4}
        icon={FileText}
        title="Draft a Data Contract"
        reads="The product's real columns and types, and its source tables for lineage."
        infers="The grain (one row per what?), candidate quality checks, and a freshness target."
        to="/data-contract"
        toLabel="View a data contract"
      >
        The contract is the governance handshake for a product: its serving object, its{' '}
        <span className="font-medium">grain</span>, its schema, quality checks, a freshness SLA, and
        lineage. For derived products the serving object is marked{' '}
        <span className="font-medium">planned</span> — it does not exist yet — and the quality checks
        are <span className="font-medium">candidate rules for the data owner to confirm</span>, not
        checks that have been run. The suggested target namespace is derived from your own source
        catalog, so the generated DDL never points at someone else&apos;s. Where the app spots
        column names that look like personal data, it flags them for you to confirm — it does{' '}
        <span className="font-medium">not</span> claim to have found or excluded PII on its own.
      </Step>

      <Card className="border-primary/30 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" /> Where AI is used — and where it isn&apos;t
          </CardTitle>
          <CardDescription>
            Every step above runs deterministically first. The model only ever refines the result.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-2">
            {[
              {
                step: 'Reading your schema',
                ai: 'No AI',
                detail: 'Parsing only. Fully deterministic.',
              },
              {
                step: 'Domains & data products',
                ai: 'Optional polish',
                detail:
                  'Rules produce the draft. The model may then improve domain names, product descriptions and KPI choices — it is instructed not to invent tables or columns, and any table it names that is not in your schema is discarded.',
              },
              {
                step: 'Data contracts',
                ai: 'No AI',
                detail: 'Derived from the product’s real columns by rule.',
              },
              {
                step: 'Domain Analysis (use cases & ROI)',
                ai: 'AI-authored',
                detail:
                  'The model writes these. Revenue figures are illustrative industry benchmarks for the use-case type — they are NOT computed from your data.',
              },
            ].map((r) => (
              <div key={r.step} className="rounded-md border p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{r.step}</span>
                  <Badge variant={r.ai === 'No AI' ? 'secondary' : 'outline'} className="text-[10px]">
                    {r.ai}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{r.detail}</div>
              </div>
            ))}
          </div>
          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            The model in use is <code className="text-xs">{MODEL_ENDPOINT}</code>, served from your
            own workspace — your schema is not sent to a third party. It is configurable by pointing
            the app at a different serving endpoint. Every AI step has a{' '}
            <span className="font-medium">deterministic fallback</span>: if the model is unavailable
            or returns something unusable, the app quietly falls back to the rule-based result rather
            than failing.
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">What the badges mean</CardTitle>
          <CardDescription>
            These appear throughout the app. Hover any badge to see the specific reason behind that
            claim.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {PROVENANCE_ORDER.map((o) => (
              <div key={o} className="flex items-start gap-2.5">
                <div className="w-28 shrink-0">
                  <ProvenanceBadge origin={o} />
                </div>
                <div className="text-xs text-muted-foreground">{provenanceMeaning(o)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-amber-300 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-600" /> Trust &amp; limits
          </CardTitle>
          <CardDescription>What this pipeline cannot know from a schema alone.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Meaning beyond names.</span> Two columns
              called <code className="text-xs">store_id</code> may refer to different things; one
              called <code className="text-xs">rev</code> may or may not be revenue.
            </li>
            <li>
              <span className="font-medium text-foreground">Real keys and joins.</span> Relationships
              here are inferred from matching column names, not from declared primary or foreign key
              constraints. Validate them in Ontology Studio to measure whether the join actually
              holds.
            </li>
            <li>
              <span className="font-medium text-foreground">Business importance.</span> The app cannot
              tell which tables matter to your business, who owns them, or which are deprecated.
            </li>
            <li>
              <span className="font-medium text-foreground">Whether a KPI is correct.</span> A KPI
              name that does not match a real column is flagged as unverified — it needs a definition
              from someone who knows the business before it can be computed.
            </li>
            <li>
              <span className="font-medium text-foreground">Your industry.</span> The domain keywords
              and key-name patterns were written for convenience retail. Nothing curated for the
              built-in demo is ever applied to your schema — a bundled KPI formula is only used when
              every column it needs exists in your data, and the demo&apos;s serving views, lineage
              and catalog names are never attached to an uploaded schema. The cost of that safety is
              more <Badge variant="outline">weak match</Badge> and{' '}
              <Badge variant="outline">unverified</Badge> labels on a non-retail estate. That is
              deliberate: an honest gap is more useful than a confident guess.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
