"""Shared test setup: force seed mode, ensure repo on path + seed data present."""
import os
import sys
from pathlib import Path

os.environ.setdefault("RT_ONTO_DATA_MODE", "seed")

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pytest  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _ensure_seed():
    seed = REPO_ROOT / "app" / "seed" / "store_day.parquet"
    if not seed.exists():
        from app.seed import generate_seed
        generate_seed.main()
    yield
