"""Product registry access — keeps the app product-driven, not table-driven.

Reads the SQL registry view in warehouse mode, else the file-based registry
(ontology/data_products.yaml). Returns normalized rows with the columns the app
and smoke tests expect.
"""
from __future__ import annotations

import functools

import yaml

from . import config

REGISTRY_COLUMNS = [
    "product_name", "display_name", "domain", "business_outcome",
    "serving_object_name", "ontology_status", "contract_status",
    "app_enabled", "owner", "tags",
]


def _from_yaml() -> list[dict]:
    with open(config.DATA_PRODUCTS_YAML) as fh:
        doc = yaml.safe_load(fh) or {}
    rows = []
    for p in doc.get("products", []):
        rows.append({
            "product_name": p.get("product_name"),
            "display_name": p.get("display_name"),
            "domain": p.get("domain"),
            "business_outcome": (p.get("business_outcome") or "").strip(),
            "serving_object_name": p.get("serving_view"),
            "ontology_status": p.get("ontology_status", "draft"),
            "contract_status": p.get("contract_status", "defined"),
            "app_enabled": bool(p.get("app_enabled", True)),
            "owner": p.get("owner"),
            "tags": ",".join(p.get("tags", [])) if isinstance(p.get("tags"), list) else p.get("tags", ""),
            # carry-through extras the UI uses
            "summary_view": p.get("summary_view"),
            "opportunities_view": p.get("opportunities_view"),
            "kpis": p.get("kpis", []),
            "source_tables": p.get("source_tables", []),
            "ontology_file": p.get("ontology_file"),
            "contract_file": p.get("contract_file"),
            "maturity": p.get("maturity"),
        })
    return rows


def _from_warehouse() -> list[dict]:
    from . import data_access
    df = data_access._sql(f"SELECT * FROM {config.SERVING['registry']}")
    return df.to_dict("records")


@functools.lru_cache(maxsize=1)
def load_products() -> list[dict]:
    rows = _from_warehouse() if not config.is_seed_mode() else _from_yaml()
    return rows


def enabled_products() -> list[dict]:
    return [p for p in load_products() if p.get("app_enabled", True)]


def get_product(product_name: str) -> dict | None:
    for p in load_products():
        if p.get("product_name") == product_name:
            return p
    return None


def clear_cache() -> None:
    load_products.cache_clear()
