// Client for the deployed ontobricks app (ontology materialization + graph
// queries). This is the whole surface the server wires into its endpoints;
// everything else about ontobricks stays out of this repo.
//
// The wire shape follows the ontobricks source and docs (github.com/
// databrickslabs/ontobricks, master branch — docs/api.md § GraphQL API and
// src/back/fastapi/graphql_routes.py + src/back/core/graphql/{GraphQLSchema
// Builder,SchemaMetadata,ResolverFactory}.py):
//   - GET  /api/v1/graphql/{domain}/schema — the domain's auto-generated
//     GraphQL SDL. Ontology classes become types (each carrying id / uri /
//     label, where `uri` is the node's full IRI); object properties become
//     relationship fields `[TargetType]`; data properties become scalars.
//   - POST /api/v1/graphql/{domain} — execute a query. Body is
//     { query, variables, operationName?, depth }, with depth clamped
//     server-side to 1..5. Errors (including GraphQL execution errors) come
//     back as HTTP 400 with an `errors` array.
//   - Single-entity root resolvers exist per type (`customer(id: ...)`); the
//     id is matched against the TRAILING fragment of subject URIs, so a full
//     IRI must be cut down before it can be used as one.
//
// `fetchNeighbors(domain, iri, hops)` therefore makes three calls: fetch the
// SDL (to learn each type's relationship fields — cached per domain), probe
// every type's root resolver with the origin's id fragment (to learn which
// type the origin IRI belongs to), then post a nested expansion query to
// `hops` levels (clamped to 1..3; the API itself supports up to 5) and map the
// response onto GraphNeighbor[].
//
// Errors are humanized the way shared/stateError.ts humanizes app-state
// failures: status + a short response snippet, never raw fetch internals.
import type { GraphNeighbor, OntobricksClientConfig } from '../shared/ontobricksTypes';

export interface OntobricksClient {
  fetchNeighbors(domain: string, iri: string, hops: number): Promise<GraphNeighbor[]>;
}

// plan cap for RT_onto; the API itself would allow up to 5
const MAX_HOPS = 3;
const BODY_SNIPPET_LIMIT = 200;

// One object property of the ontology, as the SDL exposes it: a field on
// `typeName` whose values are `[TargetType]`.
interface TypeRelationship {
  field: string;
  target: string;
}
type SdlTypes = Map<string, TypeRelationship[]>;

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

// Record view of a non-null object value, else null.
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// The single-entity root field for a type: the server builds it as the type
// name with its first character lower-cased (GraphQLSchemaBuilder._build_query).
function rootFieldOf(typeName: string): string {
  return typeName.charAt(0).toLowerCase() + typeName.slice(1);
}

// The single-entity resolver matches `subject LIKE '%/{id}' OR '%#{id}'`, i.e.
// the id is a trailing fragment of the subject URI. A full IRI therefore has
// to be cut down: after the last '#' for hash namespaces (the fragment may
// itself contain '/'), else after the last '/'.
function idFragmentOf(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf('/');
  return slash >= 0 ? iri.slice(slash + 1) : iri;
}

const TYPE_LINE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
// field(args?): [TargetType!]! | TargetType | Scalar
const FIELD_LINE = /^([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?:\s*(.+)$/;

// Parse the SDL into type -> relationship fields. A field is a relationship
// when its (unwrapped, non-null-stripped) type names another declared type;
// everything else (uri/label/data properties) is a scalar and not traversable.
// The generated SDL is machine-printed (strawberry), so a line-oriented parse
// is safe; docstring description lines are skipped.
function parseSdl(sdl: string): SdlTypes {
  const declared = new Set<string>();
  const fieldsByType = new Map<string, Array<{ field: string; typeRef: string }>>();
  let current: string | null = null;
  let inDescription = false;
  for (const rawLine of sdl.split('\n')) {
    const line = rawLine.trim();
    if (line.includes('"""')) {
      // open-and-close on one line leaves `inDescription` unchanged
      if (line.split('"""').length % 2 === 0) continue;
      inDescription = !inDescription;
      continue;
    }
    if (inDescription || line === '') continue;
    const typeMatch = TYPE_LINE.exec(line);
    if (typeMatch) {
      current = typeMatch[1];
      declared.add(current);
      fieldsByType.set(current, []);
      continue;
    }
    if (line === '}') {
      current = null;
      continue;
    }
    if (!current) continue;
    const fieldMatch = FIELD_LINE.exec(line);
    if (fieldMatch) {
      fieldsByType.get(current)?.push({ field: fieldMatch[1], typeRef: fieldMatch[3] });
    }
  }
  const types: SdlTypes = new Map();
  for (const [name, fields] of fieldsByType) {
    if (name === 'Query') continue; // root resolvers, not a data type
    const rels: TypeRelationship[] = [];
    for (const { field, typeRef } of fields) {
      const target = typeRef.replace(/[[\]!]/g, '');
      if (declared.has(target)) rels.push({ field, target });
    }
    types.set(name, rels);
  }
  return types;
}

// Ask every type's single-entity resolver for the origin at once; exactly the
// type owning the subject URI answers (its resolver returns the node, the
// others null).
function buildProbeQuery(types: SdlTypes): string {
  const roots = [...types.keys()].map((t) => `${rootFieldOf(t)}(id: $frag) { uri }`);
  return `query Origin($frag: ID!) { ${roots.join(' ')} }`;
}

// Nested expansion: the origin block at level 1, neighbors at levels 2..hops+1.
// Relationship fields are selected while level <= hops; the request body
// carries depth = hops so the server resolves the same number of levels.
function buildBlock(typeName: string, types: SdlTypes, level: number, hops: number): string {
  const fields = ['uri', 'label', '__typename'];
  if (level <= hops) {
    for (const rel of types.get(typeName) ?? []) {
      fields.push(`${rel.field} { ${buildBlock(rel.target, types, level + 1, hops)} }`);
    }
  }
  return fields.join(' ');
}

function buildExpansionQuery(originType: string, types: SdlTypes, hops: number): string {
  const root = rootFieldOf(originType);
  return `query Neighbors($frag: ID!) { ${root}(id: $frag) { ${buildBlock(originType, types, 1, hops)} } }`;
}

export function createOntobricksClient(cfg: OntobricksClientConfig): OntobricksClient {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const fetchImpl = cfg.fetchImpl ?? fetch;
  // domain -> relationship map, so repeated expansions skip the schema call
  const sdlCache = new Map<string, SdlTypes>();

  // Auth headers for the external API. The workspace host is resolved at call
  // time (config first, then DATABRICKS_HOST) so a rotated env var is always
  // current for a lazily-built client.
  function headers(): Record<string, string> {
    const rawHost = cfg.databricksHost ?? process.env.DATABRICKS_HOST ?? '';
    const host = rawHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'X-Databricks-Token': cfg.token,
    };
    if (host) h['X-Databricks-Host'] = host;
    return h;
  }

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new Error(
        `could not reach the ontobricks app at ${base} (${String((err as { message?: string })?.message ?? err)})`
      );
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail = typeof parsed === 'string' ? parsed : parsed === null ? '' : JSON.stringify(parsed);
      const snippet = detail.slice(0, BODY_SNIPPET_LIMIT);
      throw new Error(
        `ontobricks rejected ${method} ${path} with status ${res.status}` +
          (snippet ? ` — ${snippet}` : ' (empty response body)')
      );
    }
    return parsed;
  }

  async function loadTypes(domain: string): Promise<SdlTypes> {
    const cached = sdlCache.get(domain);
    if (cached) return cached;
    const body = await request('GET', `/api/v1/graphql/${encodeURIComponent(domain)}/schema`);
    const sdl = firstString(body, ['sdl']);
    if (!sdl) {
      const reason = firstString(body, ['message']) ?? 'its ontology may not be materialized';
      throw new Error(`ontobricks has no GraphQL schema for domain '${domain}' yet (${reason})`);
    }
    const types = parseSdl(sdl);
    if (types.size === 0) {
      throw new Error(`ontobricks returned an empty GraphQL schema for domain '${domain}'`);
    }
    sdlCache.set(domain, types);
    return types;
  }

  // Find which type the origin IRI belongs to. The probe answers with the
  // origin's full subject URI, which — when the caller passed a full IRI —
  // disambiguates fragment matches across types.
  async function probeOriginType(
    domain: string,
    types: SdlTypes,
    frag: string,
    iri: string
  ): Promise<{ typeName: string; uri: string } | null> {
    const body = await request('POST', `/api/v1/graphql/${encodeURIComponent(domain)}`, {
      query: buildProbeQuery(types),
      variables: { frag },
      depth: 1,
    });
    const data = recordOf(recordOf(body)?.['data']);
    if (!data) return null;
    // response keys are the root FIELD names — map each back to its type
    const rootToType = new Map([...types.keys()].map((t) => [rootFieldOf(t), t]));
    let fallback: { typeName: string; uri: string } | null = null;
    for (const [field, value] of Object.entries(data)) {
      const typeName = rootToType.get(field);
      if (!typeName) continue;
      const uri = firstString(value, ['uri']);
      if (uri === undefined) continue;
      if (uri === iri) return { typeName, uri };
      fallback ??= { typeName, uri };
    }
    return fallback;
  }

  // Walk the nested expansion response. Every traversal edge (node -field->
  // target) yields an entry: an `out` entry for the target when it is not the
  // origin, and — when a neighbor's field leads back to the origin — an `in`
  // entry for that neighbor, since the edge points at the origin. Entries are
  // deduplicated per (iri, predicate, direction).
  function mapNeighbors(
    origin: Record<string, unknown>,
    originType: string,
    types: SdlTypes,
    hops: number
  ): GraphNeighbor[] {
    const originIri = firstString(origin, ['uri', 'id']) ?? '';
    const neighbors: GraphNeighbor[] = [];
    const seen = new Set<string>();
    const push = (node: Record<string, unknown>, predicate: string, direction: 'out' | 'in') => {
      const iri = firstString(node, ['uri', 'id']);
      if (!iri) return;
      const key = `${iri}|${predicate}|${direction}`;
      if (seen.has(key)) return;
      seen.add(key);
      const typename = typeof node.__typename === 'string' ? node.__typename : '';
      neighbors.push({
        iri,
        label: firstString(node, ['label']) ?? firstString(node, ['id']) ?? iri,
        types: typename ? [typename] : [],
        predicate,
        direction,
      });
    };
    const walk = (node: Record<string, unknown>, typeName: string, level: number) => {
      if (level > hops) return;
      for (const rel of types.get(typeName) ?? []) {
        const targets = node[rel.field];
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          const t = recordOf(target);
          if (!t) continue;
          const targetIri = firstString(t, ['uri', 'id']);
          if (!targetIri) continue;
          if (targetIri === originIri) {
            // edge points back at the origin: the node we are expanding is an
            // in-neighbor (the origin itself never becomes its own neighbor)
            const subjectIri = firstString(node, ['uri', 'id']);
            if (subjectIri && subjectIri !== originIri) push(node, rel.field, 'in');
            continue;
          }
          push(t, rel.field, 'out');
          walk(t, rel.target, level + 1);
        }
      }
    };
    walk(origin, originType, 1);
    return neighbors;
  }

  return {
    async fetchNeighbors(domain: string, iri: string, hops: number): Promise<GraphNeighbor[]> {
      const h = Number.isFinite(hops) ? Math.min(Math.max(Math.round(hops), 1), MAX_HOPS) : 1;
      const types = await loadTypes(domain);
      const frag = idFragmentOf(iri);
      const origin = await probeOriginType(domain, types, frag, iri);
      if (!origin) return []; // not found in the domain's graph: no neighbors
      const body = await request('POST', `/api/v1/graphql/${encodeURIComponent(domain)}`, {
        query: buildExpansionQuery(origin.typeName, types, h),
        variables: { frag },
        depth: h,
      });
      const data = recordOf(recordOf(body)?.['data']);
      const node = recordOf(data?.[rootFieldOf(origin.typeName)]);
      if (!node) return [];
      return mapNeighbors(node, origin.typeName, types, h);
    },
  };
}
