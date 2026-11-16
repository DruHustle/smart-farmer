"""Verify the bounded receipt needed to retry a disconnected invoice-fixture login."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("delivery", Path(__file__).with_name("ios-login-delivery.py"))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


class LoginDelivery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.report = '<testsuite><testcase file="smart-farmer-frontend/mobile/acceptance/login.yaml"><failure>Assertion is false: id: auth-submit is not visible</failure></testcase></testsuite>'
        self.control = {"idRegex": "auth-submit", "optional": False}
        self.trace = [
            {"command": {"tapOnElement": {"selector": self.control}}, "metadata": {"status": "COMPLETED", "timestamp": 1000}},
            {"command": {"runFlowCommand": {"condition": {"platform": "IOS"}}}, "metadata": {"status": "FAILED"}},
            {"command": {"assertConditionCommand": {"condition": {"notVisible": self.control}}},
             "metadata": {"status": "FAILED", "timestamp": 1003, "duration": 8000}},
        ]
        self.proxy = [dict(timestamp=stamp(ms), method="POST", route="/v1/sessions", status=status)
                      for ms, status in [(1001, "pending"), (2300, "closed")]]
        self.api = [dict(time=stamp(1010), event="request.start", method="POST", path="/v1/sessions", id=7),
                    dict(time=stamp(2400), event="response.finish", status=200, finished=True, id=7)]
        (self.root / "ios-login/login").mkdir(parents=True)

    def check(self):
        (self.root / "ios-login.xml").write_text(self.report)
        (self.root / "ios-login/login/commands.json").write_text(json.dumps(self.trace))
        for name, events in [("proxy", self.proxy), ("api", self.api)]:
            (self.root / f"{name}.log").write_text("".join(f"[native-{name}] {json.dumps(e)}\n" for e in events))
        return delivery.one_lost_session(self.root)

    def test_client_only_error_requires_fields_and_both_live_observers(self):
        self.proxy = [dict(timestamp=stamp(900), method="GET", route="other", status=200)]
        self.api = [dict(time=stamp(ms), event="heartbeat", pending=[]) for ms in (900, 5000, 9500)]
        self.check()
        directory = self.root / "ios-login/login/screen-hierarchy"
        directory.mkdir()
        frame = directory / "step-037-assertCondition-auth-submit.json"
        attrs = [{"resource-id": "auth-username", "value": "native_owner", "enabled": "true"},
                 {"resource-id": "auth-password", "value": "•" * 25, "enabled": "true"},
                 {"resource-id": "auth-submit", "enabled": "true"},
                 {"accessibilityText": "Zadza mashoko anodiwa."}]

        def matches(controls):
            frame.write_text(json.dumps({"attributes": {}, "children": [{"attributes": a} for a in controls]}))
            return delivery.rejected_before_request(self.root)

        self.assertTrue(matches(attrs))
        self.assertFalse(matches(attrs[:-1]))
        self.assertFalse(matches([*attrs, attrs[0]]))
        self.assertFalse(matches([attrs[0], dict(attrs[1], value="x" * 25), *attrs[2:]]))
        self.proxy.append(dict(timestamp=stamp(1200), method="POST", route="/v1/sessions", status="pending"))
        self.check()
        self.assertFalse(matches(attrs))
        self.proxy.pop()
        self.api.append(dict(time=stamp(1210), event="request.start", method="POST", path="/v1/sessions"))
        self.check()
        self.assertFalse(matches(attrs))
        self.api = self.api[1:3]
        self.check()
        self.assertFalse(matches(attrs))

    def test_late_success_after_one_lost_request(self):
        self.assertTrue(self.check())

    def test_no_retry_on_other_flow(self):
        self.report = self.report.replace("login.yaml", "accounting-intake-post.yaml")
        self.assertFalse(self.check())

    def test_no_retry_on_denial_or_delivered_reply(self):
        for status in (401, 403, 409, 500):
            self.api[-1]["status"] = status
            self.assertFalse(self.check())
        self.api[-1]["status"] = 200
        self.proxy[-1]["status"] = 200
        self.assertFalse(self.check())

    def test_no_retry_on_ambiguous_or_unrelated_request(self):
        self.api.append(self.api[0])
        self.assertFalse(self.check())
        self.api.pop()
        self.api[1]["id"] = 8
        self.assertFalse(self.check())

    def test_no_retry_on_earlier_unrelated_success_or_other_action(self):
        self.api[1]["time"] = stamp(2000)
        self.assertFalse(self.check())
        self.api[1]["time"] = stamp(2400)
        self.proxy[0]["route"] = "/v1/farms"
        self.assertFalse(self.check())


if __name__ == "__main__":
    unittest.main()
