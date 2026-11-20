"use client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Detection, Result } from "@/hooks/use-detector";
import { createMotionSampler, matchMotion, type MotionFrame, type Position } from "@/lib/video-motion";

type Box = { x: number; y: number; w: number; h: number; tx: number; ty: number; tw: number; th: number; vx: number; vy: number; alpha: number; seen: number; label: string; color: string; rgb: string; motion?: MotionTrack; motionStart?: Position };
type MotionTrack = { frame: MotionFrame; position: Position; velocity: Position; w: number; h: number; matched: boolean };
const MIN_BOX_HOLD_MS = 1200;
const MAX_BOX_HOLD_MS = 3000;
const MAX_PREDICTION_MS = 650;
const MAX_SIMULATION_SAMPLE_GAP_MS = 2000;
const MIN_SIMULATION_BOX_HOLD_MS = 400;
const MAX_SIMULATION_BOX_HOLD_MS = 1200;
const MOTION_INTERVAL_MS = 29;
const MAX_MOTION_GAP_MS = 160;
const MOTION_HISTORY_MS = 1800;

function advanceMotion(track: MotionTrack, frame: MotionFrame) {
  const elapsed = frame.time - track.frame.time;
  if (elapsed <= 0 || elapsed > MAX_MOTION_GAP_MS) return;
  const expected = { x: track.velocity.x * elapsed, y: track.velocity.y * elapsed };
  const offset = matchMotion(track.frame, frame, { ...track.position, w: track.w, h: track.h }, expected);
  if (!offset) return;
  track.position = { x: track.position.x + offset.x, y: track.position.y + offset.y };
  track.velocity = { x: offset.x / elapsed, y: offset.y / elapsed };
  track.frame = frame;
  track.matched = true;
}

export function TrackingOverlay({ result, mirror, visible, videoRef, nextResult }: {
  result: Result | null;
  mirror: boolean;
  visible: boolean;
  videoRef?: RefObject<HTMLVideoElement | null>;
  nextResult?: RefObject<Result | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ result, mirror });
  useLayoutEffect(() => { latest.current = { result, mirror }; }, [result, mirror]);
  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const boxes = new Map<string, Box>();
    const history: MotionFrame[] = [];
    const sampleMotion = videoRef ? createMotionSampler() : undefined;
    const video = videoRef?.current;
    let motionTracks: MotionTrack[] = [];
    let lastVideoTime = -1, presentedTime = 0;
    let videoCallback: number | undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation = 0, previousTime = performance.now(), previousResult: Result | null = null, previousMirror = latest.current.mirror;
    let previousUpdate = 0;
    let holdMs = MIN_BOX_HOLD_MS;
    let futureResult: Result | null = null;
    const futureBoxes = new Map<string, Detection["normalized_box"]>();
    const sampleVideo = (mediaTime: number) => {
      const time = mediaTime * 1000;
      presentedTime = time;
      if (sampleMotion && video && video.readyState >= 2 && !video.paused &&
        mediaTime !== lastVideoTime && time - (history.at(-1)?.time ?? -Infinity) >= MOTION_INTERVAL_MS) {
        const frame = sampleMotion(video, time);
        lastVideoTime = mediaTime;
        history.push(frame);
        while (history[0].time < time - MOTION_HISTORY_MS) history.shift();
        for (const track of motionTracks) advanceMotion(track, frame);
      }
    };
    if (video?.requestVideoFrameCallback) {
      const onVideoFrame: VideoFrameRequestCallback = (_, metadata) => {
        sampleVideo(metadata.mediaTime);
        videoCallback = video.requestVideoFrameCallback(onVideoFrame);
      };
      videoCallback = video.requestVideoFrameCallback(onVideoFrame);
    }
    const draw = (now: number) => {
      if (videoCallback === undefined && video) sampleVideo(video.currentTime);
      const { result, mirror } = latest.current;
      const upcoming = nextResult?.current ?? null;
      if (upcoming !== futureResult) {
        futureResult = upcoming;
        futureBoxes.clear();
        for (const hit of upcoming?.detections ?? []) {
          if (hit.track_id !== undefined) futureBoxes.set(String(hit.track_id), hit.normalized_box);
        }
      }
      const width = canvas.clientWidth, height = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
      const resized = canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr);
      const sampledAt = result?.sampledAt;
      if (resized) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      const scale = result ? Math.min(width / result.width, height / result.height) : 1;
      const cw = (result?.width || 0) * scale, ch = (result?.height || 0) * scale;
      const ox = (width - cw) / 2, oy = (height - ch) / 2;
      if (mirror !== previousMirror) { boxes.clear(); previousResult = null; previousMirror = mirror; }
      if (!result) {
        boxes.clear();
        previousResult = null;
        previousUpdate = 0;
        holdMs = MIN_BOX_HOLD_MS;
        motionTracks = [];
      }
      if (result && previousResult !== result) {
        const previousSample = previousResult?.sampledAt;
        const sampleGap = sampledAt !== undefined && previousSample !== undefined ? sampledAt - previousSample : 0;
        const seen = new Set<string>();
        const elapsedSinceUpdate = previousUpdate ? now - previousUpdate : 0;
        if (sampledAt !== undefined) {
          // Inference can take longer than the prediction horizon. Give each
          // returned result time on screen, independently of its capture age.
          holdMs = Math.min(MAX_SIMULATION_BOX_HOLD_MS,
            Math.max(MIN_SIMULATION_BOX_HOLD_MS, elapsedSinceUpdate, now - sampledAt));
        } else if (previousUpdate) {
          holdMs = Math.min(MAX_BOX_HOLD_MS, Math.max(MIN_BOX_HOLD_MS, elapsedSinceUpdate * 1.5));
        }
        previousUpdate = now;
        const motionFrame = result.motionFrame;
        const riders = motionFrame ? result.detections.filter(hit => hit.label === "bike_with_rider").map(hit => {
          const b = hit.normalized_box;
          const position = { x: b.x1, y: b.y1 };
          const track = { frame: motionFrame, position, velocity: { x: 0, y: 0 }, w: b.x2 - b.x1, h: b.y2 - b.y1, matched: false };
          for (const frame of history) if (frame.time > motionFrame.time) advanceMotion(track, frame);
          return { hit, track, position };
        }) : [];
        motionTracks = riders.map(rider => rider.track);
        result.detections.forEach((hit, index) => {
          const id = String(hit.track_id ?? `${hit.label}-${index}`), b = hit.normalized_box;
          seen.add(id);
          const x = mirror ? 1 - b.x2 : b.x1, y = b.y1, w = b.x2 - b.x1, h = b.y2 - b.y1;
          const color = hit.label === "no_helmet" ? "#ffab82" : hit.label === "helmet" ? "#78e0b8" : "#8abfff";
          const rgb = hit.label === "no_helmet" ? "255,145,90" : hit.label === "helmet" ? "78,216,165" : "109,170,249";
          const name = hit.label === "no_helmet" ? "No helmet" : hit.label === "helmet" ? "Helmet" : "Motorcycle";
          const showId = hit.track_id !== undefined && hit.label !== "bike_with_rider";
          const label = `${name}${showId ? ` · ${sampledAt !== undefined ? "Rider" : "Person"} ${String(hit.track_id).padStart(3, "0")}` : ""}${hit.incident_id ? " · Alert" : ""}`;
          const rider = riders.find(candidate => {
            if (candidate.hit === hit) return true;
            if (hit.label === "bike_with_rider") return false;
            if (hit.rider_track_id != null) return candidate.hit.track_id === hit.rider_track_id;
            const bounds = candidate.hit.normalized_box;
            const cx = x + w / 2, cy = y + h / 2, height = bounds.y2 - bounds.y1;
            return cx >= bounds.x1 && cx <= bounds.x2 && cy >= bounds.y1 - height * 0.1 && cy <= bounds.y1 + height * 0.55;
          });
          const motion = rider?.track;
          const motionStart = rider?.position;
          const existing = boxes.get(id);
          if (existing) {
            const canPredict = hit.track_id !== undefined && sampleGap > 0 && sampleGap <= MAX_SIMULATION_SAMPLE_GAP_MS;
            const vx = canPredict ? ((x + w / 2) - (existing.tx + existing.tw / 2)) / sampleGap : 0;
            const vy = canPredict ? ((y + h / 2) - (existing.ty + existing.th / 2)) / sampleGap : 0;
            Object.assign(existing, { tx: x, ty: y, tw: w, th: h, vx, vy, seen: now, label, color, rgb, motion, motionStart });
          } else {
            const dx = motion && motionStart ? motion.position.x - motionStart.x : 0;
            const dy = motion && motionStart ? motion.position.y - motionStart.y : 0;
            boxes.set(id, { x: x + dx, y: y + dy, w, h, tx: x, ty: y, tw: w, th: h, vx: 0, vy: 0, alpha: 1, seen: now, label, color, rgb, motion, motionStart });
          }
        });
        if (sampledAt !== undefined) {
          for (const id of boxes.keys()) if (!seen.has(id)) boxes.delete(id);
        }
        previousResult = result;
      }
      const dt = Math.min(50, now - previousTime); previousTime = now;
      const smoothing = reduced.matches || sampledAt !== undefined ? 1 : 1 - Math.exp(-dt / 90);
      const predictionMs = sampledAt === undefined ? 0 : Math.min(MAX_PREDICTION_MS, Math.max(0, now - sampledAt));
      const mediaTime = presentedTime;
      const startTime = result?.motionFrame?.time;
      const endTime = futureResult?.motionFrame?.time;
      const span = startTime !== undefined && endTime !== undefined ? endTime - startTime : 0;
      const progress = startTime !== undefined && span > 0 && span <= MAX_SIMULATION_SAMPLE_GAP_MS
        ? Math.max(0, Math.min(1, (mediaTime - startTime) / span))
        : undefined;
      boxes.forEach((box, id) => {
        const stale = now - box.seen > holdMs;
        box.alpha = sampledAt !== undefined ? Number(!stale) : box.alpha + ((stale ? 0 : 1) - box.alpha) * smoothing;
        if (stale && (box.alpha < 0.03 || reduced.matches)) {
          // Retain the latest simulation observation for velocity estimation.
          if (sampledAt === undefined) boxes.delete(id);
          return;
        }
        const motion = box.motion?.matched && box.motionStart ? box.motion : undefined;
        const driftMs = motion ? Math.min(120, Math.max(0, mediaTime - motion.frame.time)) : predictionMs;
        const dx = motion && box.motionStart ? motion.position.x - box.motionStart.x : 0;
        const dy = motion && box.motionStart ? motion.position.y - box.motionStart.y : 0;
        let xTarget = box.tx + dx + (motion?.velocity.x ?? box.vx) * driftMs;
        let yTarget = box.ty + dy + (motion?.velocity.y ?? box.vy) * driftMs;
        let wTarget = box.tw, hTarget = box.th;
        const future = futureBoxes.get(id);
        if (future && progress !== undefined) {
          const x = box.tx + (future.x1 - box.tx) * progress;
          const y = box.ty + (future.y1 - box.ty) * progress;
          // Use observed motion within the interval and meet the next detection
          // at its timestamp, avoiding a jump when the new result takes over.
          const weight = motion ? progress : 1;
          xTarget += (x - xTarget) * weight;
          yTarget += (y - yTarget) * weight;
          wTarget += (future.x2 - future.x1 - box.tw) * progress;
          hTarget += (future.y2 - future.y1 - box.th) * progress;
        }
        box.x += (xTarget - box.x) * smoothing;
        box.y += (yTarget - box.y) * smoothing;
        box.w += (wTarget - box.w) * smoothing; box.h += (hTarget - box.h) * smoothing;
        const x = ox + box.x * cw, y = oy + box.y * ch, w = box.w * cw, h = box.h * ch;
        const c = Math.min(20, w / 3, h / 3);
        context.globalAlpha = box.alpha;
        context.strokeStyle = `rgba(${box.rgb},.35)`; context.lineWidth = 1; context.strokeRect(x, y, w, h);
        context.strokeStyle = box.color; context.lineWidth = 2.5; context.lineCap = "round"; context.lineJoin = "round";
        context.beginPath();
        context.moveTo(x, y + c); context.lineTo(x, y); context.lineTo(x + c, y);
        context.moveTo(x + w - c, y); context.lineTo(x + w, y); context.lineTo(x + w, y + c);
        context.moveTo(x + w, y + h - c); context.lineTo(x + w, y + h); context.lineTo(x + w - c, y + h);
        context.moveTo(x + c, y + h); context.lineTo(x, y + h); context.lineTo(x, y + h - c); context.stroke();
        context.font = "500 15px 'IBM Plex Sans Variable', sans-serif";
        const labelWidth = Math.min(width - 8, context.measureText(box.label).width + 20);
        const lx = Math.max(4, Math.min(width - labelWidth - 4, x)), ly = y > 40 ? y - 38 : y + 4;
        context.fillStyle = "rgba(12,17,25,.95)"; context.beginPath(); context.roundRect(lx, ly, labelWidth, 32, 4); context.fill();
        context.fillStyle = box.color; context.fillRect(lx, ly + 6, 2, 20); context.fillText(box.label, lx + 10, ly + 22);
      });
      context.globalAlpha = 1;
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animation);
      if (videoCallback !== undefined) video?.cancelVideoFrameCallback(videoCallback);
    };
  }, [visible, videoRef, nextResult]);
  return visible ? <canvas ref={canvasRef} className="tracking-overlay" aria-label="Subject tracking boxes" /> : null;
}
