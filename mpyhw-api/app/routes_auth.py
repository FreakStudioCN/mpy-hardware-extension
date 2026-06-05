from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from app.auth import mint_session, verify_github_token

router = APIRouter()


@router.post("/v1/auth/github")
async def auth_github(request: Request):
    """Verify a GitHub access token and mint a session JWT keyed to the user."""
    body = await request.json()
    access_token = body.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail={"error": "missing_access_token"})
    # verify_github_token does blocking I/O (urlopen) plus retry sleeps — run it off
    # the event loop so a slow/flaky GitHub can't stall every other request.
    user = await run_in_threadpool(verify_github_token, access_token)
    return {"token": mint_session(user), "login": user.get("login")}
