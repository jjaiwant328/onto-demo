"""Data Products page — list governed products with status/owner/domain/contract."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import product_registry


def render(selected_product: str) -> None:
    st.header("Data Products")
    st.caption("Governed products from the registry. The app is product-driven — "
               "add registry rows to expose more products without code changes.")

    products = product_registry.load_products()
    if not products:
        st.warning("No products registered. Check ontology/data_products.yaml.")
        return

    df = pd.DataFrame(products)
    show_cols = ["product_name", "display_name", "domain", "maturity",
                 "ontology_status", "contract_status", "app_enabled", "owner"]
    show_cols = [c for c in show_cols if c in df.columns]
    st.dataframe(df[show_cols], use_container_width=True, hide_index=True)

    prod = product_registry.get_product(selected_product)
    if not prod:
        return

    st.subheader(f"Selected: {prod.get('display_name')}")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Domain", prod.get("domain", "—"))
    c2.metric("Maturity", prod.get("maturity", "—"))
    c3.metric("Ontology", prod.get("ontology_status", "—"))
    c4.metric("Contract", prod.get("contract_status", "—"))

    st.markdown(f"**Outcome:** {prod.get('business_outcome', '')}")
    st.markdown(f"**Serving object:** `{prod.get('serving_object_name')}`")
    if prod.get("kpis"):
        st.markdown("**KPIs:** " + ", ".join(
            k if isinstance(k, str) else k.get("name", "") for k in prod["kpis"]))
    if prod.get("source_tables"):
        with st.expander("Source lineage"):
            for t in prod["source_tables"]:
                st.markdown(f"- `{t}`")
