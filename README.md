# Helmet Watch

Local traffic-monitoring console using the RF-DETR Small checkpoint at `backend/model/RF-DETR_Small.pth`. The Python API tracks detected subjects, confirms suspected no-helmet incidents, and saves evidence. Next.js provides the camera feeds, session recordings, incident register, and review interface.

## Start

In one PowerShell terminal:

```powershell
cd backend
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python run.py
```

In another terminal:

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open http://127.0.0.1:3000 in Chrome or Edge. If the previous backend is already running, stop it with Ctrl+C and restart it to load the monitoring endpoints. Dependencies already installed in this workspace can be reused.

## Use

1. Open **Camera settings** to choose the first camera and its **Detection model**. Use **Add camera** in the live monitor to add other webcams or a phone connected in webcam mode, and choose a model for each. Choose **Start monitoring** on each tile you want to use and allow camera access.
2. A head track with **three consecutive `no_helmet` observations** creates one incident row. That row updates as the subject is observed. A track closes after more than three seconds without a match, or when the session ends.
3. Choose **Stop & save** and keep the page open while the recording finalizes.
4. Select **Review** on an incident to inspect entry/best/exit images, seek to first seen/confirmation/last seen, play its video interval, save review notes/status, or download a clip.
5. Use **Recordings** in the left navigation to watch or download saved video. **Incidents** opens the searchable register with review filters and CSV export.

### Simulate CCTV from a video

In the live monitor, click **Upload video** on the main camera tile and select an MP4 (H.264) or WebM file in Chrome or Edge. The clip plays once at normal speed without a webcam. The detector samples frames as the video plays, and the session saves automatically at the end. Use **Stop & save** to end early. Saved simulation sessions are labeled with the source filename.

To give a clip its own tile, choose **Add camera → Source → Upload video**, select the file and a rider-capable detection model, and add it. Use **Start simulation** on that tile. The tile and its model are saved in the workspace. After reloading the page, select the local video again on that tile.

Simulation and recording run at normal speed. The preview waits for two detector responses or up to 1.7 seconds before starting, so it can interpolate box position and size between detections. Recording uses the original playback stream. The detector samples the latest frame with a single full-frame pass and drops frames when the detector is occupied. Between results, the browser also follows motorcycle motion in the video. Simulations require a motorcycle rider detection before displaying or recording a no-helmet result. To improve small-helmet accuracy, fine-tune on labeled wide-angle footage and validate on separate clips from different cameras or locations.

Video recording is independent of inference speed. Live boxes interpolate between detection updates; this improves presentation, not tracking accuracy. Mirroring affects the preview only, not saved evidence. No audio is recorded.

## Records and timing

Data is saved in `backend/data/`: SQLite metadata plus per-session evidence and WebM video. **Default retention is seven days**, with cleanup on backend startup. Set `$env:RETENTION_DAYS = "0"` in the backend terminal before starting it to disable cleanup. Copy/export evidence you need to retain longer.

Video offsets use the browser's monotonic recording clock at frame capture, not response arrival or inference completion. First/last seen and frame numbers refer to **sampled detection frames**, not every encoded video frame or the exact physical instant a person entered/exited. The browser's rendering/encoding pipeline can introduce a small timing difference; millisecond formatting does not imply frame-perfect synchronization. Entry/best/exit snapshots remain the authoritative sampled frames.

Tracks are temporary spatial associations within a session. Occlusion, fast motion, low inference rates, and similar overlapping subjects can cause identity switches or duplicate tracks after re-entry. No face recognition, identity lookup, plate recognition, or automatic penalty is performed. A model flag needs human review. A close-up face may not register reliably because the model was trained for riding scenes.

The browser stops and saves when its tab becomes hidden. Stop and save explicitly before closing the page. Failed uploads expose **Retry saving** and retain pending chunks in the page's memory. Closing/reloading can lose those pending chunks. After interruption, **Recover video** in history can finalize already uploaded chunks; it cannot recover video that never reached the backend.

Each camera tile records its own session. The local detector shares inference time between active cameras, so detection updates can slow down as you add feeds. Authentication, RTSP ingestion, and remote deployment are separate work.

Details: [backend setup/API](backend/README.md), [frontend setup](frontend/README.md).
