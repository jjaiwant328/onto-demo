"""Filter + product-selection behavior."""
from app import config, data_access, product_registry


def test_region_filter_reduces_rows():
    df = data_access.get_store_day()
    regions = data_access.distinct_values(df, "region_name")
    assert regions, "expected at least one region in seed data"
    one = data_access.apply_filters(df, {"region_name": [regions[0]]})
    assert 0 < len(one) < len(df)
    assert set(one["region_name"].unique()) == {regions[0]}


def test_store_filter_single_store():
    df = data_access.get_store_day()
    store = int(df["store_number"].iloc[0])
    sub = data_access.apply_filters(df, {"store_number": [store]})
    assert set(sub["store_number"].unique()) == {store}


def test_absent_geo_column_degrades_gracefully():
    df = data_access.get_store_day()
    # division/area are not in the model (A3) -> filtering on them is a no-op
    out = data_access.apply_filters(df, {"division_name": ["whatever"]})
    assert len(out) == len(df)
    assert data_access.distinct_values(df, "division_name") == []


def test_empty_filter_returns_all():
    df = data_access.get_store_day()
    assert len(data_access.apply_filters(df, {})) == len(df)
    assert len(data_access.apply_filters(df, {"region_name": []})) == len(df)


def test_product_selection_switches_context():
    products = product_registry.enabled_products()
    names = [p["product_name"] for p in products]
    assert config.DEFAULT_PRODUCT in names
    # selecting the product yields a non-empty serving frame
    df = data_access.get_store_day(config.DEFAULT_PRODUCT)
    assert not df.empty
