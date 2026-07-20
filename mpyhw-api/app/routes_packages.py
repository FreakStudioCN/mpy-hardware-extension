from fastapi import APIRouter, HTTPException

from app import micropython_lib_index, upypi_client
from app.models import PackageResolveRequest, PackageSearchRequest
from app.package_store import PackageStore, board_family


router = APIRouter()


def store() -> PackageStore:
    return PackageStore.default()


@router.get("/v1/packages/index")
def package_index():
    return store().index()


@router.post("/v1/packages/search")
def search_packages(request: PackageSearchRequest):
    results = store().search(
        request.query,
        request.capabilities,
        request.limit,
        board_family(request.board_id or ""),
        request.source,
    )
    return {"results": results, "cached": True}


@router.post("/v1/packages/resolve")
def resolve_packages(request: PackageResolveRequest):
    return store().resolve(request.intent, request.capabilities, request.board_id)


# Declared BEFORE /v1/packages/{name}/{version} so "upypi" is not captured as a {name}.
@router.get("/v1/packages/upypi/search")
def upypi_search(q: str = ""):
    try:
        return {"results": upypi_client.search(q), "source": "upypi"}
    except upypi_client.UpypiUnavailable:
        raise HTTPException(status_code=502, detail={"error": "upstream_unavailable", "source": "upypi"})


@router.get("/v1/packages/upypi/resolve")
def upypi_resolve(url: str):
    try:
        return upypi_client.resolve(url)
    except upypi_client.UpypiUnavailable:
        raise HTTPException(status_code=502, detail={"error": "upstream_unavailable", "source": "upypi"})


@router.get("/v1/packages/micropython-lib/search")
def micropython_lib_search(q: str = ""):
    try:
        return {"results": micropython_lib_index.search(q), "source": "micropython_lib"}
    except micropython_lib_index.MicropythonLibUnavailable:
        raise HTTPException(status_code=502, detail={"error": "upstream_unavailable", "source": "micropython_lib"})


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
