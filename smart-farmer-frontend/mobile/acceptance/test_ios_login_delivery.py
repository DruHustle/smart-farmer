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
