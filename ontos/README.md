# Ontos — RT_onto

Ontos owns **governed enterprise artifacts**: the durable, machine-readable
registrations that make a use case a *product* the organization can discover,
trust, and reuse.

* data products (`products/`)
* data contracts for serving layers (`contracts/`)
* semantic-model registrations (`semantics/`)
* product metadata: owner, domain, tags, KPIs, source lineage, maturity

OntoBricks (`../ontobricks/`) produces the ontology and mappings; Ontos governs
the result. The app reads the product registry to stay product-driven.

## Files

| File | Purpose |
| --- | --- |
| `products/jai_store_traffic_labor_efficiency.yaml` | Product definition + lineage |
| `contracts/jai_store_traffic_labor_efficiency_contract.yaml` | Serving contract (schema, SLAs, checks) |
| `semantics/jai_store_traffic_labor_semantic_model.yaml` | Registered semantic model (classes ↔ measures ↔ serving) |

## Relationship to OntoBricks

| Concern | OntoBricks | Ontos |
| --- | --- | --- |
| Ontology classes & edges | ✅ designs | references |
| Source→concept mapping | ✅ authors | references for lineage |
| Graph materialization | ✅ owns | — |
| Data product registration | — | ✅ owns |
| Contract & SLA | — | ✅ owns |
| Semantic model of record | drafts | ✅ registers |
