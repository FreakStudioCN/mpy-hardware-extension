from fastapi import APIRouter, Depends

from app import analytics
from app.auth import require_admin

router = APIRouter()


@router.get("/v1/admin/metrics")
def metrics(_: None = Depends(require_admin)):
    return analytics.metrics_snapshot()
