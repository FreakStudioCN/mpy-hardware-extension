from fastapi import APIRouter, Depends

from app import credit_store
from app.auth import get_current_user

router = APIRouter()


@router.get("/v1/credits")
def credits(user: dict = Depends(get_current_user)):
    """Current balance for display. Ensures the daily grant on first read of a day."""
    return credit_store.ensure_daily_grant(user, credit_store.grant_for(user))
