---
name: schema_inventory
description: Load and profile inputs/describe_table_extended.csv, group tables into candidate business domains, and produce mapping summaries for ontology work.
---

# schema_inventory

Profile the enterprise schema inventory and propose candidate data products.
Read-only over the inventory and local docs — **never invent physical tables.**

## Inputs

* `inputs/describe_table_extended.csv` — columns: `catalog, schema, table, column_name, data_type, comment`.

## Steps

1. Load the CSV. Distinct grain is `catalog.schema.table`; columns repeat per table.
   Filter out describe-extended metadata rows (`column_name` in
   `Catalog, Database, Table, Created Time, Owner, Type, Provider, ...`).
2. Group tables by `schema` and by name prefix (`dim_`, `smmry_`, `fin_`, `sale_`,
   `void_`, `vw_`) into candidate domains (store, labor, fuel, POS, customer, finance).
3. For each candidate table classify columns: **keys** (`*_key`, `*_id`, `*_number`,
   `*_num`), **dates** (`*_date*`, `date_key`), **measures** (numeric: int/decimal/
   double on a fact), **descriptors** (string on a dim).
4. Identify likely **facts** (smmry_*/sale_*/fin_* with measures + date + store key)
   and **dimensions** (dim_* / vw_*).
5. Emit candidate data-product groupings (a fact + its conformed dims) and flag
   ambiguous tables (no clear key, no date, or unclear grain) for review.

## Output

A short markdown table per candidate product: concept → table → key columns,
plus a "flagged for review" list. Append findings to `docs/jai_solution_overview.md`
or a new `docs/jai_candidate_products.md` for enterprise expansion.

## Guardrails

* Do not assume a table exists just because the business vocabulary names it.
* Distinguish *reference vocabulary* (`fc_entdata_gold`) from *local physical*
  (`jai_ontos.rt_str_lbr`) — confirm the latter live before mapping to it.

## Quick command

```bash
tail -n +2 inputs/describe_table_extended.csv | awk -F',' '{print $1"."$2"."$3}' | sort -u
```
