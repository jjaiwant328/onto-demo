"""Generate LABELED SYNTHETIC seed data for RT_onto_demo (offline mode).

This is DEMO DATA ONLY. It mirrors the columns and KPI formulas of the governed
serving views (sql/01..03 and ontology/semantic_measures.yaml) so the app renders
without any live warehouse connection. It is kept entirely separate from the
governed serving layer (different files, clearly labeled).

Run:  python app/seed/generate_seed.py
Writes: app/seed/{store_day,summary,opportunities}.parquet
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

SEED_DIR = Path(__file__).resolve().parent
RNG = np.random.default_rng(42)  # deterministic for reproducible screenshots

N_STORES = 30
N_DAYS = 90
END_DAY = date(2026, 1, 31)

REGIONS = {
    "Southeast": ["GA", "FL", "AL", "SC"],
    "Gulf": ["TX", "LA", "MS"],
    "Mid-South": ["TN", "NC"],
}
CITY_BY_STATE = {
    "GA": "Atlanta", "FL": "Orlando", "AL": "Birmingham", "SC": "Columbia",
    "TX": "Houston", "LA": "Baton Rouge", "MS": "Jackson",
    "TN": "Nashville", "NC": "Charlotte",
}


def _stores() -> pd.DataFrame:
    region_names = list(REGIONS)
    rows = []
    for i in range(N_STORES):
        store_number = 1000 + i
        region = region_names[i % len(region_names)]
        state = REGIONS[region][i % len(REGIONS[region])]
        # store "personality": efficiency multiplier drives KPI spread
        eff = RNG.normal(1.0, 0.18)
        rows.append({
            "store_number": store_number,
            "store_name": f"Retailer #{store_number}",
            "store_city": CITY_BY_STATE[state],
            "state_code": state,
            "region_name": region,
            "store_status": "OPEN",
            "_base_traffic": int(RNG.integers(600, 2200)),
            "_eff": max(0.5, eff),
        })
    return pd.DataFrame(rows)


def _store_day(stores: pd.DataFrame) -> pd.DataFrame:
    days = [END_DAY - timedelta(days=d) for d in range(N_DAYS)]
    recs = []
    for _, s in stores.iterrows():
        for day in days:
            dow = day.weekday()
            weekend = 1.15 if dow >= 5 else 1.0
            noise = RNG.normal(1.0, 0.10)
            total = max(1, int(s["_base_traffic"] * weekend * noise))
            # split: most fuel, many shop, overlap = dual
            fuel = int(total * RNG.uniform(0.55, 0.72))
            shop = int(total * RNG.uniform(0.45, 0.62))
            dual = max(0, min(fuel, shop) - int(total * RNG.uniform(0.05, 0.18)))
            # labor scales with traffic but distorted by store efficiency
            hours = total * RNG.uniform(0.018, 0.030) * s["_eff"]
            cost = hours * RNG.uniform(14.5, 18.0)
            recs.append({
                "store_number": s["store_number"],
                "store_name": s["store_name"],
                "store_city": s["store_city"],
                "state_code": s["state_code"],
                "region_name": s["region_name"],
                "store_status": s["store_status"],
                "date_key": int(day.strftime("%Y%m%d")),
                "calendar_day": pd.Timestamp(day),
                "total_customers": total,
                "shop_customers": shop,
                "fuel_customers": fuel,
                "dual_customers": dual,
                "total_labor_hours": round(hours, 2),
                "total_labor_cost": round(cost, 2),
            })
    df = pd.DataFrame(recs)
    # ---- centralized KPIs (== semantic_measures.yaml / sql/01) --------------
    df["labor_cost_per_customer"] = (df["total_labor_cost"] / df["total_customers"].replace(0, np.nan)).round(4)
    df["labor_hours_per_customer"] = (df["total_labor_hours"] / df["total_customers"].replace(0, np.nan)).round(4)
    df["dual_customer_conversion_rate_pct"] = (100.0 * df["dual_customers"] / df["total_customers"].replace(0, np.nan)).round(2)
    return df


def _summary(store_day: pd.DataFrame) -> pd.DataFrame:
    g = store_day.groupby("store_number")
    summ = g.agg(
        store_name=("store_name", "max"),
        store_city=("store_city", "max"),
        state_code=("state_code", "max"),
        region_name=("region_name", "max"),
        store_status=("store_status", "max"),
        active_days=("calendar_day", "nunique"),
        first_day=("calendar_day", "min"),
        last_day=("calendar_day", "max"),
        total_customers=("total_customers", "sum"),
        shop_customers=("shop_customers", "sum"),
        fuel_customers=("fuel_customers", "sum"),
        dual_customers=("dual_customers", "sum"),
        total_labor_hours=("total_labor_hours", "sum"),
        total_labor_cost=("total_labor_cost", "sum"),
    ).reset_index()
    # ---- derived KPIs recomputed from sums (== sql/02) ---------------------
    summ["labor_cost_per_customer"] = (summ["total_labor_cost"] / summ["total_customers"].replace(0, np.nan)).round(4)
    summ["labor_hours_per_customer"] = (summ["total_labor_hours"] / summ["total_customers"].replace(0, np.nan)).round(4)
    summ["dual_customer_conversion_rate_pct"] = (100.0 * summ["dual_customers"] / summ["total_customers"].replace(0, np.nan)).round(2)
    summ["avg_daily_customers"] = (summ["total_customers"] / summ["active_days"].replace(0, np.nan)).round(2)
    return summ


def _opportunities(summary: pd.DataFrame) -> pd.DataFrame:
    s = summary[summary["total_customers"] > 0].copy()
    region_median = s.groupby("region_name")["labor_cost_per_customer"].transform("median")
    company_median = s["labor_cost_per_customer"].median()
    s["benchmark_lcpc"] = region_median.fillna(company_median).round(4)
    s["lcpc_gap"] = (s["labor_cost_per_customer"] - s["benchmark_lcpc"]).round(4)
    s["opportunity_usd"] = (s["lcpc_gap"].clip(lower=0) * s["total_customers"]).round(2)
    s["opportunity_flag"] = np.where(
        s["lcpc_gap"] > 0, "over_cost_vs_peers",
        np.where(s["lcpc_gap"] < 0, "efficient_vs_peers", "at_benchmark"))
    s = s.sort_values("opportunity_usd", ascending=False)
    s["opportunity_rank"] = s["opportunity_usd"].rank(ascending=False, method="min").astype(int)
    cols = ["store_number", "store_name", "store_city", "state_code", "region_name",
            "store_status", "active_days", "total_customers", "avg_daily_customers",
            "labor_cost_per_customer", "labor_hours_per_customer",
            "dual_customer_conversion_rate_pct", "benchmark_lcpc", "lcpc_gap",
            "opportunity_usd", "opportunity_flag", "opportunity_rank"]
    return s[cols].reset_index(drop=True)


def main() -> None:
    stores = _stores()
    store_day = _store_day(stores)
    summary = _summary(store_day)
    opportunities = _opportunities(summary)

    store_day.to_parquet(SEED_DIR / "store_day.parquet", index=False)
    summary.to_parquet(SEED_DIR / "summary.parquet", index=False)
    opportunities.to_parquet(SEED_DIR / "opportunities.parquet", index=False)

    print(f"[SYNTHETIC SEED] wrote {len(store_day)} store-day rows, "
          f"{len(summary)} stores, {len(opportunities)} opportunities to {SEED_DIR}")


if __name__ == "__main__":
    main()
