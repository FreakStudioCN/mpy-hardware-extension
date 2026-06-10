from fastapi import APIRouter, Body, Depends, HTTPException

from app import analytics, credit_store
from app.auth import require_admin

router = APIRouter()


@router.get("/v1/admin/metrics")
def metrics(_: None = Depends(require_admin)):
    return analytics.metrics_snapshot()


@router.post("/v1/admin/credits")
def set_credits(
    login: str = Body(...),
    balance: int = Body(...),
    _: None = Depends(require_admin),
):
    """Set a user's credit balance to `balance` exactly (for comping a tester/teammate
    mid-day, before the next UTC refill picks up their per-login `grant_for` override).
    404 if the login has never logged in — nothing to top up; their first login will
    create the balance at the override grant."""
    user = credit_store.get_user_by_login(login)
    if not user:
        raise HTTPException(status_code=404, detail={"error": "user_not_found", "login": login})
    return credit_store.set_balance(user, balance)
