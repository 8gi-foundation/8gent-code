#!/usr/bin/env python3
"""Transparent logging proxy for Ollama: shows what the model was actually sent.

    ollama_tap.py LISTEN_PORT UPSTREAM_URL LOG_FILE

Appends one JSON line per POST /api/chat or /api/generate request (messages, options,
tool list names) and the first 400 chars of each reply. Standard library only, so it
runs inside any task container that has python3. Request bodies hold task text and
model messages, never credentials, because this adapter forwards none.
"""
import json
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, UPSTREAM, LOG = int(sys.argv[1]), sys.argv[2].rstrip("/"), sys.argv[3]


def log(rec):
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


class H(BaseHTTPRequestHandler):
    def _fwd(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        rec = {"path": self.path, "method": self.command}
        if body and self.path.startswith(("/api/chat", "/api/generate", "/v1/chat")):
            try:
                d = json.loads(body)
                rec["model"] = d.get("model")
                rec["options"] = d.get("options")
                rec["tools"] = [t.get("function", {}).get("name") for t in d.get("tools") or []]
                rec["messages"] = d.get("messages") if "messages" in d else d.get("prompt")
            except Exception as e:  # noqa: BLE001
                rec["parse_error"] = str(e)
        req = urllib.request.Request(
            UPSTREAM + self.path, data=body, method=self.command,
            headers={k: v for k, v in self.headers.items() if k.lower() != "host"},
        )
        try:
            with urllib.request.urlopen(req, timeout=3600) as r:
                self.send_response(r.status)
                for k, v in r.getheaders():
                    if k.lower() not in ("transfer-encoding", "connection"):
                        self.send_header(k, v)
                self.end_headers()
                first = b""
                while chunk := r.read(4096):
                    if len(first) < 400:
                        first += chunk
                    self.wfile.write(chunk)
                    self.wfile.flush()
                rec["reply_head"] = first[:400].decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            rec["error"] = str(e)
            self.send_response(502)
            self.end_headers()
        if rec["path"].startswith(("/api/chat", "/api/generate", "/v1/chat")):
            log(rec)

    do_GET = do_POST = _fwd

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
