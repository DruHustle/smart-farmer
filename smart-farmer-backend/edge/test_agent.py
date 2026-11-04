import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from agent import EdgeAgent, EdgeState, validate_event


class FakeResponse:
    status = 202
    def __enter__(self): return self
    def __exit__(self, *_): pass


def sample():
    return {
        "schemaVersion": 1, "eventId": str(uuid4()), "sourceId": "pivot-1",
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "kind": "measurement",
        "data": {"assetId": "pivot-1", "metric": "pressure", "value": 3.4, "unit": "bar"}
    }


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "edge.sqlite3"
        self.state = EdgeState(self.path)
        self.outbound = []
        def opener(request, timeout):
            self.outbound.append(request)
            return FakeResponse()
        self.agent = EdgeAgent(
            self.state, "pi-farm-1", {"pivot-1"}, "a" * 40, "b" * 40,
            "https://api.example.test", opener=opener
        )

    def tearDown(self):
        self.state.conn.close()
        self.directory.cleanup()

    def test_local_identity_and_source_policy(self):
        event = sample()
        body = json.dumps(event).encode()
        self.assertEqual(self.agent.ingest(body, "wrong")[0], 401)
        self.assertEqual(self.agent.ingest(body, "a" * 40)[0], 202)
        self.assertTrue(self.agent.ingest(body, "a" * 40)[1]["duplicate"])
        event["sourceId"] = "unknown-device"
        self.assertEqual(self.agent.ingest(json.dumps(event).encode(), "a" * 40)[0], 400)

    def test_reboot_replay_preserves_identity(self):
        event = sample()
        self.assertEqual(self.agent.ingest(json.dumps(event).encode(), "a" * 40)[0], 202)
        self.state.conn.close()
        self.state = EdgeState(self.path)
        self.agent.state = self.state
        self.assertEqual(self.state.due()[0], event["eventId"])
        self.assertTrue(self.agent.deliver_once())
        self.assertEqual(self.state.due(), None)
        self.assertEqual(self.outbound[0].get_method(), "POST")
        self.assertEqual(self.outbound[0].full_url, "https://api.example.test/v1/edge/pi-farm-1/events")
        self.assertIsNotNone(self.outbound[0].get_header("X-edge-signature"))

    def test_conflicting_identity_never_silently_overwrites(self):
        event = sample()
        self.agent.ingest(json.dumps(event).encode(), "a" * 40)
        event["data"]["value"] = 5.0
        self.assertEqual(self.agent.ingest(json.dumps(event).encode(), "a" * 40)[0], 400)
        self.assertIsNotNone(self.state.due())

    def test_invalid_measurement_never_enters_queue(self):
        event = sample()
        event["data"]["value"] = float("inf")
        with self.assertRaises(ValueError):
            validate_event(event, {"pivot-1"})
        self.assertEqual(self.agent.ingest(json.dumps(event).encode(), "a" * 40)[0], 400)
        self.assertEqual(self.state.due(), None)
        event = sample()
        event["data"]["controlCommand"] = "start"
        self.assertEqual(self.agent.ingest(json.dumps(event).encode(), "a" * 40)[0], 400)

    def test_plaintext_external_endpoint_is_refused(self):
        with self.assertRaises(ValueError):
            EdgeAgent(self.state, "pi-farm-1", {"pivot-1"}, "a" * 40, "b" * 40,
                      "http://public.example.test")
        with self.assertRaises(ValueError):
            EdgeAgent(self.state, "pi-farm-1", {"pivot-1"}, "a" * 40, "b" * 40,
                      "https://user:pass@public.example.test")


if __name__ == "__main__":
    unittest.main()
