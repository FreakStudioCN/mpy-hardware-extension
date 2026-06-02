import hashlib
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response


ROOT = Path(__file__).resolve().parents[1]
router = APIRouter()


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
    path = ROOT / "content" / "boards" / f"{board_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail={"error": "board_not_found"})
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/v1/skills")
def skills():
    summaries = []
    for path in sorted((ROOT / "content" / "skills" / "existing").glob("*.md")):
        body = path.read_text(encoding="utf-8")
        summaries.append({
            "name": path.stem,
            "description": body.splitlines()[0].lstrip("# ").strip(),
            "body_url": f"/v1/skills/{path.stem}",
            "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
        })
    return {"version": hashlib.sha256(json.dumps(summaries, sort_keys=True).encode()).hexdigest(), "skills": summaries}


@router.get("/v1/skills/{name}")
def skill(name: str):
    path = ROOT / "content" / "skills" / "existing" / f"{name}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail={"error": "skill_not_found"})
    body = path.read_text(encoding="utf-8")
    headers = {"ETag": hashlib.sha256(body.encode()).hexdigest()}
    return Response(content=body, media_type="text/markdown; charset=utf-8", headers=headers)
