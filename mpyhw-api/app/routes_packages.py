from fastapi import APIRouter, HTTPException

from app.models import PackageResolveRequest, PackageSearchRequest
from app.package_store import PackageStore


router = APIRouter()


def store() -> PackageStore:
    return PackageStore.default()


@router.get("/v1/packages/index")
def package_index():
    return store().index()


@router.post("/v1/packages/search")
def search_packages(request: PackageSearchRequest):
    return {"results": store().search(request.query, request.capabilities, request.limit), "cached": True}


@router.post("/v1/packages/resolve")
def resolve_packages(request: PackageResolveRequest):
    return store().resolve(request.intent, request.capabilities, request.board_id)


@router.get("/v1/packages/{name}/{version}")
def get_package(name: str, version: str):
    record = store().get_record(name, version)
    if record is None:
        raise HTTPException(status_code=404, detail={"error": "package_not_found"})
    return store()._package_record(record)


@router.get("/v1/packages/{name}/{version}/driver-context")
def get_driver_context(name: str, version: str):
    try:
        return store().get_driver_context(name, version)
    except KeyError:
        raise HTTPException(status_code=404, detail={"error": "package_not_found"})
    except ValueError:
        raise HTTPException(status_code=404, detail={"error": "driver_context_missing"})
