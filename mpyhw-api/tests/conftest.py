import pytest


@pytest.fixture(autouse=True)
def _credit_env(tmp_path, monkeypatch):
    """Point the credit store at a throwaway DB and pin the JWT secret per test."""
    monkeypatch.setenv("MPYHW_CREDIT_DB", str(tmp_path / "credits.db"))
    monkeypatch.setenv("MPYHW_JWT_SECRET", "test-secret")
    yield
