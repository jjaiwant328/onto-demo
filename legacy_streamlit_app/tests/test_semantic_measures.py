"""Semantic measure formulas: the data implements semantic_measures.yaml."""
import yaml

from app import config, data_access

REQUIRED = [
    "total_customers", "shop_customers", "fuel_customers", "dual_customers",
    "total_labor_hours", "total_labor_cost", "dual_customer_conversion_rate_pct",
    "labor_cost_per_customer", "labor_hours_per_customer",
]


def _measures():
    return yaml.safe_load(config.SEMANTIC_MEASURES_YAML.read_text())["measures"]


def test_all_required_measures_defined():
    defined = set(_measures())
    missing = set(REQUIRED) - defined
    assert not missing, f"semantic_measures.yaml missing: {missing}"


def test_labor_cost_per_customer_formula_holds():
    df = data_access.get_store_day()
    sub = df[df["total_customers"] > 0]
    expected = sub["total_labor_cost"] / sub["total_customers"]
    assert ((sub["labor_cost_per_customer"] - expected).abs() < 1e-3).all()


def test_dual_conversion_formula_holds():
    df = data_access.get_store_day()
    sub = df[df["total_customers"] > 0]
    expected = 100.0 * sub["dual_customers"] / sub["total_customers"]
    assert ((sub["dual_customer_conversion_rate_pct"] - expected).abs() < 1e-1).all()


def test_derived_kpis_recomputed_from_sums_not_averaged():
    """Store summary KPI must equal sum/sum, not the mean of daily ratios."""
    sd = data_access.get_store_day()
    summ = data_access.get_efficiency_summary().set_index("store_number")
    g = sd.groupby("store_number")
    recomputed = g["total_labor_cost"].sum() / g["total_customers"].sum()
    diff = (summ["labor_cost_per_customer"] - recomputed).abs()
    assert (diff < 1e-3).all()


def test_customer_parts_within_total():
    df = data_access.get_store_day()
    assert (df["shop_customers"] <= df["total_customers"]).all()
    assert (df["fuel_customers"] <= df["total_customers"]).all()
    assert (df["dual_customers"] <= df["total_customers"]).all()


def test_no_negative_measures():
    df = data_access.get_store_day()
    for c in ["total_customers", "total_labor_hours", "total_labor_cost"]:
        assert (df[c] >= 0).all()
