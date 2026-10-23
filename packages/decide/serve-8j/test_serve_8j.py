"""serve_8j's HTTP layer with a fake model: contract, validation, loopback-only, fail closed.

    python -m unittest test_serve_8j      (stdlib only; no torch, no weights)
"""

import json
import threading
import unittest
import urllib.error
import urllib.request

import serve_8j


def fake_answer(state, question, guidance):
    if state == "boom":
        raise RuntimeError("model failed")
    if question["type"] == "noul":
        return {"type": "noul", "noul": 0.9 if "danger" in state else 0.1}
    if question["type"] == "choice":
        keys = list(question["criteria"])
        return {"type": "choice", "choice": keys[0], "probabilities": {k: 1 / len(keys) for k in keys}}
    n = len(question["criteria"])
    return {"type": "score", "score": 0.0, "probabilities": [1 / n] * n}


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = serve_8j.make_server("127.0.0.1", 0, fake_answer, {"model": "8j-fake", "base": "base-fake"})
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(self.url + "/v1/systemone", data=data, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_health(self):
        with urllib.request.urlopen(self.url + "/health", timeout=5) as r:
            self.assertEqual(json.loads(r.read()), {"ok": True, "model": "8j-fake", "base": "base-fake"})

    def test_noul(self):
        status, body = self.post({"state": "danger", "questions": {"q": {"type": "noul", "instructions": "Risky?"}}})
        self.assertEqual(status, 200)
        self.assertEqual(body["model"], "8j-fake")
        self.assertEqual(body["answers"]["q"], {"type": "noul", "noul": 0.9})

    def test_all_three_types(self):
        status, body = self.post({"state": "s", "questions": {
            "a": {"type": "noul", "instructions": "i", "criteria": {"false": "safe", "true": "unsafe"}},
            "b": {"type": "choice", "instructions": "i", "criteria": {"x": None, "y": "why"}},
            "c": {"type": "score", "instructions": "i", "criteria": ["low", "mid", "high"]}}})
        self.assertEqual(status, 200)
        self.assertEqual(set(body["answers"]), {"a", "b", "c"})
        self.assertEqual(len(body["answers"]["c"]["probabilities"]), 3)

    def test_invalid_requests_are_400(self):
        for bad in [b"not json", [], {"state": 1, "questions": {"q": {"type": "noul", "instructions": "i"}}},
                    {"state": "s", "questions": {}},
                    {"state": "s", "questions": {"q": {"type": "maybe", "instructions": "i"}}},
                    {"state": "s", "questions": {"q": {"type": "noul", "instructions": ""}}},
                    {"state": "s", "questions": {"q": {"type": "noul", "instructions": "i", "criteria": {"x": "y"}}}},
                    {"state": "s", "questions": {"q": {"type": "choice", "instructions": "i", "criteria": {"x": None}}}},
                    {"state": "s", "questions": {"q": {"type": "score", "instructions": "i", "criteria": ["one"]}}}]:
            status, body = self.post(bad)
            self.assertEqual(status, 400, bad)
            self.assertEqual(body["error"]["type"], "invalid_request")

    def test_oversize_body_is_413(self):
        status, _ = self.post(b"x" * (serve_8j.MAX_BODY_BYTES + 1))
        self.assertEqual(status, 413)

    def test_model_error_is_500_with_no_verdict(self):
        status, body = self.post({"state": "boom", "questions": {"q": {"type": "noul", "instructions": "i"}}})
        self.assertEqual(status, 500)
        self.assertNotIn("answers", body)
        self.assertEqual(body["error"], {"type": "model_error", "message": "RuntimeError"})


class LoopbackTest(unittest.TestCase):
    def test_loopback_hosts(self):
        for h in ["127.0.0.1", "127.8.9.10", "::1", "localhost"]:
            self.assertTrue(serve_8j.is_loopback(h), h)
        for h in ["0.0.0.0", "10.0.0.5", "::", "example.com", ""]:
            self.assertFalse(serve_8j.is_loopback(h), h)

    def test_refuses_to_bind_off_loopback(self):
        with self.assertRaises(ValueError):
            serve_8j.make_server("0.0.0.0", 0, fake_answer, {"model": "m"})

    def test_cli_refuses_off_loopback(self):
        with self.assertRaises(SystemExit):
            serve_8j.main(["--ckpt", "/nonexistent", "--host", "0.0.0.0"])


if __name__ == "__main__":
    unittest.main()
