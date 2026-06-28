"""RT_onto_demo — ontology-driven app for Store Traffic & Labor Efficiency.

Four sections: Data Products, Ontology Studio, Semantic Explorer, Business View.
Product-driven (reads the registry), starts with one product, designed for many.

Run:  streamlit run app/app.py      (seed mode by default)
      RT_ONTO_DATA_MODE=warehouse streamlit run app/app.py
"""
from __future__ import annotations

import sys
from pathlib import Path

# make the `app` package importable when run as a top-level Streamlit script
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import streamlit as st  # noqa: E402

from app import config, product_registry  # noqa: E402
from app.pages import (  # noqa: E402
    business_view,
    data_products,
    ontology_studio,
    semantic_explorer,
)

st.set_page_config(page_title=config.APP_NAME, layout="wide", page_icon="🏪")

SECTIONS = {
    "Data Products": data_products.render,
    "Ontology Studio": ontology_studio.render,
    "Semantic Explorer": semantic_explorer.render,
    "Business View": business_view.render,
}


def main() -> None:
    st.title("🏪 RT_onto_demo")
    st.caption("Ontology-driven data products · OntoBricks + Ontos patterns")

    with st.sidebar:
        st.markdown("## Navigation")
        mode_badge = "🌱 seed (offline)" if config.is_seed_mode() else "🛢️ warehouse"
        st.caption(f"Data mode: **{mode_badge}**")

        products = product_registry.enabled_products()
        if not products:
            st.error("No enabled products in the registry.")
            st.stop()
        labels = {p["product_name"]: p.get("display_name", p["product_name"])
                  for p in products}
        names = list(labels)
        default_idx = names.index(config.DEFAULT_PRODUCT) if config.DEFAULT_PRODUCT in names else 0
        selected_product = st.selectbox(
            "Data product", names, index=default_idx,
            format_func=lambda n: labels.get(n, n))

        section = st.radio("Section", list(SECTIONS))

        if config.is_seed_mode():
            st.info("Showing **synthetic demo data**. Switch to warehouse mode for "
                    "governed serving views.")

    SECTIONS[section](selected_product)


if __name__ == "__main__":
    main()
