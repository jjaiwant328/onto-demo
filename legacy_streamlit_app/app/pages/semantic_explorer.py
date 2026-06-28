"""Semantic Explorer page — relationships across classes + mapped properties."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import ontology_service


def render(selected_product: str) -> None:
    st.header("Semantic Explorer")
    st.caption("Relationships across ontology classes and the measures bound to them.")

    rels = ontology_service.get_relationships(selected_product)
    st.subheader("Relationships (object properties)")
    if rels:
        rdf = pd.DataFrame(rels)[["from", "predicate", "to"]]
        st.dataframe(rdf, use_container_width=True, hide_index=True)
        # lightweight text graph
        st.markdown("**Graph**")
        for r in rels:
            st.markdown(f"- `{r['from']}` —*{r['predicate']}*→ `{r['to']}`")
    else:
        st.info("No object properties parsed from the ontology.")

    st.subheader("Semantic measures")
    mdf = pd.DataFrame(ontology_service.get_measures(selected_product))
    if not mdf.empty:
        kind = st.radio("Show", ["all", "base", "derived"], horizontal=True)
        view = mdf if kind == "all" else mdf[mdf["type"] == kind]
        st.dataframe(view, use_container_width=True, hide_index=True)
        st.caption("Formulas are the single source of truth "
                   "(ontology/semantic_measures.yaml). SQL views and seed data "
                   "implement these exact definitions.")

    st.subheader("Class → property drill-down")
    maps = pd.DataFrame(ontology_service.get_mappings(selected_product))
    if not maps.empty:
        cls = st.selectbox("Class", sorted(maps["class"].unique()))
        st.dataframe(maps[maps["class"] == cls][["property", "role", "source", "column"]],
                     use_container_width=True, hide_index=True)
