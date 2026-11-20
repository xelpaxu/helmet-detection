# Helmet Watch monitoring console

Next.js App Router / TypeScript / Tailwind CSS v4, with locally owned shadcn/ui controls built on Radix primitives. Native dialogs provide keyboard focus containment. IBM Plex Sans and Barlow Condensed are self-hosted through Fontsource; fonts need no third-party requests at runtime.

## Run

Start the updated Python backend first. In a second PowerShell terminal:

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open http://127.0.0.1:3000 in Chrome or Edge. Use **Start monitoring**, then **Stop & save** before reviewing session video. `npm.cmd` avoids PowerShell's `npm.ps1` execution-policy restriction. Camera access requires localhost or HTTPS and browser permission. **Camera settings** contains the camera name/source, person boxes, flip preview, and optional plain-language alert presets. Camera selection and alert level can be edited while stopped; preview switches work live.

Optional `.env.local` configuration:

```text
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
```

Restart Next.js after changing it. Backend `ALLOWED_ORIGINS` must include the actual frontend origin. HTTPS pages need an HTTPS/WSS backend. `NEXT_DIST_DIR` can isolate a separate local QA build; normal use leaves it unset.

## Workflow

- **Live monitor:** a large camera panel beside a paginated list of recorded incidents. Both remain visible within a desktop viewport. On phones, Camera/Incidents tabs replace stacking and preserve a single-screen workspace.
- **Incidents:** a standalone, paginated register with thumbnails, camera/person references, video first/last-seen timestamps, and review state. Search by ID/person/camera/notes; filter by review, recording, camera, or date; export filtered rows as CSV.
- **Review:** switch between saved photos and video; seek first-seen/alert/last-seen times; play the incident or full recording; download a clip; save officer notes and a review decision. The desktop dialog fits the viewport without stacking photos and video.
- **Recordings:** a separate paginated page with in-app playback, video download, incident links, and recovery for interrupted uploads. It does not stack the incident register underneath.

The default theme is dark graphite with blue controls and amber incident markers. A sidebar light/dark switch saves the preference locally. Body type is 16 px; headings and camera/time labels use Barlow Condensed. Technical model metrics and numerical confidence controls are removed from the operator workspace.

Camera preview stays local; unmirrored JPEG samples up to 640 pixels wide are sent to the model. Only one sample is in flight. Capture timestamps and indexes accompany each image; the next sample is captured after a response and an 80 ms pacing interval. A separate MediaRecorder records WebM video, uploading ordered 2-second chunks with retries. Video rate is independent of model rate.

The recording clock is anchored immediately before `MediaRecorder.start()`, rather than its asynchronously delivered start event. UTC wall time derives from that browser clock. Encoding/rendering can introduce a small offset; displayed milliseconds do not imply exact physical entry/exit or encoded-frame synchronization. Sampled snapshots and their capture metadata remain available separately.

Corner-bracket overlays interpolate toward new track positions using animation frames, fade missed tracks, account for letterboxing/mirroring, and respect reduced-motion preferences. They do not predict unseen movement or increase inference accuracy. Raw recordings do not include overlays. Track IDs are temporary within each session.

Switching between workspace pages or mobile camera/incident tabs keeps monitoring running. Hiding the browser tab stops and saves the session. Stop explicitly before closing the page; a leave-page prompt protects active/pending work. **Retry saving** retains failed chunks in browser memory until successful; reloading can lose that memory. New sessions are blocked while pending data needs saving. The pending queue stops monitoring at 64 MiB to avoid unbounded memory growth. Sessions automatically stop after one hour; server recording cap is 2 GiB. No audio is recorded.

**Video and incident frames are stored locally by the backend.** Its default seven-day startup retention is configurable. Records polling runs every two seconds while the page is visible. List sizes currently cap at 500 sessions and 2,000 incidents; summary totals describe those loaded records. This is a single local-camera monitoring tool, not an RTSP/multi-station deployment.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Chrome browser QA used a simulated camera and a separate deterministic backend fixture, isolated from real evidence. Checks covered automatic incident rows, recording and seeking, saved reviews, theme persistence, plain-language camera settings, pagination, and camera cleanup. Workspace screen-fit checks passed at 375×812, 1024×768, 1366×768, and 1920×1080. The real checkpoint is separately exercised by backend integration tests. These checks do not establish physical-camera accuracy or traffic tracking performance.

References: [Next.js](https://nextjs.org/docs/app/getting-started/installation), [shadcn/ui](https://ui.shadcn.com/docs/installation/manual), [MediaRecorder timing](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start).
