"""Camera-frame inference API. Run from backend: python -m uvicorn app.main:app."""
import asyncio
from contextlib import asynccontextmanager
from io import BytesIO
import logging
import os
from pathlib import Path
import time
import warnings
import json
import math

from app.monitoring import Store, Tracker, iou, normalized_coordinates, rider_match
from app.monitoring_routes import router as monitoring_router

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 4096 * 4096
ORIGINS = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if s.strip()]
HELMET_LABELS = {"with_helmet": "helmet", "without_helmet": "no_helmet"}
# Ultralytics patches Pillow's opener to load optional HEIF codecs on decode errors.
open_frame = Image.open


class InvalidFrame(ValueError):
    pass


class Detector:
    def load(self, model_path=None):
        import torch

        path = Path(model_path or os.getenv("MODEL_PATH", "model/best.pt"))
        if not path.is_absolute():
            path = ROOT / path
        if not path.is_file():
            raise FileNotFoundError(f"Model checkpoint not found: {path}")
        self.device = os.getenv("MODEL_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
        self.use_half = self.device.startswith("cuda") and torch.cuda.is_available()
        self.is_yolo = path.suffix.lower() == ".pt"
        if self.is_yolo:
            os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / ".cache"))
            os.environ.setdefault("YOLO_AUTOINSTALL", "false")
            from ultralytics import YOLO

            self.name = "YOLOv8"
            self.model = YOLO(str(path), task="detect")
            names = [name for _, name in sorted(self.model.names.items())]
        else:
            from rfdetr import RFDETRSmall

            self.name = "RF-DETR Small"
            self.model = RFDETRSmall.from_checkpoint(str(path), device=self.device)
            names = self.model.class_names
        self.classes = []
        for name in names:
            label = "_".join(name.lower().split()).replace("-", "_")
            self.classes.append(HELMET_LABELS.get(label, label))
        if not self.classes:
            raise RuntimeError("Checkpoint is missing class labels")
        # Warm up before reporting readiness; never accept frames with a broken model.
        warmup = Image.new("RGB", (640, 640))
        try:
            if self.use_half and not self.is_yolo:
                self.model.inference(compile=False, dtype=torch.float16)
            self.infer(warmup, 0.5)
        except Exception:
            if not self.use_half:
                raise
            LOGGER.warning("FP16 warmup failed for %s; retrying in FP32", self.name, exc_info=True)
            self.use_half = False
            if self.is_yolo:
                self.model = YOLO(str(path), task="detect")
            else:
                self.model.remove_optimized_model()
            self.infer(warmup, 0.5)
        LOGGER.info("Loaded %s from %s on %s with classes %s", self.name, path.name, self.device, self.classes)

    def infer(self, image, threshold):
        if self.is_yolo:
            predictions = self.model.predict(image, imgsz=640, conf=threshold, device=self.device,
                                             half=self.use_half, stream=True, verbose=False)
            try:
                result = next(predictions)
            finally:
                predictions.close()
            boxes = result.boxes.cpu().numpy()
            return boxes.xyxy, boxes.conf, boxes.cls
        result = self.model.predict(image, threshold=threshold, include_source_image=False)
        return result.xyxy, result.confidence, result.class_id

    def predict(self, data: bytes, threshold: float, *, small_objects: bool = False):
        if not data or len(data) > MAX_BYTES:
            raise InvalidFrame("Frame must contain 1 byte to 5 MiB")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with open_frame(BytesIO(data)) as source:
                    if source.format not in ("JPEG", "PNG", "WEBP"):
                        raise InvalidFrame("Use JPEG, PNG, or WebP")
                    if source.width * source.height > MAX_PIXELS:
                        raise InvalidFrame("Frame exceeds 4096 x 4096 pixel budget")
                    image = ImageOps.exif_transpose(source).convert("RGB")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise InvalidFrame("Invalid or oversized image") from exc
        width, height = image.size
        start = time.perf_counter()
        regions = [(0, 0, width, height)]
        if small_objects and min(width, height) >= 2:
            # Keep 20% overlap on each axis so subjects near a seam can appear
            # intact in at least one crop.
            crop_width, crop_height = math.ceil(width * 0.6), math.ceil(height * 0.6)
            if crop_width < width and crop_height < height:
                regions.extend(
                    (x, y, x + crop_width, y + crop_height)
                    for y in (0, height - crop_height)
                    for x in (0, width - crop_width)
                )
        candidates = []
        for left, top, right, bottom in regions:
            region = image if (left, top, right, bottom) == regions[0] else image.crop((left, top, right, bottom))
            boxes, scores, classes = self.infer(region, threshold)
            for box, score, class_id in zip(boxes, scores, classes):
                cid = int(class_id)
                if not 0 <= cid < len(self.classes):
                    continue
                x1, y1, x2, y2 = (float(v) for v in box)
                x1, x2 = max(left, x1 + left), min(right, x2 + left)
                y1, y2 = max(top, y1 + top), min(bottom, y2 + top)
                if x2 > x1 and y2 > y1:
                    candidates.append(((x1, y1, x2, y2), float(score), cid))
        if len(regions) > 1:
            merged = []
            for box, score, cid in sorted(candidates, key=lambda item: item[1], reverse=True):
                if not any(cid == other_cid and iou(box, other_box) > 0.5 for other_box, _, other_cid in merged):
                    merged.append((box, score, cid))
            candidates = merged
        elapsed = (time.perf_counter() - start) * 1000
        detections = []
        for (x1, y1, x2, y2), score, cid in candidates:
            detections.append({"class_id": cid, "label": self.classes[cid], "confidence": score,
                               "box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                               "normalized_box": {"x1": x1 / width, "y1": y1 / height,
                                                  "x2": x2 / width, "y2": y2 / height}})
        return {"width": width, "height": height, "inference_ms": round(elapsed, 2), "detections": detections}


def filter_rider_detections(detections):
    riders = [(i, normalized_coordinates(hit)) for i, hit in enumerate(detections) if hit["label"] == "bike_with_rider"]
    return [hit for hit in detections if hit["label"] != "no_helmet"
            or rider_match(normalized_coordinates(hit), riders) is not None]


RIDER_CLASSES = {"bike_with_rider", "no_helmet"}
RIDER_MODEL_ERROR = "Simulation needs a model with motorcycle rider and no-helmet classes. Check RIDER_MODEL_PATH in the backend."


def load_rider_detector(primary):
    if RIDER_CLASSES <= set(primary.classes):
        return primary
    detector = Detector()
    detector.load(os.getenv("RIDER_MODEL_PATH", "model/RF-DETR_Small.pth"))
    if not RIDER_CLASSES <= set(detector.classes):
        raise ValueError(RIDER_MODEL_ERROR)
    return detector


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = Store(Path(os.getenv("MONITOR_DATA_DIR", str(ROOT / "data"))), int(os.getenv("RETENTION_DAYS", "7")))
    await run_in_threadpool(app.state.store.recover)
    app.state.trackers = {}
    app.state.detector = Detector()
    app.state.inference_lock = asyncio.Lock()
    app.state.waiting_feeds = {}
    await run_in_threadpool(app.state.detector.load)
    # Warm the simulation model before accepting WebSockets so model loading
    # cannot consume the client's connection timeout.
    try:
        app.state.rider_detector = await run_in_threadpool(load_rider_detector, app.state.detector)
    except Exception:
        LOGGER.exception("Could not load the rider detection model")
        app.state.rider_detector = None
    primary_id = "yolo" if app.state.detector.is_yolo else "rf-detr"
    app.state.camera_models = {primary_id: app.state.detector}
    if app.state.rider_detector is not None and app.state.rider_detector is not app.state.detector:
        if app.state.detector.is_yolo:
            app.state.camera_models["rf-detr"] = app.state.rider_detector
        else:
            app.state.camera_models["rider"] = app.state.rider_detector
    if not app.state.detector.is_yolo:
        try:
            yolo = Detector()
            await run_in_threadpool(yolo.load, "model/best.pt")
            app.state.camera_models["yolo"] = yolo
        except Exception:
            LOGGER.exception("Could not load the optional YOLO camera model")
    yield
    for tracker in list(app.state.trackers.values()):
        tracker.finish("server_shutdown")


app = FastAPI(title="Helmet Detection API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST", "PUT", "PATCH"], allow_headers=["*"])
app.include_router(monitoring_router)


@app.get("/health")
async def health():
    return {"status": "ready", "device": app.state.detector.device, "classes": app.state.detector.classes,
            "simulation_ready": app.state.rider_detector is not None,
            "camera_models": [{"id": key, "name": model.name, "classes": model.classes,
                               "default": model is app.state.detector}
                              for key, model in app.state.camera_models.items()]}


@app.get("/api/model")
async def model_info():
    return {"name": app.state.detector.name, "classes": app.state.detector.classes,
            "device": app.state.detector.device, "max_frame_bytes": MAX_BYTES,
            "box_format": "xyxy", "coordinates": "original image pixels; normalized_box in [0,1]",
            "websocket": "/ws/detect", "protocol": "Send one binary image; await one JSON result before sending the next"}


@app.post("/api/detect")
async def detect(file: UploadFile = File(...), threshold: float = Query(0.5, ge=0.01, le=1.0)):
    try:
        data = await file.read(MAX_BYTES + 1)
    finally:
        await file.close()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Frame exceeds 5 MiB")
    if app.state.inference_lock.locked():
        raise HTTPException(429, "Detector busy; retry after the current frame")
    async with app.state.inference_lock:
        try:
            return await run_in_threadpool(app.state.detector.predict, data, threshold)
        except InvalidFrame as exc:
            raise HTTPException(422, str(exc)) from exc


@app.websocket("/ws/detect")
async def stream(websocket: WebSocket, threshold: float = Query(0.5, ge=0.01, le=1.0),
                 session_id: str | None = None, small_objects: bool = False, riders_only: bool = False,
                 model: str | None = None):
    origin = websocket.headers.get("origin")
    if origin and origin not in ORIGINS:
        await websocket.close(code=1008)
        return
    if model is not None:
        detector = app.state.camera_models.get(model)
        if detector is None:
            await websocket.accept()
            await websocket.send_json({"type": "error", "code": "model_unavailable",
                                       "message": "The selected camera model is unavailable on this backend."})
            await websocket.close()
            return
    elif riders_only:
        detector = app.state.rider_detector
    else:
        detector = app.state.detector
    if riders_only and (detector is None or (model is not None and not RIDER_CLASSES <= set(detector.classes))):
        await websocket.accept()
        await websocket.send_json({"type": "error", "code": "rider_model_unavailable",
                                   "message": RIDER_MODEL_ERROR})
        await websocket.close()
        return
    tracker = None
    if session_id:
        try:
            session = app.state.store.session(session_id)
        except KeyError:
            await websocket.close(code=1008)
            return
        if session["status"] != "active" or session_id in app.state.trackers:
            await websocket.close(code=1008)
            return
        tracker = Tracker(app.state.store, session_id)
        app.state.trackers[session_id] = tracker
    await websocket.accept()
    frame_id = 0
    metadata = None
    last_ms, last_index = -1, 0
    last_frame_wall = time.monotonic()
    waiting_feeds = app.state.waiting_feeds
    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=5)
            except asyncio.TimeoutError:
                if tracker:
                    tracker.expire(last_ms + (time.monotonic() - last_frame_wall) * 1000)
                continue
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is None:
                if tracker:
                    try:
                        incoming = json.loads(message.get("text", ""))
                        ms, index = incoming["captured_ms"], incoming["frame_index"]
                        if incoming.get("type") != "frame" or type(ms) not in (int, float) or not math.isfinite(ms) or not last_ms < ms <= 86400000 or type(index) is not int or index <= last_index:
                            raise ValueError("Invalid frame metadata")
                        metadata = {"captured_ms": ms, "frame_index": index}
                        continue
                    except (ValueError, KeyError, TypeError):
                        metadata = None
                await websocket.send_json({"type": "error", "code": "invalid_frame", "message": "Send a binary JPEG, PNG, or WebP frame"})
                continue
            frame_id += 1
            frame_metadata, metadata = metadata, None
            if tracker and frame_metadata is None:
                await websocket.send_json({"type": "error", "code": "invalid_frame", "message": "Send capture metadata before each binary frame"})
                continue
            now = time.monotonic()
            for feed, deadline in list(waiting_feeds.items()):
                if deadline < now:
                    waiting_feeds.pop(feed)
            # Reserve turns for competing feeds without retaining their frame data.
            next_feed = next(iter(waiting_feeds), websocket)
            if app.state.inference_lock.locked() or next_feed is not websocket:
                waiting_feeds[websocket] = now + 0.3
                await websocket.send_json({"type": "error", "frame_id": frame_id, "code": "busy", "message": "Retry with the latest frame"})
                continue
            waiting_feeds.pop(websocket, None)
            failure_code = "inference_failed"
            try:
                async with app.state.inference_lock:
                    if tracker and app.state.store.session(session_id)["status"] != "active":
                        await websocket.close(code=1000)
                        break
                    result = await run_in_threadpool(detector.predict, data, threshold, small_objects=small_objects)
                    if riders_only:
                        result["detections"] = filter_rider_detections(result["detections"])
                    if tracker:
                        failure_code = "tracking_failed"
                        last_ms, last_index = frame_metadata["captured_ms"], frame_metadata["frame_index"]
                        last_frame_wall = time.monotonic()
                        result["detections"] = await run_in_threadpool(tracker.update, result["detections"], last_ms, last_index, data)
                        result.update(frame_metadata)
            except InvalidFrame as exc:
                await websocket.send_json({"type": "error", "frame_id": frame_id, "code": "invalid_frame", "message": str(exc)})
                continue
            except Exception:
                LOGGER.exception("%s: model=%s session=%s frame=%s",
                                 failure_code, detector.name, session_id, frame_id)
                message = "Frame inference failed" if failure_code == "inference_failed" else "Could not update rider tracking or save its evidence."
                await websocket.send_json({"type": "error", "frame_id": frame_id, "code": failure_code, "message": message})
                continue
            await websocket.send_json({"type": "detections", "frame_id": frame_id, **result})
    except WebSocketDisconnect:
        pass
    finally:
        waiting_feeds.pop(websocket, None)
        if tracker:
            tracker.finish("disconnected")
            app.state.trackers.pop(session_id, None)
