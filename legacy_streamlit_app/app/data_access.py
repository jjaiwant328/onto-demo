"""Data access layer for RT_onto_demo.

One interface, two backends:
  * seed mode      -> read labeled synthetic parquet from app/seed/
  * warehouse mode -> query the jai_ serving views via databricks-sql-connector

The app NEVER recomputes KPIs. Both backends expose the same columns produced by
sql/01..03 (and the seed generator mirrors those exact formulas).
"""
from __future__ import annotations

import functools
from pathlib import Path

import pandas as pd

from . import config


# ---- warehouse backend -------------------------------------------------------
def _sql(query: str) -> pd.DataFrame:
    """Run a query on the SQL warehouse.

    Uses the databricks-sql-connector when a PAT (DATABRICKS_TOKEN) is set;
    otherwise falls back to the Databricks SDK statement-execution API, which
    works with OAuth/CLI profile auth (no token required) — handy for local runs
    and Databricks Apps service principals.
    """
    if config.DATABRICKS_TOKEN and config.DATABRICKS_HOST:
        from databricks import sql  # lazy import; seed mode needs no driver

        with sql.connect(
            server_hostname=config.DATABRICKS_HOST.replace("https://", ""),
            http_path=config.HTTP_PATH,
            access_token=config.DATABRICKS_TOKEN,
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(query)
                cols = [c[0] for c in cur.description]
                return pd.DataFrame(cur.fetchall(), columns=cols)

    return _sql_via_sdk(query)


def _sql_via_sdk(query: str) -> pd.DataFrame:
    from databricks.sdk import WorkspaceClient  # lazy import

    # No-arg resolves auth in this order: env (HOST/TOKEN) -> DATABRICKS_CONFIG_PROFILE
    # -> default profile -> in-app service-principal creds (Databricks Apps runtime).
    w = WorkspaceClient()
    resp = w.statement_execution.execute_statement(
        warehouse_id=config.WAREHOUSE_ID, statement=query, wait_timeout="50s",
    )
    if resp.status and resp.status.state and resp.status.state.value != "SUCCEEDED":
        raise RuntimeError(f"SQL failed: {resp.status.error}")
    schema_cols = resp.manifest.schema.columns if resp.manifest else []
    cols = [c.name for c in schema_cols]
    rows = resp.result.data_array if resp.result and resp.result.data_array else []
    df = pd.DataFrame(rows, columns=cols)
    # SDK returns all cells as strings — coerce using the manifest types
    for c in schema_cols:
        t = (c.type_name.value if hasattr(c.type_name, "value") else str(c.type_name)).upper()
        if t in {"INT", "BIGINT", "SMALLINT", "TINYINT", "LONG"}:
            df[c.name] = pd.to_numeric(df[c.name], errors="coerce").astype("Int64")
        elif t in {"DECIMAL", "DOUBLE", "FLOAT"}:
            df[c.name] = pd.to_numeric(df[c.name], errors="coerce")
        elif t in {"DATE", "TIMESTAMP"}:
            df[c.name] = pd.to_datetime(df[c.name], errors="coerce")
        elif t == "BOOLEAN":
            df[c.name] = df[c.name].map({"true": True, "false": False})
    return df


# ---- seed backend ------------------------------------------------------------
def _seed(name: str) -> pd.DataFrame:
    path = config.SEED_DIR / f"{name}.parquet"
    if not path.exists():
        raise FileNotFoundError(
            f"Seed file {path} missing. Run: python app/seed/generate_seed.py"
        )
    return pd.read_parquet(path)


@functools.lru_cache(maxsize=8)
def _load(kind: str) -> pd.DataFrame:
    """kind in {store_day, summary, opportunities}."""
    if config.is_seed_mode():
        return _seed(kind)
    return _sql(f"SELECT * FROM {config.SERVING[kind]}")


def clear_cache() -> None:
    _load.cache_clear()


# ---- public API (product-aware; today one product, designed for many) --------
def get_store_day(product: str = config.DEFAULT_PRODUCT) -> pd.DataFrame:
    return _load("store_day").copy()


def get_efficiency_summary(product: str = config.DEFAULT_PRODUCT) -> pd.DataFrame:
    return _load("summary").copy()


def get_opportunities(product: str = config.DEFAULT_PRODUCT) -> pd.DataFrame:
    return _load("opportunities").copy()


# ---- filter helpers (null/absent-geo tolerant; see A3) -----------------------
def distinct_values(df: pd.DataFrame, column: str) -> list:
    if column not in df.columns:
        return []
    vals = df[column].dropna().unique().tolist()
    return sorted(vals)


def apply_filters(df: pd.DataFrame, filters: dict) -> pd.DataFrame:
    out = df
    for col, selected in (filters or {}).items():
        if not selected or col not in out.columns:
            continue
        if isinstance(selected, (list, tuple, set)):
            out = out[out[col].isin(list(selected))]
        else:
            out = out[out[col] == selected]
    return out
