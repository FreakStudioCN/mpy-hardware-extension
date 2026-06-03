from fastapi import FastAPI

from app.routes_admin import router as admin_router
from app.health import router as health_router
from app.routes_auth import router as auth_router
from app.routes_content import router as content_router
from app.routes_credits import router as credits_router
from app.routes_packages import router as package_router
from app.routes_llm import router as llm_router
from app.routes_telemetry import router as telemetry_router
from app.routes_tools import router as tools_router


app = FastAPI(title="mpyhw-api", version="0.2.0")
app.include_router(admin_router)
app.include_router(health_router)
app.include_router(package_router)
app.include_router(content_router)
app.include_router(tools_router)
app.include_router(llm_router)
app.include_router(auth_router)
app.include_router(credits_router)
app.include_router(telemetry_router)
