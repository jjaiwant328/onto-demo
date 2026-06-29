#!/usr/bin/env python3
"""Generate a describe_table_extended.csv for the app's "Upload CSV" schema loader.

Queries <catalog>.information_schema.columns via the Databricks SQL statement API
with LIKE filters (wildcards: * or %). Enumerates catalogs when --catalog is a
wildcard. Output columns: catalog, schema, table, column_name, data_type, comment.

Examples
--------
# one reachable schema
python scripts/generate_schema_csv.py --catalog jai_ontos --schema demo_schema --table '*' \
    --out inputs/jai_ontos_demo.csv

# every schema in a catalog
python scripts/generate_schema_csv.py --catalog jai_ontos --schema '*' --table '*' \
    --out inputs/jai_ontos_all.csv

# wildcard across catalogs, only dim_ tables
python scripts/generate_schema_csv.py --catalog 'jai_*' --schema '*' --table 'dim_*' \
    --out inputs/jai_dims.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys


def run_sql(profile: str, warehouse_id: str, statement: str) -> list[list]:
    """Execute SQL via `databricks api post /api/2.0/sql/statements` and return rows."""
    payload = json.dumps(
        {"warehouse_id": warehouse_id, "statement": statement, "wait_timeout": "50s"}
    )
    proc = subprocess.run(
        ["databricks", "api", "post", "/api/2.0/sql/statements", "--json", payload, "-p", profile],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"CLI error: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    state = data.get("status", {}).get("state")
    if state != "SUCCEEDED":
        err = data.get("status", {}).get("error", {})
        raise RuntimeError(f"SQL {state}: {err.get('message', err)}")
    return data.get("result", {}).get("data_array", []) or []


def like(pattern: str) -> str:
    """Translate * → % for SQL LIKE; empty → %."""
    p = (pattern or "").strip()
    return (p.replace("*", "%") if p else "%").replace("'", "''")


def resolve_catalogs(profile: str, warehouse_id: str, catalog: str) -> list[str]:
    if "*" in catalog or "%" in catalog:
        rows = run_sql(profile, warehouse_id, "SHOW CATALOGS")
        names = [r[0] for r in rows if r and r[0]]
        import re

        rx = re.compile("^" + re.escape(catalog).replace(r"\*", ".*").replace("%", ".*") + "$", re.I)
        return [c for c in names if rx.match(c)]
    return [catalog]


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate describe_table_extended.csv")
    ap.add_argument("--profile", default="jai-classic")
    ap.add_argument("--warehouse-id", default="bf7ffcda00a8c351")
    ap.add_argument("--catalog", required=True, help="catalog name or wildcard, e.g. jai_ontos or jai_*")
    ap.add_argument("--schema", default="*", help="schema name or wildcard (default *)")
    ap.add_argument("--table", default="*", help="table name or wildcard (default *)")
    ap.add_argument("--out", required=True, help="output CSV path, e.g. inputs/my_schema.csv")
    args = ap.parse_args()

    schema_pat = like(args.schema)
    table_pat = like(args.table)

    catalogs = resolve_catalogs(args.profile, args.warehouse_id, args.catalog)
    if not catalogs:
        print(f"No catalogs matched '{args.catalog}'.", file=sys.stderr)
        return 1

    rows_out: list[list[str]] = []
    for cat in catalogs:
        safe_cat = "".join(ch for ch in cat if ch.isalnum() or ch == "_")
        stmt = (
            "SELECT table_catalog, table_schema, table_name, column_name, "
            "full_data_type AS data_type, comment "
            f"FROM {safe_cat}.information_schema.columns "
            f"WHERE table_schema LIKE '{schema_pat}' AND table_name LIKE '{table_pat}' "
            "ORDER BY table_schema, table_name, ordinal_position LIMIT 50000"
        )
        try:
            rows = run_sql(args.profile, args.warehouse_id, stmt)
            for r in rows:
                rows_out.append([str(x) if x is not None else "" for x in r])
            print(f"{cat}: {len(rows)} columns")
        except RuntimeError as exc:
            print(f"{cat}: skipped ({exc})", file=sys.stderr)

    if not rows_out:
        print("No rows produced — check access / filters.", file=sys.stderr)
        return 1

    with open(args.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["catalog", "schema", "table", "column_name", "data_type", "comment"])
        w.writerows(rows_out)
    print(f"Wrote {len(rows_out)} rows for {len(catalogs)} catalog(s) → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
