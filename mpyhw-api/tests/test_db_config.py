import pytest

from app import db


def test_database_url_is_required(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="DATABASE_URL is required"):
        db._database_url()


def test_sqlite_database_url_is_rejected(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///tmp/test.db")

    with pytest.raises(RuntimeError, match="must be a postgres"):
        db._database_url()
