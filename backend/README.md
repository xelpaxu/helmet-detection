# Helmet Watch backend

Python 3.10+ / FastAPI / YOLOv8 / RF-DETR Small / SQLite / PyAV. The default checkpoint is `model/best.pt` for helmet and no-helmet detection. If the main checkpoint lacks the motorcycle rider class, the backend warms up `model/RF-DETR_Small.pth` at startup so it is ready for simulation.

## Setup (PowerShell, from repository root)

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python run.py
```

The existing `.venv` can be reused. Restart an already running backend to load code changes. API: http://127.0.0.1:8000; interactive docs: http://127.0.0.1:8000/docs. Startup loads and warms the model before readiness. Use **one worker and one backend process per data directory**. Shutdown: Ctrl+C.

CUDA is selected when the installed PyTorch build supports it, otherwise CPU. Set `MODEL_DEVICE=cpu` or `cuda` to override. CUDA uses FP16 when the checkpoint passes warmup in half precision. CPU performance limits tracking of fast traffic; smooth overlay animation does not add model observations.

Process variables (the `.env.example` file is a reference, not auto-loaded):

| Variable | Default | Meaning |
| --- | --- | --- |
| MODEL_PATH | model/best.pt | Absolute path or relative to backend. Use `.pt` for YOLO or `.pth` for RF-DETR. |
| RIDER_MODEL_PATH | model/RF-DETR_Small.pth | Simulation fallback checkpoint with `bike_with_rider` and `no_helmet` classes. |
| MODEL_DEVICE | auto | CPU or CUDA |
| ALLOWED_ORIGINS | http://localhost:3000,http://127.0.0.1:3000 | Exact browser origins |
| MONITOR_DATA_DIR | backend/data | SQLite and evidence root; relative overrides resolve from process cwd |
| RETENTION_DAYS | 7 | Remove expired sessions and evidence on startup; 0 disables cleanup |

The server binds to localhost and has no authentication. This is a local monitoring implementation; remote access needs access controls and HTTPS.

## Inference APIs

- `GET /health` lists available `camera_models` and simulation readiness. `GET /api/model` describes the default model.
- `POST /api/detect?threshold=0.5`: multipart image field `file`; detection only, no incident record.
- `WS /ws/detect?threshold=0.5`: legacy binary-image inference, no incident record.
- `WS /ws/detect?threshold=0.5&session_id=<id>`: tracked monitoring. Before each binary JPEG/PNG/WebP, send JSON `{"type":"frame","captured_ms":1234.5,"frame_index":7}`. Offsets and indexes must increase. Only one WebSocket may own a session, and only active sessions accept new frames.
- Add `riders_only=true` for simulation. The server filters out no-helmet detections without a corresponding motorcycle rider before tracking and incident creation.
- Add `model=<id>` to select a model from `camera_models` for a camera connection.

Keep one frame in flight. Success returns `type=detections`, source dimensions, `inference_ms`, detections, and capture metadata. Tracked detections include `track_id`, `incident_id` when confirmed, and `tracking_state`. Pixel `box` and normalized `normalized_box` describe the source image. Busy requests return HTTP 429 or a WebSocket `busy` error; send a new current frame after a short delay. Invalid images return HTTP 422 / WebSocket errors; oversized HTTP images return 413. Images: 5 MiB / 16,777,216 pixel maximum.

## Monitoring and evidence APIs

- `GET /api/monitoring`: confirmation, gap tolerance, limits, retention.
- `POST /api/sessions` with `{camera}`; `GET /api/sessions`; `GET /api/sessions/{id}`.
- `POST /api/sessions/{id}/clock` with timezone-aware `{started_at}` before the first detection frame. This is the browser recording start's wall-clock anchor.
- `PUT /api/sessions/{id}/chunks/{index}`: raw MediaRecorder WebM chunks, sequential indexes starting at 0. Identical retries are idempotent. 20 MiB/chunk; 2 GiB/session.
- `POST /api/sessions/{id}/finish` with `{chunks,duration_ms}`: closes tracks, verifies upload count, combines chunks, and remuxes WebM without re-encoding to provide duration and seek indexes. Zero-chunk sessions are marked unavailable. Failed finalization preserves uploaded chunks for recovery.
- `GET /api/sessions/{id}/video`: finalized WebM with HTTP range support; `?download=true` downloads it.
- `GET /api/incidents?session_id=<optional>`; `GET /api/incidents/{id}`.
- `PATCH /api/incidents/{id}` with `{review_status: "new"|"reviewed"|"dismissed", notes}`.
- `GET /api/incidents/{id}/evidence/entry|best|exit`: saved JPEG frames.
- `GET /api/incidents/{id}/clip`: downloadable WebM interval, up to two seconds before entry and after last seen. Available after recording finalization; generated on demand using PyAV/libvpx and cached locally.

Lists currently return the latest 500 sessions and 2,000 incidents. Filtering and CSV export occur in the frontend. Session end bounds do not replace an incident's last-seen timestamp.

## Tracking semantics

The tracker suppresses strongly overlapping duplicate predictions and greedily associates detections using normalized box overlap/center distance. Helmet/no-helmet labels share head tracks; bikes have separate tracks. Three consecutive no-helmet observations confirm an incident. A missed observation or helmet label resets an unconfirmed streak. Once confirmed, the incident follows the subject until its track closes. Missing tracks remain eligible for association for 3 seconds; first/last seen always refer to actual observed captures, never the expiry timer.

This is spatial tracking, not biometric identification or reliable cross-occlusion re-identification. Low frame rates, occlusion, fast motion, and crowded scenes can split/swap tracks. Re-entry can create another record. A no-helmet detection does not require a matched bike; test the scene and model to assess false positives.

At confirmation, entry/best/last frames are saved. The last image updates while matched; the best image updates on higher-confidence no-helmet observations. Frame numbers are sampled detection-frame indexes. Video timestamps use the browser recording clock at capture and can differ slightly from encoded-frame presentation times. Recordings are unannotated; incident metadata and snapshots contain the evidence association.

SQLite uses WAL and per-operation connections. On startup, interrupted sessions/tracks are closed and incomplete recordings are marked for recovery. **Recover video** can finalize the saved chunk prefix; browser memory lost before upload is unrecoverable. Retention removes old records, recordings, evidence, and cached clips at startup.

## Validation

```powershell
.venv\Scripts\python -m pip install -r requirements-dev.txt
.venv\Scripts\python -m unittest discover -s tests -v
```

Tests cover actual checkpoint execution, HTTP/WebSocket inference, session protocol, review persistence, multi-subject association, confirmation, missed detections/re-entry, restart recovery, retention, upload ordering/retries, remuxing/seeking, and clip encoding. They do not establish real-world traffic accuracy.

References: [RF-DETR](https://rfdetr.roboflow.com/latest/reference/rfdetr/), [PyAV containers](https://pyav.basswood.io/docs/stable/api/container.html).
