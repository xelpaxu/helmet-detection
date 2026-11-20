"use client";
import { useEffect, useRef } from "react";
import { Camera, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { useDetector } from "@/hooks/use-detector";

export function CameraSettings({ open, onClose, detector: d, model, onModelChange, retention, excluded }: {
  open: boolean;
  onClose: () => void;
  detector: ReturnType<typeof useDetector>;
  model: string;
  onModelChange: (model: string) => void;
  retention: number | null;
  excluded: Set<string>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = d.phase !== "idle";
  const available = d.cameras.filter(camera => !excluded.has(camera.deviceId) && camera.deviceId !== "default");
  const models = d.health?.camera_models ?? [];
  const defaultModel = models.find(option => option.default);
  const { refreshCameras, checkHealth } = d;
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void refreshCameras();
      void checkHealth();
    } else {
      dialog.current?.close();
    }
  }, [open, refreshCameras, checkHealth]);
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="camera-settings-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="dialog-header"><div><Camera size={22} aria-hidden="true" /><h2 id="camera-settings-title">Camera settings</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close camera settings"><X /></Button></header>
    <div className="settings-content">
      {locked && <div className="inline-notice">Stop monitoring before changing the camera or model.</div>}
      <label className="field-label" htmlFor="camera-name">Camera name or location</label>
      <input className="control" id="camera-name" value={d.cameraName} maxLength={120} disabled={locked} onChange={event => d.setCameraName(event.target.value)} />
      <label className="field-label" htmlFor="camera-source">Camera</label>
      <select className="control" id="camera-source" value={d.camera} disabled={locked || d.requestingCameraAccess} onChange={event => d.setCamera(event.target.value)}>
        <option value="">Browser default camera</option>
        {d.camera && !available.some(camera => camera.deviceId === d.camera) && <option value={d.camera} disabled>Previously selected camera unavailable</option>}
        {available.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}
      </select>
      <label className="field-label" htmlFor="camera-model">Detection model</label>
      <select className="control" id="camera-model" value={model} disabled={locked || !!d.saveError} onChange={event => onModelChange(event.target.value)}>
        <option value="default">{defaultModel ? `Backend default (${defaultModel.name})` : "Backend default"}</option>
        {model !== "default" && !models.some(option => option.id === model) && <option value={model} disabled>Previously selected model unavailable</option>}
        {models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
      {d.cameras.length === 0 && !locked && (
        <div className="inline-notice">
          <Button variant="outline" disabled={d.requestingCameraAccess} onClick={() => void d.requestCameraAccess()}>
            {d.requestingCameraAccess ? "Checking cameras…" : "Enable camera access"}
          </Button>
          {d.cameraAccessError && <p role="status">{d.cameraAccessError}</p>}
        </div>
      )}
      <div className="setting-toggle"><div><label htmlFor="show-boxes">Show person boxes</label><p>Highlight people in the live picture.</p></div><Switch id="show-boxes" checked={d.showBoxes} onCheckedChange={d.setShowBoxes} /></div>
      <div className="setting-toggle"><div><label htmlFor="mirror-view">Flip camera view</label><p>Mirror the preview. Saved video stays unchanged.</p></div><Switch id="mirror-view" checked={d.mirror} onCheckedChange={d.setMirror} /></div>
      <details className="advanced-settings"><summary>Alert settings</summary><p>Use Standard for everyday monitoring. More alerts may also include uncertain results.</p><div className="alert-levels">{[{ name: "Fewer alerts", value: 65 }, { name: "Standard", value: 50 }, { name: "More alerts", value: 35 }].map(level => <button key={level.name} disabled={locked} aria-pressed={d.threshold === level.value} onClick={() => d.setThreshold(level.value)}>{d.threshold === level.value && <Check size={16} aria-hidden="true" />}{level.name}</button>)}</div></details>
      <div className="storage-information"><strong>Storage on this computer</strong><p>Video and incident photos are saved locally. {retention === null ? "" : retention > 0 ? `Records older than ${retention} days are removed when the server restarts.` : "Automatic deletion is turned off."}</p></div>
    </div><footer className="dialog-footer"><Button onClick={onClose}>Done</Button></footer>
  </dialog>;
}
