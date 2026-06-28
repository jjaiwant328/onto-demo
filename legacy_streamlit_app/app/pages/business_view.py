"""Business View page — KPI cards, trends, filters, store diagnostics, opportunities."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import data_access


def _kpi_cards(df: pd.DataFrame) -> None:
    total_customers = int(df["total_customers"].sum())
    total_cost = float(df["total_labor_cost"].sum())
    total_hours = float(df["total_labor_hours"].sum())
    dual = int(df["dual_customers"].sum())
    lcpc = total_cost / total_customers if total_customers else 0
    lhpc = total_hours / total_customers if total_customers else 0
    conv = 100.0 * dual / total_customers if total_customers else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total customers", f"{total_customers:,}")
    c2.metric("Labor $ / customer", f"${lcpc:,.3f}")
    c3.metric("Labor hrs / customer", f"{lhpc:,.3f}")
    c4.metric("Dual conversion", f"{conv:,.1f}%")


def render(selected_product: str) -> None:
    st.header("Business View")
    df = data_access.get_store_day(selected_product)
    if df.empty:
        st.warning("No data. In seed mode run: python app/seed/generate_seed.py")
        return

    # ---- filters (region/state/store; geo-null tolerant, A3) ----------------
    with st.sidebar:
        st.markdown("### Business filters")
        f = {}
        for col, label in [("region_name", "Region"), ("state_code", "State")]:
            opts = data_access.distinct_values(df, col)
            if opts:
                sel = st.multiselect(label, opts)
                if sel:
                    f[col] = sel
        df_geo = data_access.apply_filters(df, f)
        store_opts = data_access.distinct_values(df_geo, "store_number")
        store_sel = st.multiselect("Store", store_opts)
        if store_sel:
            f["store_number"] = store_sel

    fdf = data_access.apply_filters(df, f)
    if fdf.empty:
        st.info("No rows match the current filters.")
        return

    _kpi_cards(fdf)

    # ---- trend --------------------------------------------------------------
    st.subheader("Trends")
    metric = st.selectbox("Metric", [
        "total_customers", "labor_cost_per_customer",
        "labor_hours_per_customer", "dual_customer_conversion_rate_pct"])
    daily = _daily_metric(fdf, metric)
    st.line_chart(daily)

    # ---- store diagnostics + opportunity ranking ----------------------------
    st.subheader("Store diagnostics")
    summ = data_access.get_efficiency_summary(selected_product)
    if f:
        summ = data_access.apply_filters(summ, {k: v for k, v in f.items()
                                                if k in summ.columns})
    diag_cols = ["store_number", "store_name", "region_name", "state_code",
                 "total_customers", "labor_cost_per_customer",
                 "labor_hours_per_customer", "dual_customer_conversion_rate_pct"]
    st.dataframe(summ[[c for c in diag_cols if c in summ.columns]]
                 .sort_values("labor_cost_per_customer", ascending=False),
                 use_container_width=True, hide_index=True)

    st.subheader("Efficiency opportunity rankings")
    opp = data_access.get_opportunities(selected_product)
    if f:
        opp = data_access.apply_filters(opp, {k: v for k, v in f.items()
                                              if k in opp.columns})
    opp_cols = ["opportunity_rank", "store_number", "store_name", "region_name",
                "labor_cost_per_customer", "benchmark_lcpc", "lcpc_gap",
                "opportunity_usd", "opportunity_flag"]
    st.dataframe(opp[[c for c in opp_cols if c in opp.columns]]
                 .sort_values("opportunity_rank"),
                 use_container_width=True, hide_index=True)
    total_opp = float(opp.get("opportunity_usd", pd.Series(dtype=float)).clip(lower=0).sum())
    st.metric("Total identified opportunity (period)", f"${total_opp:,.0f}")


def _daily_metric(df: pd.DataFrame, metric: str) -> pd.Series:
    """Daily series for a metric, recomputed from base sums (never average ratios)."""
    base = ["total_customers", "total_labor_cost", "total_labor_hours", "dual_customers"]
    g = df.groupby("calendar_day")[base].sum().sort_index()
    tc = g["total_customers"].replace(0, pd.NA)
    if metric == "total_customers":
        s = g["total_customers"]
    elif metric == "labor_cost_per_customer":
        s = g["total_labor_cost"] / tc
    elif metric == "labor_hours_per_customer":
        s = g["total_labor_hours"] / tc
    elif metric == "dual_customer_conversion_rate_pct":
        s = 100.0 * g["dual_customers"] / tc
    else:
        s = g["total_customers"]
    return s.astype(float).fillna(0.0).rename(metric)
