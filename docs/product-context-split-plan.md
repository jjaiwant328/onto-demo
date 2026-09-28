# Plan: Split the `ProductContext` god-object

## Context

`client/src/lib/product.tsx` exposes a single React context (`useProduct()`) with
~60 fields. The graphify knowledge-graph analysis flagged `useProduct()` as the
app's top "god node" (51 edges, ~30 consumers spanning 11 feature communities):
almost every page reads from it.

Two low-risk fixes are already applied:
- The context `value` object is now `useMemo`'d (previously a new literal every render).
- `setSelectedDomain` / `setSelectedProduct` are now `useCallback`-stabilized.

Those stop *identity churn* of the whole value. But a single context still means
**over-subscription**: a component that reads only `selectedProduct` re-renders when
an unrelated field (`useCaseDrafts`, `artifact`, `domainAnalysis`, the 450 ms
`rebuilding` toggle, `llmRefining`) changes, because context consumers can't
subscribe to a subset of a value. Splitting the context by change-frequency is the
structural fix.

## Goal

Consumers re-render only when a slice they actually use changes. No behavior change —
this is a pure render-performance refactor. Success = the app behaves identically and
React DevTools Profiler shows unrelated components no longer re-rendering on churny
state (e.g. the `rebuilding` timer, an artifact fetch).

## Approach

Split `ProductContextValue` into four contexts by how often each field changes and
who reads it. Keep one `ProductProvider` that nests four providers, so the state
wiring in `product.tsx` is untouched — only the *grouping into contexts* changes.

Proposed slices:

1. **`SelectionContext`** — schema registry + selection + scope + setters:
   `schemaEntries`, `selectedSchemaIds`, `toggleSchema`, `setSelectedSchemas`,
   `combineAll`, `combined`, `domains`, `domainScope`, `productScope`,
   `domainScopeAll`, `productScopeAll`, `scopedDomains`, `scopedProducts`,
   `selectedDomain`, `setSelectedDomain`, `productsInDomain`, `selectedProduct`,
   `setSelectedProduct`, schema CRUD (`addSchema`, `removeSchema`, `saveSchema`, …),
   `isolationKey`, `scopeSig`.

2. **`DerivedContext`** — expensive, changes rarely: `schema`, `catalog`,
   `catalogSource`, `catalogLoading`, `components`, `enterpriseGraph`,
   `enterpriseHighlight`, `conformance`, `activeSourceCatalog`, `activeSchemaLabel`.

3. **`ResourcesContext`** — independently-churning async resources:
   `artifact`, `artifactStale`, `regenerateArtifact`, `domainAnalysis*`,
   `regenerateDomainAnalysis`, `useCaseDrafts` + its mutators, `ontologyOverrides` +
   mutators, `productLinks`, `refreshGraphLinks`, `llmRefining`, `rebuilding`.

4. **`UiPrefsContext`** — near-static toggles: `syncScopeFromSections`,
   `showActionCenter`, `showBusinessView`, `showControlTower` + setters,
   `getScopeCache`, `setScopeCache`.

Each gets its own `useMemo`'d value and a typed hook (`useSelection()`,
`useDerived()`, `useResources()`, `useUiPrefs()`).

### Migration strategy (keep it incremental and safe)

- **Keep `useProduct()` working** as a compatibility shim that reads all four
  contexts and returns the merged object, so no consumer must change on day one.
  (It will re-render like today, but nothing regresses.) Then migrate consumers
  page-by-page to the narrow hooks and delete the shim last.
- Migrate the ~30 consumers (found via the graph trace — App.tsx, OntologyStudio,
  DataContract, GraphExplorer, BusinessView, ControlTowerHome, DomainAnalysis,
  ScenarioImpact, DraftEditor, SemanticExplorer, DataProducts, SchemaLoader) one
  at a time, swapping `useProduct()` for the specific hook(s) each needs.

## Critical files

- `client/src/lib/product.tsx` — define the four contexts + providers + hooks; nest
  them in `ProductProvider`. All existing state/`useMemo`/`useCallback` logic stays.
- The ~30 consumer components (mechanical `useProduct()` → narrow-hook swaps).

## Verification

1. `npx tsc -b tsconfig.client.json` — clean.
2. `npx eslint client/src/lib/product.tsx` — no new errors (baseline: 37).
3. `npx vitest run` — 57/57 pass.
4. `npx playwright test tests/smoke.spec.ts` — smoke path green.
5. React DevTools Profiler: trigger the `rebuilding` timer / an artifact fetch and
   confirm components that don't read those slices no longer re-render.

## Risk / effort

Medium effort (touches ~30 files), low logic risk (grouping only, no state changes).
The compatibility shim means it can land in stages without a big-bang cutover.
