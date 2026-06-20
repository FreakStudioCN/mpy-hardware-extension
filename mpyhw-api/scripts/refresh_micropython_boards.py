from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import recommendation_catalog as catalog


USER_AGENT = "Blockless hardware catalog refresh/1.0 (+https://blockless.ai)"


def fetch_text(url: str, timeout: int = 30) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def refresh(out_dir: Path, limit: int | None = None, sleep_seconds: float = 0.05) -> dict:
    fetched_at = datetime.now(UTC).replace(microsecond=0).isoformat()
    index_html = fetch_text(catalog.MICROPYTHON_DOWNLOAD_URL)
    index_boards = catalog.parse_download_index(index_html)
    if limit is not None:
        index_boards = index_boards[:limit]

    boards: list[dict] = []
    links_by_slug: dict[str, list[dict]] = {}
    errors: list[dict] = []

    for entry in index_boards:
        slug = entry["slug"]
        try:
            detail_html = fetch_text(entry["detail_url"])
            detail = catalog.parse_board_detail(slug, detail_html)
            board = {**entry, **{k: v for k, v in detail.items() if v not in ("", [], None)}}
            board["fetched_at"] = fetched_at
            boards.append(board)
            links_by_slug[slug] = catalog.purchase_links_for_board(board)
        except Exception as exc:
            errors.append({"slug": slug, "detail_url": entry.get("detail_url"), "error": str(exc)})
        if sleep_seconds:
            time.sleep(sleep_seconds)

    out_dir.mkdir(parents=True, exist_ok=True)
    boards_payload = {
        "source": catalog.MICROPYTHON_DOWNLOAD_URL,
        "fetched_at": fetched_at,
        "board_count": len(boards),
        "boards": boards,
    }
    links_payload = {
        "source": "MicroPython board catalog plus official/vendor-priority US purchase link policy",
        "fetched_at": fetched_at,
        "links_by_slug": links_by_slug,
    }
    manifest = {
        "source": catalog.MICROPYTHON_DOWNLOAD_URL,
        "fetched_at": fetched_at,
        "requested_count": len(index_boards),
        "board_count": len(boards),
        "error_count": len(errors),
        "errors": errors,
    }

    _write_json(out_dir / "micropython_boards.json", boards_payload)
    _write_json(out_dir / "hardware_purchase_links_us.json", links_payload)
    _write_json(out_dir / "scrape_manifest.json", manifest)
    return manifest


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=catalog.RECOMMENDATION_DIR)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--sleep", type=float, default=0.05)
    args = parser.parse_args()
    manifest = refresh(args.out_dir, limit=args.limit, sleep_seconds=args.sleep)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    if manifest["requested_count"] and manifest["error_count"] / manifest["requested_count"] > 0.05:
        raise SystemExit("too many board detail fetch/parse errors")


if __name__ == "__main__":
    main()
