"""Product registry loading + governance rules."""
from app import config, product_registry

EXPECTED_COLS = {
    "product_name", "display_name", "domain", "business_outcome",
    "serving_object_name", "ontology_status", "contract_status",
    "app_enabled", "owner", "tags",
}


def test_registry_loads_at_least_one_product():
    products = product_registry.load_products()
    assert len(products) >= 1


def test_registry_has_expected_columns():
    p = product_registry.load_products()[0]
    assert EXPECTED_COLS.issubset(set(p)), EXPECTED_COLS - set(p)


def test_initial_product_present_and_enabled():
    p = product_registry.get_product(config.DEFAULT_PRODUCT)
    assert p is not None
    assert p["app_enabled"] is True


def test_all_product_names_jai_prefixed():
    for p in product_registry.load_products():
        assert p["product_name"].startswith("jai_"), p["product_name"]


def test_get_unknown_product_returns_none():
    assert product_registry.get_product("jai_does_not_exist") is None
