#!/usr/bin/env python3
"""Snapshot the real mpyhw-api catalog into static fixtures for the offline E2E demo.

Why this exists
---------------
The offline demo (`npm run demo:e2e`) runs the *real* six-stage deterministic
pipeline with no backend, no API keys and no board attached. To do that it needs
the same package catalog, board profiles and driver contexts the production API
serves. Rather than re-implement (and drift from) the ingest/normalisation logic
in `mpyhw-api/app/package_store.py`, we import that store directly and dump its
already-normalised records to JSON. The offline TypeScript client then does the
same ranking over this real snapshot.

The only thing ported to TypeScript is the small, stable ranking function
(`_ranked`/`resolve`). `demo/fixtures/resolve-golden.json` captures the Python
`resolve()` output for the demo intents so the TS port can be checked against the
source of truth (see `test/offline-ranking.test.ts`).

Run from the extension dir:  python3 demo/build-fixtures.py
(Reads ../mpyhw-api/content ; writes demo/fixtures/.)
"""
import json
import shutil
import sys
import types
from pathlib import Path

EXT_DIR = Path(__file__).resolve().parents[1]
API_DIR = EXT_DIR.parent / "mpyhw-api"
OUT = EXT_DIR / "demo" / "fixtures"

# The store validates driver contexts against a JSON schema at serve time using
# `jsonschema`. That dependency is irrelevant to a catalog snapshot, so stub the
# module before import to keep this script dependency-free (stdlib only).
_stub = types.ModuleType("app.schema_validate")
_stub.validate_driver_context = lambda ctx: []  # type: ignore[attr-defined]
sys.modules["app.schema_validate"] = _stub

sys.path.insert(0, str(API_DIR))
from app.package_store import PackageStore  # noqa: E402

# Demo scenarios. Capabilities mirror what the extension's `extractCapabilities`
# (src/core/capabilities.ts) derives for each intent, so the captured golden
# matches what the TS pipeline actually asks resolve() for.
DEMO_SCENARIOS = [
    {
        "intent": "温度超过30度就点亮LED",
        "capabilities": ["temperature_sensing", "digital_output"],
        "board_id": "esp32-s3-devkitc-1",
    },
    {
        "intent": "turn on the LED when temperature is over 30",
        "capabilities": ["temperature_sensing", "digital_output"],
        "board_id": "esp32-s3-devkitc-1",
    },
    {
        "intent": "blink the onboard LED",
        "capabilities": ["digital_output"],
        "board_id": "rpi-pico-w",
    },
]

BOARDS = ["esp32-s3-devkitc-1", "esp32-c3-devkitm-1", "rpi-pico-w"]


def main() -> None:
    store = PackageStore.default()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "boards").mkdir(exist_ok=True)
    (OUT / "driver-contexts").mkdir(exist_ok=True)

    # 1) Full normalised catalog (drives offline ranking).
    (OUT / "catalog.json").write_text(
        json.dumps(store.records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"catalog.json: {len(store.records)} records")

    # 2) Board profiles — /v1/boards/{id} returns the raw content file verbatim.
    src_boards = API_DIR / "content" / "boards"
    for board_id in BOARDS:
        src = src_boards / f"{board_id}.json"
        if src.exists():
            shutil.copyfile(src, OUT / "boards" / f"{board_id}.json")
            print(f"board: {board_id}")

    # 3) Driver contexts for every record that resolves one (real serve output).
    dc_count = 0
    for record in store.records:
        name, version = record["name"], record["version"]
        try:
            ctx = store.get_driver_context(name, version)
        except (KeyError, ValueError):
            continue
        safe = f"{name}@{version}".replace("/", "_")
        (OUT / "driver-contexts" / f"{safe}.json").write_text(
            json.dumps(ctx, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        dc_count += 1
    print(f"driver-contexts: {dc_count}")

    # 4) Golden resolve() outputs — the oracle the TS ranking is tested against.
    golden = []
    for sc in DEMO_SCENARIOS:
        res = store.resolve(sc["intent"], sc["capabilities"], sc["board_id"])
        golden.append({**sc, "expected": res})
        sel = res.get("selected") or {}
        print(f"resolve {sc['intent'][:24]!r} -> {sel.get('name')}@{sel.get('version')}")
    (OUT / "resolve-golden.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
