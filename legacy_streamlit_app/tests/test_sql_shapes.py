"""Serving-layer output shape: the data the app reads matches the contract.

In seed mode the parquet mirrors the SQL views, so these assert the contracted
columns exist with the right grain. The contract YAML is the source of column
truth (ontos/contracts/...).
"""
import re

import yaml

from app import config, data_access

CONTRACT = config.REPO_ROOT / "ontos" / "contracts" / "jai_store_traffic_labor_efficiency_contract.yaml"


def _contract_columns():
    doc = yaml.safe_load(CONTRACT.read_text())
    return [c["name"] for c in doc["spec"]["schema"]]


def test_store_day_has_all_contract_columns():
    df = data_access.get_store_day()
    missing = set(_contract_columns()) - set(df.columns)
    assert not missing, f"serving view missing contract columns: {missing}"


def test_store_day_grain_is_store_day():
    df = data_access.get_store_day()
    dup = df.duplicated(subset=["store_number", "date_key"]).sum()
    assert dup == 0, f"{dup} rows violate store x day grain"


def test_summary_grain_is_store():
    df = data_access.get_efficiency_summary()
    assert df["store_number"].is_unique


def test_opportunities_columns():
    df = data_access.get_opportunities()
    for c in ["opportunity_rank", "opportunity_usd", "lcpc_gap", "benchmark_lcpc"]:
        assert c in df.columns


def test_all_serving_names_are_jai_prefixed():
    for name in config.SERVING.values():
        obj = name.split(".")[-1]
        assert obj.startswith("jai_"), f"{obj} missing jai_ prefix"


def test_sql_files_target_demo_schema_and_jai_prefix():
    """Every created VIEW/TABLE/VOLUME lives in jai_ontos.demo_schema and is jai_-prefixed."""
    sql_dir = config.REPO_ROOT / "sql"
    pat = re.compile(
        r"CREATE (?:OR REPLACE )?(?:VIEW|TABLE|VOLUME)(?:\s+IF NOT EXISTS)?\s+([^\s]+)",
        re.IGNORECASE)
    for f in sorted(sql_dir.glob("*.sql")):
        objs = pat.findall(f.read_text())
        assert objs, f"{f.name} creates no VIEW/TABLE/VOLUME"
        for fqn in objs:
            assert fqn.startswith("jai_ontos.demo_schema.jai_"), f"{f.name}: {fqn}"
