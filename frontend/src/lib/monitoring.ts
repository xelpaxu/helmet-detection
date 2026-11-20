export type Session = { id: string; camera: string; started_at: string; ended_at: string | null; duration_ms: number; status: string; recording_status: string; frames: number; chunks: number; incident_count: number; error: string; recording_bytes: number };
export type Incident = { id: string; session_id: string; track_id: number; camera: string; started_at: string; first_seen_ms: number; confirmed_ms: number; last_seen_ms: number; best_ms: number; duration_ms: number; confidence: number; samples: number; state: string; review_status: "new" | "reviewed" | "dismissed"; notes: string; close_reason: string | null; entry_frame: number; confirmed_frame: number; exit_frame: number; best_frame: number; evidence: Record<"entry" | "best" | "exit", string>; video_url: string | null; recording_status: string; clip_start_ms: number; clip_end_ms: number; box: { x1: number; y1: number; x2: number; y2: number } };
export function timecode(ms: number, precise = false) {
  const value = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(value / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}${precise ? `.${String(value % 1000).padStart(3, "0")}` : ""}`;
}
export function wallTime(start: string, ms = 0) { return new Date(new Date(start).getTime() + ms).toLocaleString(); }
export function localDate(start: string) { const date = new Date(start); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export const shortId = (id: string) => id.slice(0, 8).toUpperCase();
