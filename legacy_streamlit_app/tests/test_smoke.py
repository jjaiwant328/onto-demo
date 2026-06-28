"""End-to-end smoke path for the initial use case (mirrors skills/app_smoke_test)."""
from app import config, data_access, ontology_service, product_registry
from app.pages import business_view


def test_e2e_initial_use_case():
    # 1. product list loads and includes the initial product
    product = config.DEFAULT_PRODUCT
    assert product_registry.get_product(product) is not None

    # 2. ontology payload loads (classes + mappings + validation)
    classes = ontology_service.get_classes(product)
    assert {c["class"] for c in classes} >= {
        "Store", "CalendarDay", "StoreTrafficDay", "StoreLaborDay", "StoreDayEfficiency"}
    assert ontology_service.get_mappings(product)
    assert ontology_service.get_validation(product)["status"] in {"validated", "incomplete"}

    # 3. KPI view renders with expected columns
    sd = data_access.get_store_day(product)
    assert {"labor_cost_per_customer", "dual_customer_conversion_rate_pct"} <= set(sd.columns)

    # 4. one product drill-down path: filter to a store -> trend -> opportunity rank
    store = int(sd["store_number"].iloc[0])
    one = data_access.apply_filters(sd, {"store_number": [store]})
    trend = business_view._daily_metric(one, "labor_cost_per_customer")
    assert len(trend) > 0

    opp = data_access.get_opportunities(product)
    assert "opportunity_rank" in opp.columns
    assert opp[opp["store_number"] == store].shape[0] <= 1
