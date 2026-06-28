# OntoBricks — RT_onto

OntoBricks owns **ontology design and the path from physical schema to graph**:

* ontology classes & relationships (`../ontology/retail_traffic_labor.ttl`)
* source-to-ontology mappings (`mappings/retail_traffic_labor_mapping.yaml`)
* graph materialization config (`config/materialization.yaml`)
* validation notes and sample graph/SQL queries (`queries/`)

This is the *design and mapping* surface. Governed enterprise artifacts (data
products, contracts, semantic-model registrations) live in `../ontos/`.

## Files

| File | Purpose |
| --- | --- |
| `config/project.yaml` | Project identity, source/target, namespaces |
| `config/materialization.yaml` | How classes/edges materialize to graph + serving |
| `mappings/retail_traffic_labor_mapping.yaml` | Class/property → physical column mappings |
| `queries/sample_queries.graphql` | Example graph traversals |
| `queries/sample_queries.sql` | Equivalent SQL over the serving views |

## Workflow

1. Draft classes from the use case (`/skills/ontology_draft`).
2. Map classes to physical columns (this folder + `../ontology/source_mapping.yaml`).
3. Validate mappings against the serving views.
4. Hand the validated model to Ontos for governed registration.
