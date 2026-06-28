"""Ontology + semantic-model service.

Surfaces the OntoBricks/Ontos artifacts to the app: classes, business->physical
mappings, semantic measures, relationships, and validation status. Reads the YAML
artifacts (source of truth) and lightly parses the TTL for class labels.
"""
from __future__ import annotations

import functools
import re

import yaml

from . import config


@functools.lru_cache(maxsize=1)
def _measures() -> dict:
    with open(config.SEMANTIC_MEASURES_YAML) as fh:
        return yaml.safe_load(fh) or {}


@functools.lru_cache(maxsize=1)
def _mapping() -> dict:
    with open(config.SOURCE_MAPPING_YAML) as fh:
        return yaml.safe_load(fh) or {}


@functools.lru_cache(maxsize=1)
def _ttl_classes() -> list[str]:
    text = config.ONTOLOGY_TTL.read_text() if config.ONTOLOGY_TTL.exists() else ""
    return re.findall(r"rt:(\w+)\s+a\s+owl:Class", text)


def get_classes(product: str = config.DEFAULT_PRODUCT) -> list[dict]:
    """Ontology classes with their physical mapping + key columns."""
    classes_cfg = _mapping().get("classes", {})
    rows = []
    for name in _ttl_classes() or classes_cfg.keys():
        cfg = classes_cfg.get(name, {})
        rows.append({
            "class": name,
            "grain": cfg.get("grain", "derived" if cfg.get("derived") else "—"),
            "source_table": cfg.get("source_table", "(derived)"),
            "derived": bool(cfg.get("derived")),
        })
    return rows


def get_mappings(product: str = config.DEFAULT_PRODUCT) -> list[dict]:
    """Flat class -> property -> source column mapping rows for display."""
    out = []
    for cname, cfg in _mapping().get("classes", {}).items():
        key = cfg.get("key")
        if isinstance(key, dict):
            out.append({"class": cname, "property": key.get("ontology"),
                        "source": _src(cfg), "column": key.get("column"), "role": "key"})
        for prop, col in (cfg.get("keys") or {}).items():
            out.append({"class": cname, "property": prop, "source": _src(cfg),
                        "column": col, "role": "key"})
        for prop, col in (cfg.get("columns") or {}).items():
            out.append({"class": cname, "property": prop, "source": _src(cfg),
                        "column": col, "role": "attribute"})
        for prop, spec in (cfg.get("measures") or {}).items():
            col = spec.get("column") if isinstance(spec, dict) else spec
            out.append({"class": cname, "property": prop, "source": _src(cfg),
                        "column": col, "role": "measure"})
    return out


def _src(cfg: dict) -> str:
    return cfg.get("source_table", "(derived)")


def get_measures(product: str = config.DEFAULT_PRODUCT) -> list[dict]:
    rows = []
    for name, m in (_measures().get("measures") or {}).items():
        rows.append({
            "measure": name,
            "type": m.get("type"),
            "unit": m.get("unit"),
            "formula": m.get("formula_sql"),
            "description": m.get("description", "").strip(),
        })
    return rows


def get_relationships(product: str = config.DEFAULT_PRODUCT) -> list[dict]:
    """Object properties parsed from the TTL (subject, predicate, object)."""
    text = config.ONTOLOGY_TTL.read_text() if config.ONTOLOGY_TTL.exists() else ""
    rels = []
    for m in re.finditer(
        r"rt:(\w+)\s+a\s+owl:ObjectProperty\s*;(.*?)\.", text, re.S
    ):
        pred, body = m.group(1), m.group(2)
        dom = re.search(r"rdfs:domain\s+(?:rt:(\w+)|\[)", body)
        rng = re.search(r"rdfs:range\s+rt:(\w+)", body)
        rels.append({
            "predicate": pred,
            "from": dom.group(1) if dom and dom.group(1) else "(union)",
            "to": rng.group(1) if rng else "?",
        })
    return rels


def get_validation(product: str = config.DEFAULT_PRODUCT) -> dict:
    """Validation status: do mapped columns exist in the serving data?"""
    from . import data_access

    status = {"status": "unknown", "checks": []}
    try:
        df = data_access.get_store_day(product)
        cols = set(df.columns)
    except Exception as exc:  # noqa: BLE001
        status["status"] = "no_data"
        status["checks"].append({"check": "serving view reachable", "ok": False, "detail": str(exc)})
        return status

    contract_cols = [
        "store_number", "calendar_day", "total_customers", "total_labor_cost",
        "labor_cost_per_customer", "labor_hours_per_customer",
        "dual_customer_conversion_rate_pct",
    ]
    all_ok = True
    for c in contract_cols:
        ok = c in cols
        all_ok &= ok
        status["checks"].append({"check": f"column `{c}` present", "ok": ok})
    geo_ok = "region_name" in cols
    status["checks"].append({"check": "region_name present (A3, optional)", "ok": geo_ok})

    status["status"] = "validated" if all_ok else "incomplete"
    status["row_count"] = int(len(df))
    return status


def get_assumptions() -> dict:
    return _mapping().get("assumptions", {})
