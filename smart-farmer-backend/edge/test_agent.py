import json
import tempfile
import unittest
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError
from uuid import uuid4

from agent import EdgeAgent, EdgeState, validate_event


class FakeResponse:
    def __init__(self, body=b'{"accepted":true,"duplicate":false}', content_type="application/json", status=202):
        self.body = body
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type
    def read(self, limit): return self.body[:limit]
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

    def test_only_a_farmer_receipt_releases_the_reading(self):
        event = sample()
        self.agent.ingest(json.dumps(event).encode(), "a" * 40)
        for response in (
            FakeResponse(b"<html>Maintenance</html>", "text/html", 200),
            FakeResponse(b'{"accepted":true}'),
            FakeResponse(b'{'),
            FakeResponse(b'{"accepted":false,"duplicate":false}'),
            FakeResponse(b'{"accepted":true,"duplicate":false,"eventId":null}'),
            FakeResponse(b" " * 1024 + b'{"accepted":true,"duplicate":false}'),
        ):
            with self.subTest(body=response.body[:40]):
                self.agent.opener = lambda request, timeout: response
                self.assertFalse(self.agent.deliver_once())
                self.state.conn.execute("UPDATE outbox SET next_attempt=0")
                self.assertEqual(self.state.due()[0], event["eventId"])
        receipt = {"accepted": True, "duplicate": True, "eventId": event["eventId"]}
        self.agent.opener = lambda request, timeout: FakeResponse(json.dumps(receipt).encode())
        self.assertTrue(self.agent.deliver_once())
        self.assertIsNone(self.state.due())

    def test_authentication_outage_retries_after_restart(self):
        event = sample()
        self.agent.ingest(json.dumps(event).encode(), "a" * 40)
        def unavailable(request, timeout):
            raise HTTPError(request.full_url, 401, "Unauthorized", {}, None)
        self.agent.opener = unavailable
        self.assertFalse(self.agent.deliver_once())
        self.state.conn.close()
        self.state = EdgeState(self.path)
        self.agent.state = self.state
        self.state.conn.execute("UPDATE outbox SET next_attempt=0")
        self.assertEqual(self.state.due()[0], event["eventId"])
        self.agent.opener = lambda request, timeout: FakeResponse()
        self.assertTrue(self.agent.deliver_once())

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

    def test_full_queue_never_discards_unacknowledged_events(self):
        self.state.conn.close()
        self.state = EdgeState(self.path, max_pending=1)
        self.agent.state = self.state
        from uuid import uuid4
        first = sample()
        second = sample()
        second["eventId"] = str(uuid4())
        self.assertEqual(self.agent.ingest(json.dumps(first).encode(), "a" * 40)[0], 202)
        self.assertEqual(self.agent.ingest(json.dumps(second).encode(), "a" * 40)[0], 503)
        self.assertEqual(self.state.due()[0], first["eventId"])

    def test_plaintext_external_endpoint_is_refused(self):
        with self.assertRaises(ValueError):
            EdgeAgent(self.state, "pi-farm-1", {"pivot-1"}, "a" * 40, "b" * 40,
                      "http://public.example.test")
        with self.assertRaises(ValueError):
            EdgeAgent(self.state, "pi-farm-1", {"pivot-1"}, "a" * 40, "b" * 40,
                      "https://user:pass@public.example.test")


if __name__ == "__main__":
    unittest.main()
