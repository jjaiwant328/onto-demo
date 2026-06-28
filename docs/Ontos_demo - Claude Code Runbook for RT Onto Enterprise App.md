# RT Onto Enterprise App Runbook

## Goal

Build a practical ontology-driven app that starts with the Store Traffic and Labor Efficiency use case and is designed to scale into an enterprise data product selector.

The practical path is:

* Do not recreate the full Retailer schema unless there is no usable local data  
* Use the Retailer business definitions as the semantic contract  
* Use the actual workspace and catalog you provided for the physical implementation  
* Use OntoBricks for ontology design, schema mapping, graph materialization, and mapping review  
* Use Ontos for governed enterprise artifacts such as data products, contracts, semantic models, and discovery metadata  
* Build the app so it works first for one use case, then expand to multiple data products

## Target environment

* Workspace: `jai_classic_ws`  
* Working catalog for local schema: `jai_ontos`  
* Working schema: `rt_str_lbr`  
* Workshop target catalog for created artifacts: `jai_ontos`  
* Workshop target schema for created artifacts: `demo_schema`  
* Warehouse ID: `310314146ebd3230`  
* Required artifact prefix: `jai_`  
* App name: `RT_onto_demo`  
* Main repo: `RT_onto`

## Source-of-truth input

The schema inventory CSV should be available to Claude Code inside the repo at:

```
inputs/describe_table_extended.csv
```

If it is not already there, copy the uploaded file into that location before running Claude Code.

## What to build

Build this in phases.

### Phase 0: intake and safety checks

* Confirm whether `jai_ontos.rt_str_lbr` already contains usable physical tables or views  
* Confirm whether the Retailer-named business tables are only a reference vocabulary or are actually present  
* If the local schema has real physical objects, map to them  
* If the local schema does not have usable data, create a minimal seeded demo layer only for the current use case  
* Never create workshop artifacts without the `jai_` prefix  
* Never use a warehouse other than `310314146ebd3230`

### Phase 1: semantic adapter layer

Build a semantic adapter between the business use case and the physical schema.

This means:

* Preserve business concepts such as Store, CalendarDay, StoreTrafficDay, StoreLaborDay, TotalCustomers, TotalLaborCost, and LaborCostPerCustomer  
* Map those concepts onto the actual tables or views in `jai_ontos.rt_str_lbr`  
* If needed, create one conformed serving view in `jai_ontos.demo_schema` named `jai_store_day_traffic_labor`  
* Keep the ontology stable even if physical table names differ

### Phase 2: OntoBricks project

Create an OntoBricks project structure for this use case with:

* ontology classes  
* source-to-ontology mappings  
* semantic measures  
* graph materialization config  
* validation notes  
* sample graph queries

The first use case should model:

* Store  
* CalendarDay  
* StoreTrafficDay  
* StoreLaborDay  
* StoreDayEfficiency

### Phase 3: Ontos project artifacts

Create Ontos-oriented governed artifacts for:

* one data product: `jai_store_traffic_labor_efficiency`  
* one data contract for the serving layer  
* one semantic model registration  
* product metadata for owner, domain, tags, KPIs, and source lineage

### Phase 4: app

Build `RT_onto_demo` with four sections:

* Data Products  
    
  * list available governed products  
  * show status, owner, domain, freshness, contract status


* Ontology Studio  
    
  * show selected product ontology classes  
  * show source mappings  
  * show validation status  
  * link to OntoBricks assets or embed equivalent views


* Semantic Explorer  
    
  * show relationships across classes  
  * show mapped properties and graph-oriented drill-downs


* Business View  
    
  * KPI cards  
  * trends  
  * store filters  
  * region, division, area filters  
  * store diagnostics  
  * efficiency opportunity rankings

### Phase 5: enterprise expansion

Prepare the app to scale from one use case to many.

* Ingest the schema inventory CSV as the enterprise asset inventory  
* Group tables into candidate data products  
* Let users choose a product from a list  
* Generate a draft ontology per product  
* Register those products and contracts through the governed path  
* Keep the app product-driven rather than table-driven

## When to use synthetic data

Use synthetic data only if at least one of the following is true:

* there is no local physical data in `jai_ontos.rt_str_lbr`  
* the app cannot be rendered without seed rows  
* you need reproducible demo screenshots  
* you need to isolate the prototype from sensitive data

If synthetic data is required:

* create only a minimal seed layer for the current use case  
* preserve the business column names and KPI semantics  
* clearly label it as demo seed data  
* keep it separate from governed serving views

## Recommended repo layout

```
RT_onto/
  README.md
  CLAUDE.md
  inputs/
    describe_table_extended.csv
  docs/
    jai_solution_overview.md
    jai_use_case_scope.md
    jai_enterprise_rollout.md
  ontology/
    retail_traffic_labor.ttl
    source_mapping.yaml
    semantic_measures.yaml
    data_products.yaml
    contracts/
      jai_store_traffic_labor_efficiency_contract.yaml
  ontobricks/
    README.md
    config/
      project.yaml
      materialization.yaml
    mappings/
      retail_traffic_labor_mapping.yaml
    queries/
      sample_queries.graphql
      sample_queries.sql
  ontos/
    README.md
    products/
      jai_store_traffic_labor_efficiency.yaml
    semantics/
      jai_store_traffic_labor_semantic_model.yaml
    contracts/
      jai_store_traffic_labor_efficiency_contract.yaml
  sql/
    01_jai_store_day_traffic_labor.sql
    02_jai_store_efficiency_summary.sql
    03_jai_store_efficiency_opportunities.sql
    04_jai_product_registry.sql
  app/
    app.py
    config.py
    data_access.py
    ontology_service.py
    product_registry.py
    pages/
      data_products.py
      ontology_studio.py
      semantic_explorer.py
      business_view.py
  skills/
    schema_inventory/
      SKILL.md
    ontology_draft/
      SKILL.md
    data_product_registration/
      SKILL.md
    serving_view_generation/
      SKILL.md
    app_smoke_test/
      SKILL.md
  tests/
    test_sql_shapes.py
    test_semantic_measures.py
    test_product_registry.py
    test_filters.py
```

## Required project rules for `CLAUDE.md`

Create `CLAUDE.md` with these rules:

```
# RT_onto project rules

* Use warehouse ID `310314146ebd3230` for all SQL execution assumptions.
* Use `jai_ontos`.`demo_schema` for all created workshop artifacts.
* Every created object name must start with `jai_`.
* Keep the ontology and business vocabulary stable even if physical table names differ.
* Prefer mapping local physical schema to business concepts over recreating a source-system namespace.
* Only create synthetic seed data if the local schema lacks usable rows for the app.
* Keep business KPI logic centralized in semantic_measures.yaml and SQL serving views.
* Build in phases. Do not skip directly to enterprise-wide automation before the single use case works.
* The app must support one use case first and multi-product selection second.
* Store repeatable task instructions as local skills under `skills/`.
```

## Required local skills

Create these local project skills.

### 1\. `skills/schema_inventory/SKILL.md`

Purpose:

* Load and profile `inputs/describe_table_extended.csv`  
* Group tables into candidate business domains  
* Identify likely dimensions, facts, keys, and descriptive columns  
* Produce short mapping summaries for downstream ontology work

Minimum instructions:

* Read only the schema inventory and any local docs  
* Do not invent physical tables  
* Produce candidate data product groupings  
* Flag ambiguous tables for review

### 2\. `skills/ontology_draft/SKILL.md`

Purpose:

* Generate a first-pass ontology from a selected product/domain  
* Create classes, relationships, and core datatype properties  
* Keep the model minimal and useful

Minimum instructions:

* Start from the selected use case, not the whole enterprise  
* Model business concepts first  
* Map back to physical schema second  
* Avoid over-modeling

### 3\. `skills/data_product_registration/SKILL.md`

Purpose:

* Generate governed product metadata and contract files  
* Standardize owner, domain, source, KPI, and freshness fields

Minimum instructions:

* Require `jai_` prefixed product names  
* Record semantic model and source lineage  
* Record contract scope and assumptions  
* Keep registration files machine-readable

### 4\. `skills/serving_view_generation/SKILL.md`

Purpose:

* Generate conformed SQL serving views  
* Resolve grain mismatches between source tables  
* Centralize KPI calculations

Minimum instructions:

* Build serving views in `jai_ontos.demo_schema`  
* Keep all created view names prefixed with `jai_`  
* Prefer views first, tables later only if required  
* Document every KPI formula in one place

### 5\. `skills/app_smoke_test/SKILL.md`

Purpose:

* Validate that the app can load data, filters, ontology metadata, and product registry entries

Minimum instructions:

* Verify product list loads  
* Verify ontology mapping payload loads  
* Verify KPI cards render with expected columns  
* Verify one product drill-down path works

## Required scaffold files

Claude Code should create these first.

### `ontology/semantic_measures.yaml`

This file should contain at least:

* total\_customers  
* shop\_customers  
* fuel\_customers  
* dual\_customers  
* total\_labor\_hours  
* total\_labor\_cost  
* dual\_customer\_conversion\_rate\_pct  
* labor\_cost\_per\_customer  
* labor\_hours\_per\_customer

### `ontology/data_products.yaml`

This file should start with one product entry:

* `jai_store_traffic_labor_efficiency`

Recommended fields:

* product\_name  
* display\_name  
* domain  
* business\_outcome  
* serving\_view  
* ontology\_file  
* semantic\_measures\_file  
* contract\_file  
* source\_tables  
* owner  
* maturity  
* tags

### `sql/04_jai_product_registry.sql`

This should provide a simple registry shape that the app can read.

Recommended columns:

* product\_name  
* display\_name  
* domain  
* business\_outcome  
* serving\_object\_name  
* ontology\_status  
* contract\_status  
* app\_enabled  
* owner  
* tags

## App behavior recommendations

The app should help ontology mapping in a practical way.

### It should show business-to-physical mapping

For a selected data product, the app should display:

* ontology classes  
* mapped source tables  
* mapped source columns  
* join logic  
* serving object names  
* KPI definitions

### It should let you validate ontology usefulness

For a selected data product, the app should let you:

* inspect KPI outputs  
* inspect store/day level rows  
* compare semantic definitions against data columns  
* verify whether the mapping supports the business questions

### It should support enterprise discovery later

The app should not be hard-coded only for the retail use case. It should be able to load products from a registry and show:

* available data products  
* selected product ontology  
* selected product contract  
* selected product KPI view  
* selected product business dashboard

## Companion execution prompt

Use the separate file `jai_claude_code_execution_prompt.md` as the runnable Claude Code prompt. Keep this runbook as the reference document for architecture, phasing, repo layout, and guardrails.

## What success looks like

At the end of the first pass, you should have:

* one governed product definition  
* one contract  
* one ontology draft  
* one mapping file  
* one conformed serving view  
* one product registry view  
* one app that can select the product and render the business view  
* one set of local skills that Claude Code can reuse in later iterations

## Operator notes

Use this runbook as the single handoff to Claude Code.

The most important implementation choice is this:

* build a semantic adapter layer against your actual local schema  
* do not spend time cloning a full source-system namespace unless the local environment is empty  
* let the app prove the ontology by making the mapping inspectable and the KPI experience usable

*Co-authored with Glean*  
