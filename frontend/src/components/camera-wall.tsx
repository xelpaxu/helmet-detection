"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Camera, LoaderCircle, Maximize, Play, Settings2, Square, Trash2, Upload, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrackingOverlay } from "@/components/tracking-overlay";
import { useDetector } from "@/hooks/use-detector";
import { timecode } from "@/lib/monitoring";

type Detector = ReturnType<typeof useDetector>;
export type CameraSlot = { deviceId: string; name: string; model?: string; kind?: "video" };
export type CameraActivity = { phase: Detector["phase"]; sessionId: string; needsSave: boolean };

export function CameraTile({ detector: d, onSettings, onRemove, unavailable = false, videoSource }: {
  detector: Detector;
  onSettings?: () => void;
  onRemove?: () => void;
  unavailable?: boolean;
  videoSource?: { file?: File; select: (file: File) => void };
}) {
  const titleId = useId();
  const preview = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = d.phase === "starting" || d.phase === "live";
  const simulating = Boolean(d.simulationName) && d.phase !== "idle";
  const feedName = simulating && !videoSource ? d.simulationName : d.cameraName;
  const people = d.result?.detections.filter(item => item.label !== "bike_with_rider").length ?? 0;
  const status = d.phase === "live" ? (simulating ? "Simulation" : "Live") : d.phase === "starting" ? "Starting" : d.phase === "saving" ? "Saving" : unavailable ? "Disconnected" : videoSource ? "Standby" : "Camera off";

  return <section className="camera-panel console-panel wall-tile" aria-labelledby={titleId}>
    <header className="panel-header camera-panel-header">
      <div><Video size={20} aria-hidden="true" /><h2 id={titleId} title={feedName}>{feedName || "Camera 01"}</h2></div>
      <div>
        <span className={`camera-state ${d.phase === "live" ? "live" : ""}`}><i />{status}</span>
        {onSettings && <Button variant="ghost" size="icon" aria-label="Camera settings" onClick={onSettings}><Settings2 /></Button>}
        {onRemove && <Button variant="ghost" size="icon" aria-label={`Remove ${d.cameraName}`} disabled={d.phase !== "idle" || !!d.saveError} onClick={onRemove}><Trash2 /></Button>}
      </div>
    </header>
    <div className="live-feed" ref={preview}>
      <video ref={d.videoRef} muted playsInline hidden={simulating} className={d.mirror && !simulating ? "mirrored" : ""} aria-label={`Video feed for ${feedName}`} />
      <video ref={d.previewVideoRef} className="simulation-preview" muted playsInline hidden={!simulating} aria-label={`Simulation preview for ${feedName}`} />
      <TrackingOverlay result={d.result} nextResult={simulating ? d.nextPreviewResult : undefined}
        videoRef={simulating ? d.previewVideoRef : undefined} mirror={d.mirror && !simulating} visible={d.showBoxes && d.phase === "live"} />
      {d.phase === "idle" && <div className="feed-standby"><Camera size={32} aria-hidden="true" /><h3>{videoSource ? (videoSource.file ? "Ready to simulate" : "Choose a video to simulate") : unavailable ? "Reconnect this camera" : "Camera is off"}</h3></div>}
      {(d.phase === "starting" || d.phase === "saving") && <div className="feed-loading" role="status"><LoaderCircle className="spin" size={28} aria-hidden="true" /><h3>{d.phase === "saving" ? "Saving recording" : simulating ? "Starting simulation" : "Starting camera"}</h3></div>}
      {d.phase === "live" && <>
        <div className="feed-hud-top"><span className="record-label"><i />Recording</span><span className="feed-time">{timecode(d.elapsed)}</span></div>
        <div className="feed-hud-bottom"><span>{people} {people === 1 ? "person" : "people"} in view</span><Button variant="ghost" size="icon" aria-label={`View ${d.cameraName} fullscreen`} onClick={() => { void preview.current?.requestFullscreen?.().catch(() => undefined); }}><Maximize /></Button></div>
      </>}
    </div>
    {(d.saveError || d.error) && <p className="wall-camera-error" role="alert">{d.saveError || d.error}</p>}
    <div className={`camera-controls${onSettings || videoSource ? " camera-source-controls" : ""}`}>
      <span className="camera-label">{d.phase === "idle" && d.sessionId ? `Last recording ${timecode(d.elapsed)}` : ""}</span>
      {(onSettings || videoSource) && <>
        <input ref={fileInput} type="file" hidden accept="video/*,.mp4,.webm" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            if (videoSource) videoSource.select(file);
            else void d.start(file);
          }
        }} />
        {d.phase === "idle" && !d.saveError && <Button variant="outline" onClick={() => fileInput.current?.click()}><Upload size={16} />{videoSource?.file ? "Replace video" : "Upload video"}</Button>}
      </>}
      {active ? <Button variant="destructive" onClick={() => void d.stop()}><Square size={16} />Stop &amp; save</Button>
        : d.saveError ? <Button variant="outline" disabled={d.phase === "saving"} onClick={() => void d.retrySave()}>Retry saving</Button>
        : (!videoSource || videoSource.file) && <Button onClick={() => void d.start(videoSource?.file)} disabled={d.phase !== "idle" || unavailable || d.requestingCameraAccess}><Play size={17} />{videoSource ? "Start simulation" : "Start monitoring"}</Button>}
    </div>
  </section>;
}

export function AddedCamera({ slot, claimed, unavailable, report, onRemove, file, onSelectVideo }: {
  slot: CameraSlot;
  claimed: Set<string>;
  unavailable: boolean;
  report: (deviceId: string, state: CameraActivity) => void;
  onRemove: () => void;
  file?: File;
  onSelectVideo: (file: File) => void;
}) {
  const d = useDetector({ claimed, source: slot.deviceId, name: slot.name, model: slot.model });
  const { phase, sessionId, saveError } = d;
  useEffect(() => { report(slot.deviceId, { phase, sessionId, needsSave: !!saveError }); }, [slot.deviceId, report, phase, sessionId, saveError]);
  return <CameraTile detector={d} onRemove={onRemove} unavailable={unavailable}
    videoSource={slot.kind === "video" ? { file, select: onSelectVideo } : undefined} />;
}

export function AddCameraDialog({ detector: d, excluded, onClose, onAdd }: {
  detector: Detector;
  excluded: Set<string>;
  onClose: () => void;
  onAdd: (slot: CameraSlot, file?: File) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deviceId, setDeviceId] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("default");
  const [sourceType, setSourceType] = useState<"camera" | "video">("camera");
  const [file, setFile] = useState<File>();
  const { refreshCameras, checkHealth } = d;
  useEffect(() => {
    dialog.current?.showModal();
    void refreshCameras();
    void checkHealth();
  }, [refreshCameras, checkHealth]);
  const fromVideo = sourceType === "video";
  const models = (d.health?.camera_models ?? []).filter(option => !fromVideo ||
    (option.classes?.includes("bike_with_rider") && option.classes.includes("no_helmet")));
  const selectedModel = models.some(option => option.id === model) ? model :
    models.find(option => option.default)?.id ?? models[0]?.id ?? "default";
  const available = d.cameras.filter(device => !excluded.has(device.deviceId) && device.deviceId !== "default");
  const selected = available.find(device => device.deviceId === deviceId) ?? available[0];

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="add-camera-title" onCancel={onClose}>
    <header className="dialog-header">
      <div><Video size={22} aria-hidden="true" /><h2 id="add-camera-title">Add camera</h2></div>
      <Button variant="ghost" size="icon" aria-label="Close add camera" onClick={onClose}><X /></Button>
    </header>
    <form onSubmit={event => {
      event.preventDefault();
      if (fromVideo) {
        if (file) onAdd({ deviceId: `video-${crypto.randomUUID()}`, kind: "video", name: (name.trim() || file.name).slice(0, 120), model: selectedModel }, file);
      } else if (selected) onAdd({ deviceId: selected.deviceId, name: (name.trim() || selected.label || "Camera").slice(0, 120), model: selectedModel });
    }}>
      <div className="settings-content">
        <label className="field-label" htmlFor="add-camera-source-type">Source</label>
        <select className="control" id="add-camera-source-type" value={sourceType} onChange={event => {
          setSourceType(event.target.value === "video" ? "video" : "camera");
          setFile(undefined);
        }}>
          <option value="camera">Camera device</option>
          <option value="video">Upload video</option>
        </select>
        {fromVideo ? <>
          <label className="field-label" htmlFor="add-camera-video">Video file</label>
          <input className="control" id="add-camera-video" type="file" accept="video/*,.mp4,.webm" required onChange={event => setFile(event.target.files?.[0])} />
        </> : available.length > 0 ? <>
          <label className="field-label" htmlFor="add-camera-source">Camera device</label>
          <select className="control" id="add-camera-source" value={selected?.deviceId ?? ""} onChange={event => setDeviceId(event.target.value)}>
            {available.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
          </select>
        </> : <p className="inline-notice" role="status">{d.cameras.length
          ? "All detected cameras are already in the workspace. Connect another camera, then check again."
          : d.cameraAccessError || "Connect a webcam or set up your phone as a webcam, then check for cameras."}</p>}
        {(fromVideo || selected) && <>
          <label className="field-label" htmlFor="add-camera-name">Camera name or location (optional)</label>
          <input className="control" id="add-camera-name" value={name} maxLength={120} onChange={event => setName(event.target.value)} />
        </>}
        <label className="field-label" htmlFor="add-camera-model">Detection model</label>
        <select className="control" id="add-camera-model" value={selectedModel} onChange={event => setModel(event.target.value)}>
          {models.length === 0 && <option value="default">{fromVideo ? "Automatic rider model" : "Backend default"}</option>}
          {models.map(option => <option key={option.id} value={option.id}>{option.name}{option.default ? " (default)" : ""}</option>)}
        </select>
        {!fromVideo && <Button type="button" variant="outline" disabled={d.requestingCameraAccess} onClick={() => void (
          d.cameras.length || d.phase !== "idle" ? refreshCameras() : d.requestCameraAccess()
        )}>{d.requestingCameraAccess ? "Checking cameras…" : "Check for cameras"}</Button>}
      </div>
      <footer className="dialog-footer">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={fromVideo ? !file : !selected || d.requestingCameraAccess}>Add camera</Button>
      </footer>
    </form>
  </dialog>;
}
