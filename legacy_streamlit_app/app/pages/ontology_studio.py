"""Ontology Studio page — classes, business->physical mappings, validation."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import ontology_service


def render(selected_product: str) -> None:
    st.header("Ontology Studio")
    st.caption("The semantic adapter: ontology classes mapped onto physical "
               "columns, with validation against the serving layer.")

    classes = ontology_service.get_classes(selected_product)
    mappings = ontology_service.get_mappings(selected_product)

    st.subheader("Classes")
    st.dataframe(pd.DataFrame(classes), use_container_width=True, hide_index=True)

    st.subheader("Business → physical mapping")
    mdf = pd.DataFrame(mappings)
    if not mdf.empty:
        roles = st.multiselect("Filter by role", sorted(mdf["role"].unique()),
                               default=sorted(mdf["role"].unique()))
        st.dataframe(mdf[mdf["role"].isin(roles)], use_container_width=True, hide_index=True)

    st.subheader("Validation status")
    v = ontology_service.get_validation(selected_product)
    badge = {"validated": "✅", "incomplete": "⚠️", "no_data": "⛔", "unknown": "❓"}
    st.markdown(f"**Status:** {badge.get(v['status'], '')} `{v['status']}`"
                + (f" · {v.get('row_count')} rows" if v.get("row_count") else ""))
    vdf = pd.DataFrame(v.get("checks", []))
    if not vdf.empty:
        vdf["ok"] = vdf["ok"].map({True: "✅", False: "❌"})
        st.dataframe(vdf, use_container_width=True, hide_index=True)

    with st.expander("Assumptions (semantic adapter)"):
        for k, val in ontology_service.get_assumptions().items():
            st.markdown(f"- **{k}** — {val}")

    st.caption("OntoBricks owns these classes & mappings; see ontobricks/ and "
               "ontology/. Governed registration lives in ontos/.")
