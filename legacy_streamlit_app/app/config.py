"""Central configuration for RT_onto_demo.

Everything environment-specific lives here. Defaults make the app run offline in
``seed`` mode; set ``RT_ONTO_DATA_MODE=warehouse`` to query live serving views.
"""
from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "RT_onto_demo"
REPO_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "app"
SEED_DIR = APP_DIR / "seed"

# ---- Data mode ---------------------------------------------------------------
# "seed"      -> read labeled synthetic parquet from app/seed/ (default, offline)
# "warehouse" -> query the jai_ serving views on the SQL warehouse
DATA_MODE = os.environ.get("RT_ONTO_DATA_MODE", "seed").lower()

# ---- Workspace / catalog (per CLAUDE.md, never change without reason) ---------
WORKSPACE = "jai_classic_ws"
# NOTE: runbook-required 310314146ebd3230 does not exist in jai_classic_ws.
# Operator directed use of jai-sql-warehouse (bf7ffcda00a8c351). See docs A1/A6.
WAREHOUSE_ID = os.environ.get("RT_ONTO_WAREHOUSE_ID", "bf7ffcda00a8c351")
DATABRICKS_PROFILE = os.environ.get("DATABRICKS_CONFIG_PROFILE", "jai-classic")

# Source of the physical data (override for local jai_ontos.rt_str_lbr; see A2)
SOURCE_CATALOG = os.environ.get("RT_ONTO_SOURCE_CATALOG", "fc_entdata_gold")

# Workshop target where jai_ serving views live
TARGET_CATALOG = os.environ.get("RT_ONTO_TARGET_CATALOG", "jai_ontos")
TARGET_SCHEMA = os.environ.get("RT_ONTO_TARGET_SCHEMA", "demo_schema")
ARTIFACT_PREFIX = "jai_"

# ---- Serving objects (single source of names) --------------------------------
def _obj(name: str) -> str:
    return f"{TARGET_CATALOG}.{TARGET_SCHEMA}.{name}"

SERVING = {
    "store_day": _obj("jai_store_day_traffic_labor"),
    "summary": _obj("jai_store_efficiency_summary"),
    "opportunities": _obj("jai_store_efficiency_opportunities"),
    "registry": _obj("jai_product_registry"),
}

# ---- File-based registry / semantics (used in seed mode + ontology views) -----
DATA_PRODUCTS_YAML = REPO_ROOT / "ontology" / "data_products.yaml"
SEMANTIC_MEASURES_YAML = REPO_ROOT / "ontology" / "semantic_measures.yaml"
SOURCE_MAPPING_YAML = REPO_ROOT / "ontology" / "source_mapping.yaml"
ONTOLOGY_TTL = REPO_ROOT / "ontology" / "retail_traffic_labor.ttl"
ONTOS_PRODUCTS_DIR = REPO_ROOT / "ontos" / "products"
ONTOS_SEMANTICS_DIR = REPO_ROOT / "ontos" / "semantics"

# Databricks SQL connector settings (warehouse mode only)
DATABRICKS_HOST = os.environ.get("DATABRICKS_HOST")
DATABRICKS_TOKEN = os.environ.get("DATABRICKS_TOKEN")
HTTP_PATH = os.environ.get(
    "DATABRICKS_HTTP_PATH", f"/sql/1.0/warehouses/{WAREHOUSE_ID}"
)

DEFAULT_PRODUCT = "jai_store_traffic_labor_efficiency"


def is_seed_mode() -> bool:
    return DATA_MODE != "warehouse"
