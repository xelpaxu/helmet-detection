"""Integration checks using the actual local checkpoint: python -m unittest discover -s tests -v."""
from io import BytesIO
import unittest
import tempfile
import os
from threading import Event
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from PIL import Image

from app.main import Detector, app


class SmallObjectTest(unittest.TestCase):
    def test_tiled_boxes_map_back_to_frame_and_merge(self):
        detector = Detector()
        detector.classes = ["helmet"]
        frame = BytesIO()
        Image.new("RGB", (100, 80)).save(frame, format="JPEG")
        full = ([(52, 42, 60, 50)], [0.8], [0])
        empty = ([], [], [])
        lower_right = ([(12, 10, 20, 18), (48, 36, 54, 42)], [0.9, 0.85], [0, 0])
        with patch.object(detector, "infer", side_effect=[full, empty, empty, empty, lower_right]) as infer:
            result = detector.predict(frame.getvalue(), 0.5, small_objects=True)
        self.assertEqual([call.args[0].size for call in infer.call_args_list], [(100, 80)] + [(60, 48)] * 4)
        self.assertEqual([d["normalized_box"] for d in result["detections"]], [
            {"x1": 0.52, "y1": 0.525, "x2": 0.6, "y2": 0.625},
            {"x1": 0.88, "y1": 0.85, "x2": 0.94, "y2": 0.925},
        ])


class APITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {"MONITOR_DATA_DIR": cls.temp.name})
        cls.environment.start()
        os.environ.pop("MODEL_PATH", None)
        cls.client = TestClient(app)
        cls.client.__enter__()
        buffer = BytesIO()
        Image.new("RGB", (320, 240), "gray").save(buffer, format="JPEG")
        cls.frame = buffer.getvalue()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        cls.environment.stop()
        cls.temp.cleanup()

    def test_health_and_labels(self):
        result = self.client.get("/health")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["classes"], ["helmet", "no_helmet"])
        self.assertTrue(result.json()["simulation_ready"])
        self.assertEqual([model["id"] for model in result.json()["camera_models"]], ["yolo", "rf-detr"])
        self.assertEqual(self.client.get("/api/model").json()["name"], "YOLOv8")

    def test_selected_camera_model_is_used_for_inference(self):
        model = Mock()
        model.predict.return_value = {"width": 320, "height": 240, "inference_ms": 7, "detections": []}
        with patch.dict(app.state.camera_models, {"rf-detr": model}):
            with self.client.websocket_connect("/ws/detect?model=rf-detr") as socket:
                socket.send_bytes(self.frame)
                self.assertEqual(socket.receive_json()["inference_ms"], 7)
        model.predict.assert_called_once_with(self.frame, 0.5, small_objects=False)
        with self.client.websocket_connect("/ws/detect?model=missing") as socket:
            self.assertEqual(socket.receive_json()["code"], "model_unavailable")

    def test_reports_inference_and_tracking_failures_separately(self):
        with patch.object(app.state.detector, "predict", side_effect=RuntimeError("model test failure")):
            with self.assertLogs("app.main", level="ERROR") as logs:
                with self.client.websocket_connect("/ws/detect") as socket:
                    socket.send_bytes(self.frame)
                    self.assertEqual(socket.receive_json()["code"], "inference_failed")
            self.assertIn("model=YOLOv8", logs.output[0])

        session = self.client.post("/api/sessions", json={"camera": "Tracking failure test"}).json()["id"]
        self.client.post(f"/api/sessions/{session}/clock", json={"started_at": "2026-11-07T00:00:00+08:00"})
        result = {"width": 320, "height": 240, "inference_ms": 1, "detections": []}
        with patch.object(app.state.detector, "predict", return_value=result), \
                patch("app.main.Tracker.update", side_effect=RuntimeError("tracking test failure")):
            with self.assertLogs("app.main", level="ERROR"):
                with self.client.websocket_connect(f"/ws/detect?session_id={session}") as socket:
                    socket.send_json({"type": "frame", "captured_ms": 100, "frame_index": 1})
                    socket.send_bytes(self.frame)
                    self.assertEqual(socket.receive_json()["code"], "tracking_failed")

    def test_tracked_frame_is_dropped_when_detector_is_busy(self):
        entered, release = Event(), Event()
        session = self.client.post("/api/sessions", json={"camera": "Busy camera"}).json()["id"]
        self.client.post(f"/api/sessions/{session}/clock", json={"started_at": "2026-11-07T00:00:00+08:00"})

        def predict(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("Test never released the first inference")
            return {"width": 320, "height": 240, "inference_ms": 7, "detections": []}

        with patch.object(app.state.detector, "predict", side_effect=predict):
            with self.client.websocket_connect("/ws/detect") as first:
                first.send_bytes(self.frame)
                self.assertTrue(entered.wait(5))
                try:
                    with self.client.websocket_connect(f"/ws/detect?session_id={session}") as second:
                        second.send_json({"type": "frame", "captured_ms": 40, "frame_index": 1})
                        second.send_bytes(self.frame)
                        self.assertEqual(second.receive_json()["code"], "busy")
                        release.set()
                        self.assertEqual(first.receive_json()["type"], "detections")
                        first.send_bytes(self.frame)
                        self.assertEqual(first.receive_json()["code"], "busy")
                        second.send_json({"type": "frame", "captured_ms": 100, "frame_index": 2})
                        second.send_bytes(self.frame)
                        self.assertEqual(second.receive_json()["frame_index"], 2)
                finally:
                    release.set()

    def test_simulation_only_reports_no_helmet_on_motorcycle_riders(self):
        def hit(label, bounds):
            return {"label": label, "confidence": 0.9,
                    "normalized_box": dict(zip(("x1", "y1", "x2", "y2"), bounds))}

        bike = hit("bike_with_rider", (0.05, 0.2, 0.45, 0.8))
        rider = hit("no_helmet", (0.15, 0.19, 0.25, 0.29))
        pedestrian = hit("no_helmet", (0.65, 0.19, 0.75, 0.29))
        session = self.client.post("/api/sessions", json={"camera": "Simulation"}).json()["id"]
        self.client.post(f"/api/sessions/{session}/clock", json={"started_at": "2026-11-07T00:00:00+08:00"})
        detector = Mock()
        detector.predict.side_effect = lambda *_args, **_kwargs: {
            "width": 320, "height": 240, "inference_ms": 1, "detections": [pedestrian, bike, rider],
        }
        with patch.object(app.state, "rider_detector", detector):
            with self.client.websocket_connect(f"/ws/detect?session_id={session}&riders_only=true") as socket:
                for index in range(1, 4):
                    socket.send_json({"type": "frame", "captured_ms": index * 200, "frame_index": index})
                    socket.send_bytes(self.frame)
                    result = socket.receive_json()
                    self.assertEqual([hit["normalized_box"] for hit in result["detections"]],
                                     [bike["normalized_box"], rider["normalized_box"]])
        self.assertEqual(len(self.client.get(f"/api/incidents?session_id={session}").json()), 1)

    def test_http_inference(self):
        response = self.client.post("/api/detect", files={"file": ("frame.jpg", self.frame, "image/jpeg")})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["width"], body["height"]), (320, 240))
        self.assertGreater(body["inference_ms"], 0)
        for detection in body["detections"]:
            self.assertIn(detection["class_id"], range(3))
            self.assertTrue(all(0 <= value <= 1 for value in detection["normalized_box"].values()))

    def test_invalid_http(self):
        response = self.client.post("/api/detect", files={"file": ("bad.jpg", b"invalid", "image/jpeg")})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.post("/api/detect?threshold=2", files={"file": ("x.jpg", self.frame)}).status_code, 422)

    def test_websocket_inference_and_recovery(self):
        with self.client.websocket_connect("/ws/detect", headers={"origin": "http://localhost:3000"}) as socket:
            socket.send_text("invalid")
            self.assertEqual(socket.receive_json()["code"], "invalid_frame")
            socket.send_bytes(b"invalid")
            self.assertEqual(socket.receive_json()["code"], "invalid_frame")
            socket.send_bytes(self.frame)
            result = socket.receive_json()
            self.assertEqual(result["type"], "detections")
            self.assertEqual(result["width"], 320)
            self.assertEqual(result["frame_id"], 2)

    def test_websocket_origin(self):
        from starlette.websockets import WebSocketDisconnect
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect("/ws/detect", headers={"origin": "https://untrusted.example"}):
                pass

    def test_monitoring_protocol_incident_and_review(self):
        session = self.client.post("/api/sessions", json={"camera": "Test road"}).json()
        sid = session["id"]
        self.assertEqual(self.client.post(f"/api/sessions/{sid}/clock", json={"started_at": "2026-11-07T00:00:00+08:00"}).status_code, 200)
        detection = {"label": "no_helmet", "class_id": 1, "confidence": 0.9, "normalized_box": {"x1": 0.1, "y1": 0.1, "x2": 0.3, "y2": 0.5}}
        with patch.object(app.state.detector, "predict", return_value={"width": 320, "height": 240, "inference_ms": 1, "detections": [detection]}):
            with self.client.websocket_connect(f"/ws/detect?session_id={sid}") as socket:
                socket.send_bytes(self.frame)
                self.assertEqual(socket.receive_json()["code"], "invalid_frame")
                for index, ms in enumerate((100, 700, 1400), 1):
                    socket.send_json({"type": "frame", "captured_ms": ms, "frame_index": index})
                    socket.send_bytes(self.frame)
                    result = socket.receive_json()
                    self.assertEqual(result["captured_ms"], ms)
                    self.assertEqual(result["detections"][0]["track_id"], 1)
                socket.send_json({"type": "frame", "captured_ms": 100, "frame_index": 1})
                self.assertEqual(socket.receive_json()["code"], "invalid_frame")
        rows = self.client.get(f"/api/incidents?session_id={sid}").json()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["first_seen_ms"], row["confirmed_ms"], row["last_seen_ms"]), (100, 1400, 1400))
        self.assertEqual(row["state"], "closed")
        self.assertEqual(self.client.get(row["evidence"]["entry"]).status_code, 200)
        self.assertEqual(self.client.get(f"/api/sessions/{sid}/video").status_code, 409)
        review = self.client.patch(f"/api/incidents/{row['id']}", json={"review_status": "dismissed", "notes": "Test observation"})
        self.assertEqual(review.json()["review_status"], "dismissed")
        self.assertEqual(self.client.patch(f"/api/incidents/{row['id']}", json={"review_status": "invalid"}).status_code, 422)
        self.assertEqual(self.client.put(f"/api/sessions/{sid}/chunks/1", content=b"wrong order").status_code, 409)
        self.assertEqual(self.client.get("/api/incidents/missing").status_code, 404)


if __name__ == "__main__":
    unittest.main()
