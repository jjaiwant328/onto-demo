// Types for the ontobricks integration. ontobricks (the deployed Databricks
// Labs app) materializes this workspace's ontology into a graph and serves it
// through a per-domain GraphQL API; these types are the narrow slice of that
// API this app consumes.
//
// Everything here is modeled permissively — unknown extra keys are allowed —
// because ontobricks' real API is external and evolves independently of this
// repo. Field access must tolerate missing values; see
// server/ontobricksClient.ts for the mapping onto these shapes.

/**
 * One node reachable from an expanded origin node, plus the edge it was
 * found on.
 *
 * `predicate` is the ontobricks GraphQL relationship field the traversal
 * followed (the object property's name, e.g. `hasOrder`) — the wire API
 * identifies edges by field name, not full predicate IRIs.
 *
 * `direction` describes that edge: `out` means the traversal walked it
 * forward (predecessor -predicate-> neighbor); `in` means the neighbor points
 * at the origin (neighbor -predicate-> origin). ontobricks only exposes
 * outgoing relationship fields, so `in` entries come from traversal edges
 * that lead back to the origin.
 *
 * `types` carries the node's ontology class as the API reports it — the
 * GraphQL `__typename` (the class name). The class IRI itself is not
 * serialized by the external GraphQL API.
 */
export interface GraphNeighbor {
  iri: string; // neighbor node IRI
  label: string;
  types: string[]; // ontology class names (the API reports __typename, not class IRIs)
  predicate: string; // edge predicate (relationship field) connecting origin -> neighbor
  direction: 'out' | 'in';
}

/**
 * Configuration for server/ontobricksClient.ts. `fetchImpl` is injectable for
 * tests.
 *
 * `databricksHost` is the workspace host sent as `X-Databricks-Host`. When
 * absent, the client derives it at call time from `process.env.DATABRICKS_HOST`
 * (protocol prefix stripped); when neither is set the header is omitted.
 */
export interface OntobricksClientConfig {
  baseUrl: string;
  token: string; // PAT
  fetchImpl?: typeof fetch;
  databricksHost?: string;
}
