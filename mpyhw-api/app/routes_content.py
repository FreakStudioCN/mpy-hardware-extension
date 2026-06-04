import hashlib
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response

from app import skill_catalog


ROOT = Path(__file__).resolve().parents[1]
router = APIRouter()


def _safe_content_path(base: Path, name: str, suffix: str) -> Path:
    root = base.resolve()
    path = (base / f"{name}{suffix}").resolve()
    if not path.is_relative_to(root):
        raise HTTPException(status_code=404, detail={"error": "content_not_found"})
    return path


@router.get("/v1/boards")
def boards():
    entries = []
    for path in sorted((ROOT / "content" / "boards").glob("*.json")):
        body = path.read_bytes()
        data = json.loads(body.decode("utf-8"))
        board_id = data.get("board_id")
        if not board_id:
            # Skip a malformed board file rather than 500 the whole listing.
            continue
        entries.append({
            "board_id": board_id,
            "display_name": data.get("display_name", board_id),
            "manufacturer": data.get("manufacturer", ""),
            "detail_url": f"/v1/boards/{board_id}",
            "detail_sha256": hashlib.sha256(body).hexdigest(),
        })
    return {"version": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(), "builtin": entries, "community": []}


@router.get("/v1/boards/{board_id}")
def board(board_id: str):
    path = _safe_content_path(ROOT / "content" / "boards", board_id, ".json")
    if not path.exists():
        raise HTTPException(status_code=404, detail={"error": "board_not_found"})
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/v1/skills")
def skills():
    summaries = []
    for name in skill_catalog.served_skill_names():
        body = skill_catalog.skill_md_path(name).read_text(encoding="utf-8")
        summaries.append({
            "name": name,
            "description": skill_catalog.skill_description(body),
            "body_url": f"/v1/skills/{name}",
            "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
        })
    return {"version": hashlib.sha256(json.dumps(summaries, sort_keys=True).encode()).hexdigest(), "skills": summaries}


@router.get("/v1/skills/{name}")
def skill(name: str):
    path = skill_catalog.skill_md_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail={"error": "skill_not_found"})
    body = path.read_text(encoding="utf-8")
    headers = {"ETag": hashlib.sha256(body.encode()).hexdigest()}
    return Response(content=body, media_type="text/markdown; charset=utf-8", headers=headers)
