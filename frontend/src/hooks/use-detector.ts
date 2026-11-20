"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMotionSampler, type MotionFrame } from "@/lib/video-motion";

export type Detection = { class_id: number; label: string; confidence: number; track_id?: number; rider_track_id?: number | null; incident_id?: string; tracking_state?: string; normalized_box: { x1: number; y1: number; x2: number; y2: number } };
export type Result = { width: number; height: number; inference_ms: number; captured_ms?: number; detections: Detection[]; sampledAt?: number; motionFrame?: MotionFrame };
const MAX_PREVIEW_PREROLL_MS = 1700;
type Health = { status: string; device: string; classes: string[]; simulation_ready?: boolean; camera_models?: { id: string; name: string; default: boolean; classes: string[] }[] };
export const API = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, signal: init?.signal || AbortSignal.timeout(30000), cache: "no-store" });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`); }
  return response.json();
}
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const cameraSupportMessage = "Camera access requires localhost or HTTPS and a supported browser.";
function cameraError(reason: unknown, selected: boolean) {
  switch (reason instanceof DOMException ? reason.name : "") {
    case "NotAllowedError":
      return "Camera access blocked. Check camera permissions in your browser and Windows.";
    case "NotFoundError":
    case "OverconstrainedError":
      return selected ? "The selected camera is unavailable. Reconnect it or choose another camera in Camera settings." : "No usable default camera found. Connect your phone as a webcam and choose it in Camera settings.";
    case "NotReadableError":
    case "AbortError":
      return selected ? "The selected camera could not start. Check that it is connected and ready on your phone or in your webcam app, then close other apps using it." : "The default camera could not start. Open Camera settings and select your phone camera.";
    default:
      return reason instanceof Error ? reason.message : "Could not open the camera.";
  }
}

async function openCamera(camera: string) {
  const source = camera ? { deviceId: { exact: camera } } : {};
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...source, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 25, max: 30 } },
    });
  } catch (reason) {
    if (!(reason instanceof DOMException) || !["NotReadableError", "OverconstrainedError", "AbortError"].includes(reason.name)) throw reason;
    return navigator.mediaDevices.getUserMedia({ audio: false, video: camera ? source : true });
  }
}
type Runtime = { cancelled: boolean; stream?: MediaStream; source?: string; releaseVideo?: () => void; creating?: Promise<{ id: string }>; socket?: WebSocket; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout>; watchdog?: ReturnType<typeof setTimeout>; id?: string; origin: number; recordingEndedAt?: number; preview?: HTMLVideoElement; duration: number; sequence: number; pending: Map<number, Blob>; pendingBytes: number; queue: Promise<void>; closing?: Promise<void>; stopped?: Promise<void>; resolveStopped?: () => void };

async function upload(runtime: Runtime, index: number, blob: Blob) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api(`/api/sessions/${runtime.id}/chunks/${index}`, { method: "PUT", body: blob, headers: { "Content-Type": "application/octet-stream" }, signal: AbortSignal.timeout(15000) });
      runtime.pending.delete(index); runtime.pendingBytes -= blob.size; return;
    } catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
  }
}

export function useDetector({ claimed, source = "", name = "Camera 01", model = "default" }: { claimed?: Set<string>; source?: string; name?: string; model?: string } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const nextPreviewResult = useRef<Result | null>(null);
  const resources = useRef<Runtime | null>(null);
  const unsaved = useRef<Runtime | null>(null);
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(true);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "saving">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [frames, setFrames] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [sessionId, setSessionId] = useState("");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraAccessError, setCameraAccessError] = useState("");
  const [requestingCameraAccess, setRequestingCameraAccess] = useState(false);
  const cameraAccessPending = useRef(false);
  const [camera, setCamera] = useState(source);
  const [cameraName, setCameraName] = useState(name);
  const [simulationName, setSimulationName] = useState("");
  const [threshold, setThreshold] = useState(50);
  const [mirror, setMirror] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const refreshCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      const inputs = (devices ?? []).filter(device => device.kind === "videoinput" && device.deviceId);
      setCameras(inputs);
      return inputs;
    } catch {
      return [];
    }
  }, []);

  const requestCameraAccess = useCallback(async () => {
    if (resources.current || cameraAccessPending.current) return;
    cameraAccessPending.current = true;
    setRequestingCameraAccess(true);
    setCameraAccessError("");
    let stream: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(cameraSupportMessage);
      if ((await refreshCameras()).length) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      if (!(await refreshCameras()).length) setCameraAccessError("Camera details are unavailable. Check your browser’s camera settings.");
    } catch (reason) {
      if (!(await refreshCameras()).length) {
        const message = reason instanceof DOMException && ["NotReadableError", "AbortError"].includes(reason.name)
          ? "The browser could not open its default camera. Set your phone as the default camera in your browser’s camera settings, then try again."
          : cameraError(reason, false);
        setCameraAccessError(message);
      }
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      cameraAccessPending.current = false;
      setRequestingCameraAccess(false);
    }
  }, [refreshCameras]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    const update = () => { void refreshCameras(); };
    if (source) return;
    update();
    media?.addEventListener("devicechange", update);
    return () => media?.removeEventListener("devicechange", update);
  }, [refreshCameras, source]);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try { const body = await api<Health>("/health", { signal: AbortSignal.timeout(5000) }); setHealth(body.status === "ready" ? body : null); }
    catch { setHealth(null); } finally { setChecking(false); }
  }, []);

  const save = useCallback(async (runtime: Runtime) => {
    if (!runtime.id) return;
    setPhase("saving"); setSaveError("");
    try {
      await runtime.queue.catch(() => undefined);
      for (const [index, blob] of [...runtime.pending].sort((a, b) => a[0] - b[0])) await upload(runtime, index, blob);
      await api(`/api/sessions/${runtime.id}/finish`, json({ chunks: runtime.sequence, duration_ms: runtime.duration }));
      unsaved.current = null; setNotice("Session saved. Recording and evidence are ready for review.");
    } catch (reason) {
      unsaved.current = runtime;
      setSaveError(`Recording not fully saved: ${reason instanceof Error ? reason.message : "upload failed"}. Keep this page open and retry saving.`);
    } finally { setPhase("idle"); }
  }, []);

  const stop = useCallback(async () => {
    const runtime = resources.current;
    if (!runtime) return;
    if (runtime.closing) return runtime.closing;
    runtime.cancelled = true; runtime.duration = runtime.origin ? (runtime.recordingEndedAt ?? performance.now()) - runtime.origin : 0;
    clearTimeout(runtime.timer); clearTimeout(runtime.watchdog);
    if (runtime.socket) { runtime.socket.onclose = null; runtime.socket.onerror = null; runtime.socket.onmessage = null; runtime.socket.close(); }
    setResult(null); setFps(null); setElapsed(runtime.duration);
    nextPreviewResult.current = null;
    if (runtime.id) setPhase("saving");
    runtime.closing = (async () => {
      if (runtime.recorder && runtime.recorder.state !== "inactive") runtime.recorder.stop();
      runtime.stream?.getTracks().forEach(track => track.stop());
      if (runtime.source) claimed?.delete(runtime.source);
      runtime.releaseVideo?.();
      if (videoRef.current) videoRef.current.srcObject = null;
      if (runtime.stopped) await runtime.stopped;
      await runtime.creating?.catch(() => undefined);
      if (runtime.id) {
        setSessionId(runtime.id);
        await save(runtime);
      } else setPhase("idle");
      if (resources.current === runtime) resources.current = null;
    })();
    return runtime.closing;
  }, [claimed, save]);
  useEffect(() => { stopRef.current = stop; }, [stop]);
  useEffect(() => {
    if (!source) void checkHealth();
    const interval = source ? undefined : setInterval(() => { void checkHealth(); }, 15000);
    const clock = setInterval(() => {
      const r = resources.current;
      if (r?.origin && !r.cancelled) setElapsed(r.preview ? r.preview.currentTime * 1000 : performance.now() - r.origin);
    }, 250);
    const onHidden = () => { if (document.hidden) void stopRef.current(); };
    const onLeave = (event: BeforeUnloadEvent) => { if (resources.current || unsaved.current) { event.preventDefault(); event.returnValue = ""; } };
    document.addEventListener("visibilitychange", onHidden); window.addEventListener("beforeunload", onLeave);
    return () => { clearInterval(interval); clearInterval(clock); document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("beforeunload", onLeave); void stopRef.current(); };
  }, [checkHealth, source]);

  const start = useCallback(async (file?: File) => {
    if (resources.current || unsaved.current || (!file && cameraAccessPending.current)) return;
    const runtime: Runtime = { cancelled: false, origin: 0, duration: 0, sequence: 0, pending: new Map(), pendingBytes: 0, queue: Promise.resolve() };
    resources.current = runtime;
    const valid = () => resources.current === runtime && !runtime.cancelled;
    const fail = (message: string) => { if (valid()) { setError(message); void stopRef.current(); } };
    setError(""); setNotice(""); setSaveError(""); setPhase("starting"); setFrames(0); setElapsed(0); setSessionId("");
    setSimulationName(file?.name || "");
    try {
      if ((!file && !navigator.mediaDevices?.getUserMedia) || typeof MediaRecorder === "undefined") throw new Error("Monitoring requires browser recording support. Use a recent Chrome or Edge browser on localhost or HTTPS.");
      const mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser cannot record WebM video. Use Chrome or Edge for monitoring.");
      const video = videoRef.current;
      if (!video) throw new Error("Video preview unavailable. Reload the page.");
      const playback = file ? previewVideoRef.current : null;
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      let previewFrame = 0;
      let previewStarted = false;
      let stream: MediaStream;
      if (file) {
        if (!playback) throw new Error("Video preview unavailable. Reload the page.");
        runtime.preview = playback;
        const player = video as HTMLVideoElement & { captureStream?: () => MediaStream };
        if (!player.captureStream) throw new Error("Video simulation requires a recent Chrome or Edge browser.");
        const fileUrl = URL.createObjectURL(file);
        const loading = new AbortController();
        runtime.releaseVideo = () => {
          loading.abort();
          clearTimeout(previewTimer);
          cancelAnimationFrame(previewFrame);
          for (const player of [video, playback]) {
            player.onended = null;
            player.onerror = null;
            player.pause();
            player.removeAttribute("src");
            player.load();
          }
          URL.revokeObjectURL(fileUrl);
        };
        playback.src = fileUrl;
        playback.load();
        await new Promise<void>((resolve, reject) => {
          const signal = AbortSignal.any([loading.signal, AbortSignal.timeout(10000)]);
          signal.addEventListener("abort", () => reject(new Error("The video could not be loaded.")), { once: true });
          video.addEventListener("loadeddata", () => resolve(), { once: true, signal: loading.signal });
          video.onerror = () => reject(new Error("This video could not be decoded. Try an MP4 (H.264) or WebM file."));
          video.src = fileUrl;
          video.load();
        });
        if (!valid()) return;
        if (!video.videoWidth) throw new Error("The selected file does not contain a video track.");
        const health = await api<Health>("/health", { signal: AbortSignal.timeout(5000) }).catch(() => {
          throw new Error("The detector is starting or unreachable. Wait for it to come online, then upload the video again.");
        });
        if (!valid()) return;
        if (health.simulation_ready === false) throw new Error("The motorcycle rider model could not load. Check RIDER_MODEL_PATH in the backend.");
        if (health.simulation_ready !== true) throw new Error("Restart the backend to load the updated simulation detector.");
        const captured = player.captureStream();
        captured.getAudioTracks().forEach(track => track.stop());
        const tracks = captured.getVideoTracks();
        if (!tracks.length) throw new Error("The browser could not capture the video track.");
        stream = new MediaStream(tracks);
        runtime.stream = stream;
        video.onerror = () => fail("The video could not continue playing. The session is being saved.");
        video.onended = () => { runtime.recordingEndedAt = performance.now(); };
        playback.onerror = () => fail("The simulation preview could not play. The session is being saved.");
        playback.onended = () => { if (valid()) void stopRef.current(); };
      } else {
        stream = await openCamera(camera);
        if (!valid()) { stream.getTracks().forEach(track => track.stop()); return; }
        runtime.stream = stream;
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        const key = settings.deviceId || camera || settings.groupId;
        if (key && claimed?.has(key)) throw new Error("This camera is already running in another tile.");
        if (key) { claimed?.add(key); runtime.source = key; }
        track.onended = () => fail("The camera disconnected. The session is being saved.");
        if (!source) void refreshCameras();
        video.srcObject = stream;
        await video.play();
      }
      if (!valid()) return;
      const sessionName = file ? `Simulation · ${source ? cameraName : file.name}`.slice(0, 120) : cameraName.trim() || "Camera 01";
      runtime.creating = api<{ id: string }>("/api/sessions", json({ camera: sessionName }))
        .then(session => { runtime.id = session.id; return session; });
      const session = await runtime.creating;
      if (!valid()) return;
      setSessionId(session.id);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1800000 });
      runtime.recorder = recorder;
      recorder.onstop = () => runtime.resolveStopped?.();
      recorder.onerror = () => fail("Video recording failed. Check the saved session before restarting.");
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        const index = runtime.sequence++;
        runtime.pending.set(index, event.data); runtime.pendingBytes += event.data.size;
        runtime.queue = runtime.queue.then(() => upload(runtime, index, event.data));
        void runtime.queue.catch(() => fail("Recording upload failed. Saving will retry the pending chunks."));
        if (runtime.pendingBytes > 64 * 1024**2) fail("Recording uploads cannot keep up. Monitoring stopped to preserve the pending recording.");
      };
      const startRecording = async () => {
        // Anchor to start() because the recorder's start event may wait for encoded data.
        runtime.origin = performance.now();
        recorder.start(2000);
        runtime.stopped = new Promise(resolve => { runtime.resolveStopped = resolve; });
        await Promise.all([
          api(`/api/sessions/${session.id}/clock`, json({ started_at: new Date(performance.timeOrigin + runtime.origin).toISOString() })),
          file ? video.play() : undefined,
        ]);
      };
      if (!file) await startRecording();
      if (!valid()) return;
      const url = new URL(`${API}/ws/detect`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("threshold", String(threshold / 100)); url.searchParams.set("session_id", session.id);
      if (file) url.searchParams.set("riders_only", "true");
      if (model !== "default" && (!file || source)) url.searchParams.set("model", model);
      const socket = new WebSocket(url); runtime.socket = socket;
      const capture = document.createElement("canvas");
      const captureContext = capture.getContext("2d")!;
      const sampleMotion = file ? createMotionSampler() : undefined;
      const pendingResults: Result[] = [];
      const presentResults = () => {
        if (!valid() || !playback) return;
        const mediaTime = playback.currentTime * 1000;
        let latest: Result | undefined;
        while (pendingResults[0]?.motionFrame && pendingResults[0].motionFrame.time <= mediaTime) {
          latest = pendingResults.shift();
        }
        nextPreviewResult.current = pendingResults[0] ?? null;
        if (latest?.motionFrame) {
          setResult({ ...latest, sampledAt: performance.now() - Math.max(0, mediaTime - latest.motionFrame.time) });
        }
        previewFrame = requestAnimationFrame(presentResults);
      };
      const startPreview = () => {
        if (!valid() || !playback || previewStarted) return;
        previewStarted = true;
        clearTimeout(previewTimer);
        void playback.play().then(() => {
          if (!valid()) return;
          setPhase("live");
          presentResults();
        }).catch(() => fail("The simulation preview could not play. The session is being saved."));
      };
      let motionFrame: MotionFrame | undefined;
      let lastVideoTime = -1, lastResultAt = 0, frameIndex = 0;
      let failedFrames = 0;
      const watchdog = () => { clearTimeout(runtime.watchdog); runtime.watchdog = setTimeout(() => fail("The detector stopped responding. This session is being saved."), 30000); };
      const sendFrame = () => {
        if (!valid() || socket.readyState !== WebSocket.OPEN || video.ended) return;
        if (performance.now() - runtime.origin >= 3600000) { setNotice("One-hour session limit reached. Start a new session after saving."); void stopRef.current(); return; }
        if (!video.videoWidth || video.readyState < 2) { runtime.timer = setTimeout(sendFrame, 100); return; }
        if (video.currentTime - lastVideoTime < 1 / 30) { runtime.timer = setTimeout(sendFrame, 12); return; }
        lastVideoTime = video.currentTime;
        const scale = file ? Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight)) : Math.min(1, 640 / video.videoWidth);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (capture.width !== width || capture.height !== height) { capture.width = width; capture.height = height; }
        const capturedMs = performance.now() - runtime.origin;
        captureContext.drawImage(video, 0, 0, width, height);
        motionFrame = sampleMotion?.(capture, lastVideoTime * 1000);
        capture.toBlob(blob => {
          if (!valid() || socket.readyState !== WebSocket.OPEN) return;
          if (!blob) { fail("Camera frame capture failed. The session is being saved."); return; }
          socket.send(JSON.stringify({ type: "frame", captured_ms: capturedMs, frame_index: ++frameIndex })); socket.send(blob); watchdog();
        }, "image/jpeg", 0.85);
      };
      watchdog();
      socket.onopen = async () => {
        if (!valid()) return;
        try {
          if (file) await startRecording();
          if (!valid()) return;
          sendFrame();
          if (playback) {
            // Two responses give the overlay a future position to interpolate
            // toward. Bound startup when inference is slow or feeds compete.
            previewTimer = setTimeout(startPreview, MAX_PREVIEW_PREROLL_MS);
            if (video.ended) startPreview();
            else {
              video.onended = () => {
                runtime.recordingEndedAt = performance.now();
                startPreview();
              };
            }
          } else setPhase("live");
        } catch (reason) {
          fail(reason instanceof Error ? reason.message : "The selected video could not start playing.");
        }
      };
      socket.onmessage = event => {
        if (!valid()) return;
        clearTimeout(runtime.watchdog);
        try {
          const message = JSON.parse(event.data);
          if (message.type === "error") {
            if (message.code === "busy") { setNotice("Detector busy. Retrying the latest frame…"); runtime.timer = setTimeout(sendFrame, 40 + Math.random() * 60); return; }
            if (message.code === "inference_failed") {
              if (video.ended && playback) return;
              if (++failedFrames < 3) {
                runtime.timer = setTimeout(sendFrame, 80);
                return;
              }
              fail("The detector failed on three consecutive frames. Check the backend log for the model error.");
              return;
            }
            fail(message.message || "Detection failed."); return;
          }
          if (message.type !== "detections" || !Array.isArray(message.detections)) throw new Error("Invalid response");
          failedFrames = 0;
          const now = performance.now();
          if (lastResultAt) setFps(1000 / Math.max(1, now - lastResultAt));
          lastResultAt = now;
          if (playback && motionFrame) {
            if (pendingResults.length >= 32) pendingResults.shift();
            pendingResults.push({ ...message, motionFrame });
            nextPreviewResult.current = pendingResults[0];
            if (pendingResults.length >= 2) startPreview();
          } else setResult(message);
          setNotice(""); setFrames(value => value + 1);
          sendFrame();
        } catch { fail("Unexpected detector response. Check the backend version."); }
      };
      socket.onerror = () => fail(runtime.origin ? "Detector connection failed. The recording is being saved." : "Could not connect to the detector. Check that the backend is running.");
      socket.onclose = () => fail(runtime.origin ? "Detector disconnected. The session is being saved." : "The backend closed the connection before playback started.");
    } catch (reason) {
      if (!file && !runtime.stream && !source) void refreshCameras();
      fail((file || runtime.stream) && reason instanceof Error ? reason.message : cameraError(reason, Boolean(camera)));
    }
  }, [camera, cameraName, claimed, threshold, source, refreshCameras, model]);
  const retrySave = useCallback(async () => { if (unsaved.current) await save(unsaved.current); }, [save]);
  return { apiUrl: API, videoRef, previewVideoRef, nextPreviewResult, health, checking, checkHealth, phase, error, notice, saveError, retrySave, result, fps, frames, elapsed, sessionId, cameras, camera, setCamera, cameraName, setCameraName, simulationName, refreshCameras, requestCameraAccess, requestingCameraAccess, cameraAccessError, threshold, setThreshold, mirror, setMirror, showBoxes, setShowBoxes, start, stop };
}
