from fractions import Fraction
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

import av
from PIL import Image

from app.monitoring import Store, Tracker


def frame():
    buffer = BytesIO()
    Image.new("RGB", (160, 120), "gray").save(buffer, "JPEG")
    return buffer.getvalue()


def hit(x=0.1, label="no_helmet", confidence=0.8):
    return {"label": label, "class_id": 1 if label == "no_helmet" else 0,
            "confidence": confidence, "normalized_box": {"x1": x, "y1": 0.2, "x2": x + 0.15, "y2": 0.6}}


def make_video(path):
    with av.open(str(path), "w", format="webm") as output:
        stream = output.add_stream("libvpx", rate=10)
        stream.width, stream.height, stream.pix_fmt = 160, 120, "yuv420p"
        stream.options = {"deadline": "realtime", "cpu-used": "8"}
        for i in range(60):
            image = av.VideoFrame.from_image(Image.new("RGB", (160, 120), (i * 3, 90, 70)))
            image.pts, image.time_base = i, Fraction(1, 10)
            for packet in stream.encode(image):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


class MonitoringTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name))
        self.session = self.store.create("North intersection")
        self.tracker = Tracker(self.store, self.session["id"])
        self.image = frame()

    def tearDown(self):
        self.temp.cleanup()

    def update(self, ms, hits, index=None):
        return self.tracker.update(hits, ms, index or int(ms / 500) + 1, self.image)

    def test_confirmation_deduplication_timestamps_and_review_survive_restart(self):
        self.update(0, [hit(), hit(0.101, confidence=0.7)])
        self.update(500, [hit(0.11)])
        self.assertEqual(self.store.incidents(), [])
        result = self.update(1000, [hit(0.12, confidence=0.85)])
        self.update(1500, [hit(0.13, confidence=0.95)])
        self.assertEqual(len(result), 1)
        row = self.store.incidents()[0]
        self.assertEqual((row["first_seen_ms"], row["confirmed_ms"], row["last_seen_ms"]), (0, 1000, 1500))
        self.assertEqual(row["samples"], 4)
        self.assertEqual(row["best_ms"], 1500)
        self.assertEqual(row["confidence"], 0.95)
        for kind in ("entry", "best", "exit"):
            self.assertTrue((self.store.directory(self.session["id"]) / f"{row['id']}-{kind}.jpg").is_file())
        self.store.review(row["id"], "reviewed", "Checked by enforcer")
        restarted = Store(Path(self.temp.name))
        restarted.recover()
        row = restarted.incident(row["id"])
        self.assertEqual(row["review_status"], "reviewed")
        self.assertEqual(row["notes"], "Checked by enforcer")
        self.assertEqual(row["state"], "closed")
        self.assertEqual(row["close_reason"], "server_interrupted")

    def test_two_subjects_and_short_gap_keep_distinct_tracks(self):
        for ms in (0, 500, 1000):
            self.update(ms, [hit(0.1), hit(0.7)])
        ids = {row["track_id"] for row in self.store.incidents()}
        self.assertEqual(len(ids), 2)
        self.update(1500, [])
        self.update(2000, [hit(0.11), hit(0.69)])
        self.assertEqual({row["track_id"] for row in self.store.incidents()}, ids)
        self.assertEqual(len(self.store.incidents()), 2)

    def test_fast_rider_keeps_head_track_and_incident_through_a_missed_frame(self):
        def rider(x):
            bike = hit(x, "bike_with_rider")
            bike["normalized_box"].update(x2=x + 0.24, y1=0.25, y2=0.7)
            head = hit(x + 0.10)
            head["normalized_box"].update(x2=x + 0.14, y1=0.21, y2=0.3)
            return [bike, head]

        first = self.update(0, rider(0.05))
        self.update(600, rider(0.18))
        self.update(1200, rider(0.31))
        self.update(1800, [])
        last = self.update(2400, rider(0.57))
        self.assertEqual([d["track_id"] for d in last], [d["track_id"] for d in first])
        self.assertEqual(last[1]["rider_track_id"], last[0]["track_id"])
        incidents = self.store.incidents()
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0]["last_seen_ms"], 2400)

    def test_false_positive_streak_resets_and_reentry_creates_new_incident(self):
        self.update(0, [hit()])
        self.update(500, [hit(label="helmet")])
        self.update(1000, [hit()])
        self.update(1500, [])
        self.update(2000, [hit()])
        self.assertEqual(self.store.incidents(), [])
        self.update(2500, [hit()])
        self.update(3000, [hit()])
        self.update(6500, [])
        row = self.store.incidents()[0]
        self.assertEqual(row["last_seen_ms"], 3000)
        self.assertEqual(row["close_reason"], "left_frame")
        for ms in (7000, 7500, 8000):
            self.update(ms, [hit()])
        self.assertEqual(len(self.store.incidents()), 2)

    def test_recording_chunks_idempotency_finalization_seek_and_clip(self):
        for ms in (1000, 1500, 2000):
            self.update(ms, [hit()])
        self.update(2500, [hit()])
        self.tracker.finish()
        source = Path(self.temp.name) / "fixture.webm"
        make_video(source)
        data = source.read_bytes()
        midpoint = len(data) // 2
        self.store.chunk(self.session["id"], 0, data[:midpoint])
        self.store.chunk(self.session["id"], 0, data[:midpoint])
        with self.assertRaises(ValueError):
            self.store.chunk(self.session["id"], 0, b"different")
        with self.assertRaises(ValueError):
            self.store.chunk(self.session["id"], 2, data[midpoint:])
        self.store.chunk(self.session["id"], 1, data[midpoint:])
        with self.assertRaises(ValueError):
            self.store.finalize(self.session["id"], 3, 6000)
        session = self.store.finalize(self.session["id"], 2, 6000)
        self.assertEqual(session["recording_status"], "ready")
        with av.open(str(self.store.directory(session["id"]) / "recording.webm")) as recording:
            self.assertGreater(recording.duration, 5000000)
            recording.seek(3000000)
            self.assertIsNotNone(next(recording.decode(video=0)))
        path = self.store.clip(self.store.incidents()[0]["id"])
        with av.open(str(path)) as clip:
            self.assertGreater(clip.duration, 3000000)
            self.assertLess(clip.duration, 5000000)
        self.assertEqual(self.store.finalize(session["id"], 2, 6000)["recording_status"], "ready")

    def test_retention_and_path_validation(self):
        with self.assertRaises((ValueError, AttributeError)):
            self.store.directory("../../outside")
        self.store.end(self.session["id"])
        with self.store.connect() as db:
            db.execute("UPDATE sessions SET started_at='2000-01-01T00:00:00+00:00' WHERE id=?", (self.session["id"],))
        self.store.recover()
        self.assertEqual(self.store.sessions(), [])
        self.assertFalse(self.store.directory(self.session["id"]).exists())

    def test_interrupted_chunk_commit_recovery_and_empty_session(self):
        folder = self.store.directory(self.session["id"])
        (folder / "chunk-00000000.bin").write_bytes(b"saved before crash")
        self.store.recover()
        session = self.store.session(self.session["id"])
        self.assertEqual(session["chunks"], 1)
        self.assertEqual(session["recording_status"], "incomplete")
        empty = self.store.create("Cancelled camera")
        result = self.store.finalize(empty["id"], 0, 0)
        self.assertEqual(result["recording_status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
