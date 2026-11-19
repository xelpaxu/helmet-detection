"""Persistent local incident store and session-scoped spatial tracking."""
from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from io import BytesIO
import json
from pathlib import Path
import shutil
import sqlite3
import threading
import uuid

from PIL import Image, ImageOps


def utcnow():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, root: Path, retention_days=7):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = self.root / "monitoring.sqlite3"
        self.lock = threading.RLock()
        self.clip_lock = threading.Lock()
        self.retention_days = retention_days
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, camera TEXT NOT NULL, started_at TEXT NOT NULL,
                    ended_at TEXT, duration_ms REAL DEFAULT 0, status TEXT DEFAULT 'active',
                    recording_status TEXT DEFAULT 'recording', chunks INTEGER DEFAULT 0,
                    frames INTEGER DEFAULT 0, last_capture_ms REAL DEFAULT 0,
                    error TEXT DEFAULT '', recording_bytes INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS incidents (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                    track_id INTEGER NOT NULL, first_seen_ms REAL, confirmed_ms REAL,
                    last_seen_ms REAL, entry_frame INTEGER, confirmed_frame INTEGER,
                    exit_frame INTEGER, best_frame INTEGER, best_ms REAL,
                    confidence REAL, samples INTEGER, state TEXT DEFAULT 'active',
                    review_status TEXT DEFAULT 'new', notes TEXT DEFAULT '',
                    close_reason TEXT, box_json TEXT
                );
                CREATE INDEX IF NOT EXISTS incident_session ON incidents(session_id);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def recover(self):
        with self.lock, self.connect() as db:
            db.execute("UPDATE incidents SET state='closed', close_reason='server_interrupted' WHERE state='active'")
            db.execute("UPDATE sessions SET status=CASE WHEN status='active' THEN 'interrupted' ELSE status END, ended_at=COALESCE(ended_at,?), recording_status='incomplete' WHERE status='active' OR recording_status IN ('recording','finalizing')", (utcnow(),))
            # A crash can occur after an atomic chunk rename but before its DB commit.
            for row in db.execute("SELECT id,chunks FROM sessions WHERE recording_status='incomplete'").fetchall():
                folder = self.directory(row["id"])
                count, size = 0, 0
                while (folder / f"chunk-{count:08d}.bin").is_file():
                    size += (folder / f"chunk-{count:08d}.bin").stat().st_size
                    count += 1
                if count > row["chunks"]:
                    db.execute("UPDATE sessions SET chunks=?,recording_bytes=? WHERE id=?", (count, size, row["id"]))
        if self.retention_days > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=self.retention_days)).isoformat()
            with self.lock, self.connect() as db:
                expired = db.execute("SELECT id FROM sessions WHERE started_at < ? AND status != 'active'", (cutoff,)).fetchall()
                for row in expired:
                    folder = self.directory(row["id"])
                    # Only UUID directories directly under the configured evidence root.
                    if folder.is_dir():
                        shutil.rmtree(folder)
                    db.execute("DELETE FROM incidents WHERE session_id=?", (row["id"],))
                    db.execute("DELETE FROM sessions WHERE id=?", (row["id"],))

    def directory(self, session_id):
        if str(uuid.UUID(session_id)) != session_id:
            raise ValueError("Invalid session ID")
        path = (self.root / session_id).resolve()
        if path.parent != self.root:
            raise ValueError("Invalid evidence directory")
        return path

    def create(self, camera):
        session_id = str(uuid.uuid4())
        self.directory(session_id).mkdir()
        with self.lock, self.connect() as db:
            db.execute("INSERT INTO sessions(id,camera,started_at) VALUES(?,?,?)", (session_id, camera, utcnow()))
        return self.session(session_id)

    def session(self, session_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        if row is None:
            raise KeyError("Session not found")
        return dict(row)

    def sessions(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT s.*, (SELECT COUNT(*) FROM incidents i WHERE i.session_id=s.id) incident_count FROM sessions s ORDER BY started_at DESC LIMIT 500")]

    def clock(self, session_id, started_at):
        with self.lock, self.connect() as db:
            if db.execute("UPDATE sessions SET started_at=? WHERE id=? AND frames=0 AND status='active'", (started_at, session_id)).rowcount != 1:
                raise ValueError("Session clock can only be set before the first frame")

    def frame(self, session_id, captured_ms):
        with self.lock, self.connect() as db:
            db.execute("UPDATE sessions SET frames=frames+1,last_capture_ms=?,duration_ms=MAX(duration_ms,?) WHERE id=?", (captured_ms, captured_ms, session_id))

    def end(self, session_id, duration_ms=None, reason="stopped"):
        with self.lock, self.connect() as db:
            db.execute("UPDATE incidents SET state='closed',close_reason=? WHERE session_id=? AND state='active'", (reason, session_id))
            db.execute("UPDATE sessions SET status=CASE WHEN status='active' THEN ? ELSE status END,ended_at=COALESCE(ended_at,?),duration_ms=MAX(duration_ms,?) WHERE id=?", (reason, utcnow(), duration_ms or 0, session_id))
            db.execute("UPDATE sessions SET recording_status='incomplete' WHERE id=? AND recording_status='recording'", (session_id,))

    def save_image(self, session_id, incident_id, name, data):
        path = self.directory(session_id) / f"{incident_id}-{name}.jpg"
        temp = path.with_suffix(".tmp")
        with Image.open(BytesIO(data)) as source:
            ImageOps.exif_transpose(source).convert("RGB").save(temp, format="JPEG", quality=90)
        temp.replace(path)

    def incidents(self, session_id=None):
        with self.connect() as db:
            query = "SELECT i.*,s.camera,s.started_at,s.recording_status,s.status session_status,s.duration_ms session_duration_ms FROM incidents i JOIN sessions s ON s.id=i.session_id"
            params = ()
            if session_id:
                query += " WHERE session_id=?"
                params = (session_id,)
            rows = db.execute(query + " ORDER BY s.started_at DESC,i.confirmed_ms DESC LIMIT 2000", params).fetchall()
        return [self.decorate(dict(row)) for row in rows]

    def incident(self, incident_id):
        with self.connect() as db:
            row = db.execute("SELECT i.*,s.camera,s.started_at,s.recording_status,s.status session_status,s.duration_ms session_duration_ms FROM incidents i JOIN sessions s ON s.id=i.session_id WHERE i.id=?", (incident_id,)).fetchone()
        if row is None:
            raise KeyError("Incident not found")
        return self.decorate(dict(row))

    def decorate(self, row):
        row["box"] = json.loads(row.pop("box_json"))
        row["duration_ms"] = row["last_seen_ms"] - row["first_seen_ms"]
        row["evidence"] = {kind: f"/api/incidents/{row['id']}/evidence/{kind}" for kind in ("entry", "best", "exit")}
        row["video_url"] = f"/api/sessions/{row['session_id']}/video" if row["recording_status"] == "ready" else None
        row["clip_start_ms"] = max(0, row["first_seen_ms"] - 2000)
        row["clip_end_ms"] = min(row["session_duration_ms"], row["last_seen_ms"] + 2000)
        return row

    def review(self, incident_id, status, notes):
        with self.lock, self.connect() as db:
            if db.execute("UPDATE incidents SET review_status=?,notes=? WHERE id=?", (status, notes, incident_id)).rowcount != 1:
                raise KeyError("Incident not found")
        return self.incident(incident_id)

    def chunk(self, session_id, index, data):
        with self.lock:
            session = self.session(session_id)
            if session["recording_status"] not in ("recording", "incomplete"):
                raise ValueError("Recording is already finalized")
            folder = self.directory(session_id)
            path = folder / f"chunk-{index:08d}.bin"
            if index < session["chunks"]:
                if path.read_bytes() != data:
                    raise ValueError("Chunk retry differs from the saved data")
                return
            if index != session["chunks"]:
                raise ValueError("Chunks must be uploaded sequentially")
            if session["recording_bytes"] + len(data) > 2 * 1024**3:
                raise ValueError("Session recording limit is 2 GiB; start a new session")
            temp = path.with_suffix(".tmp")
            temp.write_bytes(data)
            temp.replace(path)
            with self.connect() as db:
                db.execute("UPDATE sessions SET chunks=chunks+1,recording_bytes=recording_bytes+? WHERE id=?", (len(data), session_id))

    def finalize(self, session_id, expected_chunks, duration_ms):
        import av
        with self.lock:
            session = self.session(session_id)
            if session["recording_status"] == "ready":
                return session
            if session["chunks"] != expected_chunks:
                raise ValueError("Some recording chunks are missing; retry uploads before finalizing")
            if not expected_chunks:
                self.end(session_id, duration_ms)
                with self.connect() as db:
                    db.execute("UPDATE sessions SET recording_status='unavailable',error='Session stopped before any video was captured' WHERE id=?", (session_id,))
                return self.session(session_id)
            if session["recording_status"] == "finalizing":
                raise ValueError("Recording is already being finalized")
            with self.connect() as db:
                db.execute("UPDATE sessions SET recording_status='finalizing' WHERE id=?", (session_id,))
        self.end(session_id, duration_ms)
        folder = self.directory(session_id)
        raw = folder / "source.webm"
        try:
            if not expected_chunks:
                raise ValueError("No video chunks were received")
            with raw.open("wb") as output:
                for i in range(expected_chunks):
                    with (folder / f"chunk-{i:08d}.bin").open("rb") as source:
                        shutil.copyfileobj(source, output)
            # Remux, without re-encoding, to add duration and seek indexes to browser WebM.
            temp = folder / "recording.tmp.webm"
            packet_count = 0
            with av.open(str(raw)) as source, av.open(str(temp), "w", format="webm") as output:
                video = source.streams.video[0]
                stream = output.add_stream_from_template(video)
                for packet in source.demux(video):
                    if packet.dts is None:
                        continue
                    packet.stream = stream
                    output.mux(packet)
                    packet_count += 1
            if not packet_count:
                raise ValueError("Recording contains no video frames")
            temp.replace(folder / "recording.webm")
            with self.lock, self.connect() as db:
                db.execute("UPDATE sessions SET recording_status='ready',error='' WHERE id=?", (session_id,))
                db.execute("UPDATE sessions SET status='stopped' WHERE id=? AND status='disconnected'", (session_id,))
                db.execute("UPDATE incidents SET close_reason='session_stopped' WHERE session_id=? AND close_reason='disconnected'", (session_id,))
            # These paths are fixed children of the already validated session directory.
            raw.unlink(missing_ok=True)
            for i in range(expected_chunks):
                (folder / f"chunk-{i:08d}.bin").unlink(missing_ok=True)
        except Exception as exc:
            with self.lock, self.connect() as db:
                db.execute("UPDATE sessions SET recording_status='incomplete',error=? WHERE id=?", (str(exc)[:500], session_id))
            raise ValueError(f"Video could not be finalized: {exc}") from exc
        return self.session(session_id)

    def clip(self, incident_id):
        """Export a short, independently playable evidence clip with two seconds of context."""
        import av
        from fractions import Fraction
        with self.clip_lock:
            incident = self.incident(incident_id)
            if incident["recording_status"] != "ready" or incident["state"] != "closed":
                raise ValueError("Stop the session and finalize its recording before exporting a clip")
            folder = self.directory(incident["session_id"])
            target = folder / f"{incident_id}-clip.webm"
            if target.is_file():
                return target
            start, end = incident["clip_start_ms"] / 1000, incident["clip_end_ms"] / 1000
            temp = folder / f"{incident_id}-clip.tmp.webm"
            try:
                with av.open(str(folder / "recording.webm")) as source, av.open(str(temp), "w", format="webm") as output:
                    video = source.streams.video[0]
                    stream = output.add_stream("libvpx", rate=video.average_rate or 25)
                    stream.width, stream.height, stream.pix_fmt = video.width, video.height, "yuv420p"
                    stream.bit_rate = 1500000
                    stream.options = {"deadline": "realtime", "cpu-used": "8"}
                    source.seek(int(start * 1000000), backward=True)
                    encoded = 0
                    for frame in source.decode(video):
                        timestamp = float(frame.time or 0)
                        if timestamp < start:
                            continue
                        if timestamp > end:
                            break
                        frame.pts = round((timestamp - start) * 1000)
                        frame.time_base = Fraction(1, 1000)
                        for packet in stream.encode(frame):
                            output.mux(packet)
                        encoded += 1
                    for packet in stream.encode():
                        output.mux(packet)
                if not encoded:
                    raise ValueError("No recorded video overlaps this incident")
                temp.replace(target)
            except Exception:
                temp.unlink(missing_ok=True)
                raise
            return target


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0


def box_center(box):
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def rider_match(head, riders):
    x, y = box_center(head)
    matches = []
    for key, bike in riders:
        height = bike[3] - bike[1]
        if bike[0] <= x <= bike[2] and bike[1] - 0.1 * height <= y <= bike[1] + 0.55 * height:
            bx, _ = box_center(bike)
            matches.append((abs(x - bx) / max(1e-8, bike[2] - bike[0]), key))
    return min(matches)[1] if matches else None


def normalized_coordinates(detection):
    return [detection["normalized_box"][k] for k in ("x1", "y1", "x2", "y2")]


@dataclass
class Track:
    id: int
    group: str
    box: list
    first_ms: float
    last_ms: float
    entry_frame: int
    last_frame: int
    entry_image: bytes
    streak: int = 0
    incident_id: str | None = None
    velocity: tuple[float, float] = (0, 0)
    rider_id: int | None = None
    rider_box: list | None = None


class Tracker:
    """IoU/center association, not biometric identification or cross-camera re-ID."""
    def __init__(self, store, session_id, confirm_hits=3, missing_ms=3000):
        self.store, self.session_id = store, session_id
        self.confirm_hits, self.missing_ms = confirm_hits, missing_ms
        self.tracks = {}
        self.next_id = 1

    def expire(self, now_ms, reason="left_frame"):
        for track_id, track in list(self.tracks.items()):
            if now_ms - track.last_ms > self.missing_ms:
                if track.incident_id:
                    with self.store.lock, self.store.connect() as db:
                        db.execute("UPDATE incidents SET state='closed',close_reason=? WHERE id=?", (reason, track.incident_id))
                del self.tracks[track_id]

    def associate(self, observations, group, captured_ms, owners):
        candidates = []
        for index, box in observations:
            x, y = box_center(box)
            rider = owners.get(index)
            for track in self.tracks.values():
                if group != track.group:
                    continue
                if rider and track.rider_id is not None and rider.id != track.rider_id:
                    continue
                dt = min(1800, captured_ms - track.last_ms)
                dx, dy = (max(-0.25, min(0.25, v * dt)) for v in track.velocity)
                same_rider = rider is not None and track.rider_id == rider.id and track.rider_box is not None
                if same_rider:
                    bx, by = box_center(rider.box)
                    old_x, old_y = box_center(track.rider_box)
                    dx, dy = bx - old_x, by - old_y
                predicted = [track.box[0] + dx, track.box[1] + dy, track.box[2] + dx, track.box[3] + dy]
                scale = max(box[2] - box[0], box[3] - box[1], track.box[2] - track.box[0], track.box[3] - track.box[1])
                ratio = ((box[2] - box[0]) * (box[3] - box[1])) / max(1e-8, (track.box[2] - track.box[0]) * (track.box[3] - track.box[1]))
                radius = min(0.18, max(0.035, scale * (1.25 if same_rider else 0.8)))
                scores = []
                for reference, priority in ((predicted, 0.04), (track.box, 0)):
                    cx, cy = box_center(reference)
                    distance = ((x - cx)**2 + (y - cy)**2)**0.5
                    overlap = iou(box, reference)
                    if overlap >= 0.12 or (distance < radius and 0.3 < ratio < 3):
                        scores.append(overlap + max(0, 0.2 - distance) + priority)
                if scores:
                    candidates.append((max(scores) + (1 if same_rider else 0), index, track.id))
        assigned, used = {}, set()
        for _, index, track_id in sorted(candidates, reverse=True):
            if index not in assigned and track_id not in used:
                assigned[index] = track_id
                used.add(track_id)
        return assigned

    def update(self, detections, captured_ms, frame_index, image):
        self.expire(captured_ms)
        selected = []
        for detection in sorted(detections, key=lambda d: d["confidence"], reverse=True):
            box = normalized_coordinates(detection)
            group = "bike" if detection["label"] == "bike_with_rider" else "head"
            if any(group == g and iou(box, b) > 0.65 for _, b, g in selected):
                continue
            selected.append((detection, box, group))
        riders, owners, updated = [], {}, {}
        # Associate motorcycles first so heads can use the motorcycle's
        # displacement even when the head has moved several box widths.
        for group in ("bike", "head"):
            observations = [(i, box) for i, (_, box, kind) in enumerate(selected) if kind == group]
            if group == "head":
                for index, box in observations:
                    rider_id = rider_match(box, riders)
                    if rider_id is not None:
                        owners[index] = self.tracks[rider_id]
            assigned = self.associate(observations, group, captured_ms, owners)
            for index, box in observations:
                track = self.tracks.get(assigned.get(index))
                if track is None:
                    track = Track(self.next_id, group, box, captured_ms, captured_ms, frame_index, frame_index, image)
                    self.tracks[track.id] = track
                    self.next_id += 1
                else:
                    dt = captured_ms - track.last_ms
                    if dt > 0:
                        x, y = box_center(box)
                        ox, oy = box_center(track.box)
                        track.velocity = ((x - ox) / dt, (y - oy) / dt)
                track.box, track.last_ms, track.last_frame = box, captured_ms, frame_index
                if group == "bike":
                    riders.append((track.id, box))
                if index in owners:
                    track.rider_id, track.rider_box = owners[index].id, owners[index].box
                updated[index] = track
        results = []
        seen = set()
        for index, (detection, _, _) in enumerate(selected):
            track = updated[index]
            seen.add(track.id)
            track.streak = track.streak + 1 if detection["label"] == "no_helmet" else 0
            if track.streak >= self.confirm_hits and track.incident_id is None:
                track.incident_id = str(uuid.uuid4())
                self.store.save_image(self.session_id, track.incident_id, "entry", track.entry_image)
                self.store.save_image(self.session_id, track.incident_id, "best", image)
                with self.store.lock, self.store.connect() as db:
                    db.execute("INSERT INTO incidents(id,session_id,track_id,first_seen_ms,confirmed_ms,last_seen_ms,entry_frame,confirmed_frame,exit_frame,best_frame,best_ms,confidence,samples,box_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (track.incident_id, self.session_id, track.id, track.first_ms, captured_ms, captured_ms, track.entry_frame, frame_index, frame_index, frame_index, captured_ms, detection["confidence"], self.confirm_hits - 1, json.dumps(detection["normalized_box"])))
                track.entry_image = b""
            if track.incident_id:
                self.store.save_image(self.session_id, track.incident_id, "exit", image)
                with self.store.lock, self.store.connect() as db:
                    row = db.execute("SELECT confidence FROM incidents WHERE id=?", (track.incident_id,)).fetchone()
                    is_best = detection["label"] == "no_helmet" and detection["confidence"] > row["confidence"]
                    if is_best:
                        self.store.save_image(self.session_id, track.incident_id, "best", image)
                        db.execute("UPDATE incidents SET confidence=?,best_frame=?,best_ms=?,box_json=? WHERE id=?", (detection["confidence"], frame_index, captured_ms, json.dumps(detection["normalized_box"]), track.incident_id))
                    db.execute("UPDATE incidents SET last_seen_ms=?,exit_frame=?,samples=samples+? WHERE id=?", (captured_ms, frame_index, int(detection["label"] == "no_helmet"), track.incident_id))
            results.append({**detection, "track_id": track.id, "rider_track_id": owners[index].id if index in owners else None, "incident_id": track.incident_id, "tracking_state": "confirmed" if track.incident_id else "candidate" if track.streak else "tracking"})
        for track in self.tracks.values():
            if track.id not in seen:
                track.streak = 0
        self.store.frame(self.session_id, captured_ms)
        return results

    def finish(self, reason="stopped"):
        self.store.end(self.session_id, reason=reason)
        self.tracks.clear()
