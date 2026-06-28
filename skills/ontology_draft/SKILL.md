---
name: ontology_draft
description: Generate a first-pass, minimal ontology (classes, relationships, datatype properties) from a selected product/domain, then map back to physical schema.
---

# ontology_draft

Draft a useful, minimal ontology for **one** use case. Model business concepts
first; map to physical schema second. Avoid over-modeling.

## Steps

1. Take the selected use case (not the whole enterprise). Example: Store Traffic
   & Labor Efficiency.
2. Identify **classes** = the nouns the business reasons about
   (Store, CalendarDay, StoreTrafficDay, StoreLaborDay, StoreDayEfficiency).
3. Identify **relationships** (object properties): e.g. `StoreTrafficDay
   forStore Store`, `StoreTrafficDay onDay CalendarDay`,
   `StoreDayEfficiency derivedFrom StoreTrafficDay/StoreLaborDay`.
4. Identify **datatype properties** = the columns that matter
   (total_customers, total_labor_hours, total_labor_cost, ...). Keep KPI *formulas*
   out of the TTL — they live in `ontology/semantic_measures.yaml`.
5. Write `ontology/retail_traffic_labor.ttl` (Turtle, one namespace).
6. Map each class/property to physical columns in `ontology/source_mapping.yaml`
   and `ontobricks/mappings/*.yaml`. Record join logic and grain.

## Outputs

* `ontology/retail_traffic_labor.ttl`
* `ontology/source_mapping.yaml`
* `ontobricks/mappings/retail_traffic_labor_mapping.yaml`

## Guardrails

* Keep the class/vocabulary names stable even if physical names differ.
* One serving-relevant property per real, mappable column — do not model
  attributes you cannot source.
* If a concept cannot be mapped, leave it unmapped and note it in
  `validation_notes` rather than inventing a source.
