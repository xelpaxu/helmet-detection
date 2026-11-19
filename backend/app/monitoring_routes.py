from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api")


class NewSession(BaseModel):
    camera: str = Field(default="Camera 01", min_length=1, max_length=120)


class Clock(BaseModel):
    started_at: datetime


class Finish(BaseModel):
    chunks: int = Field(ge=0, le=100000)
    duration_ms: float = Field(ge=0, le=86400000, allow_inf_nan=False)


class Review(BaseModel):
    review_status: Literal["new", "reviewed", "dismissed"]
    notes: str = Field(default="", max_length=4000)


def store(request):
    return request.app.state.store


def get_session(request, session_id):
    try:
        return store(request).session(session_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/monitoring")
def configuration(request: Request):
    return {"confirm_hits": 3, "missing_ms": 3000, "retention_days": store(request).retention_days,
            "max_recording_bytes": 2 * 1024**3, "max_session_ms": 86400000,
            "tracking": "session-scoped spatial association; IDs may change after occlusion or re-entry"}


@router.post("/sessions", status_code=201)
def create_session(body: NewSession, request: Request):
    return store(request).create(body.camera.strip() or "Camera 01")


@router.get("/sessions")
def list_sessions(request: Request):
    return store(request).sessions()


@router.get("/sessions/{session_id}")
def session_detail(session_id: str, request: Request):
    return get_session(request, session_id)


@router.post("/sessions/{session_id}/clock")
def session_clock(session_id: str, body: Clock, request: Request):
    get_session(request, session_id)
    if body.started_at.tzinfo is None:
        raise HTTPException(422, "Recording start time must include a timezone")
    try:
        store(request).clock(session_id, body.started_at.astimezone(timezone.utc).isoformat())
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True}


@router.put("/sessions/{session_id}/chunks/{index}")
async def upload_chunk(session_id: str, index: int, request: Request):
    get_session(request, session_id)
    if not 0 <= index <= 100000:
        raise HTTPException(422, "Invalid chunk index")
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 20 * 1024**2:
            raise HTTPException(413, "Recording chunk exceeds 20 MiB")
    if not data:
        raise HTTPException(422, "Empty recording chunk")
    try:
        await run_in_threadpool(store(request).chunk, session_id, index, bytes(data))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"saved": index}


@router.post("/sessions/{session_id}/finish")
async def finish(session_id: str, body: Finish, request: Request):
    get_session(request, session_id)
    async with request.app.state.inference_lock:
        tracker = request.app.state.trackers.get(session_id)
        if tracker:
            tracker.finish()
        else:
            store(request).end(session_id, body.duration_ms)
    try:
        return await run_in_threadpool(store(request).finalize, session_id, body.chunks, body.duration_ms)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/sessions/{session_id}/video")
def video(session_id: str, request: Request, download: bool = False):
    session = get_session(request, session_id)
    if session["recording_status"] != "ready":
        raise HTTPException(409, "Recording is not ready; stop monitoring and wait for uploads to finish")
    path = store(request).directory(session_id) / "recording.webm"
    if not path.is_file():
        raise HTTPException(404, "Recording file is missing")
    return FileResponse(path, media_type="video/webm", filename=f"session-{session_id}.webm" if download else None)


@router.get("/incidents")
def incidents(request: Request, session_id: str | None = None):
    return store(request).incidents(session_id)


@router.get("/incidents/{incident_id}")
def incident(incident_id: str, request: Request):
    try:
        return store(request).incident(incident_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.patch("/incidents/{incident_id}")
def review_incident(incident_id: str, body: Review, request: Request):
    try:
        return store(request).review(incident_id, body.review_status, body.notes)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/incidents/{incident_id}/clip")
async def clip(incident_id: str, request: Request):
    incident(incident_id, request)
    try:
        path = await run_in_threadpool(store(request).clip, incident_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return FileResponse(path, media_type="video/webm", filename=f"incident-{incident_id}.webm")


@router.get("/incidents/{incident_id}/evidence/{kind}")
def evidence(incident_id: str, kind: Literal["entry", "best", "exit"], request: Request):
    row = incident(incident_id, request)
    path = store(request).directory(row["session_id"]) / f"{row['id']}-{kind}.jpg"
    if not path.is_file():
        raise HTTPException(404, "Evidence frame is unavailable")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
