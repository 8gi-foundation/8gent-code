"""Serve 8J on this machine: POST /v1/systemone and GET /health.

8J is Artale's System One decision model (HF 8GI/8j). This is the `serve_8j.py` its model card
names, which was not published with the weights. It loads one checkpoint once and answers the
card's contract:

    POST /v1/systemone
    {"state": "...", "guidance": "optional",
     "questions": {"<id>": {"type": "noul" | "choice" | "score", "instructions": "...",
                            "criteria": {"<key>": "<text>"} | ["<level>", ...]}}}
    -> {"model": "<run>", "answers": {"<id>": {"type": "noul", "noul": p_yes} | ...},
        "latency_ms": n}

    GET /health -> {"ok": true, "model": "<run>", "base": "<backbone>"}

It binds to a loopback address only (127.0.0.0/8, ::1, localhost) and refuses anything else:
the state is a shell command the harness has not run yet, and it never leaves the machine.
It reports probabilities only; thresholds belong to the caller (packages/decide/guard.ts).

    python serve_8j.py --ckpt ~/.8gent/models/8j/<run> [--port 8086]
    env EIGHT_8J_CKPT / EIGHT_8J_PORT are read when the flags are absent.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Callable

MAX_BODY_BYTES = 256 * 1024
MAX_CHOICE_OPTIONS = 255
MIN_SCORE_LEVELS, MAX_SCORE_LEVELS = 2, 10
DEFAULT_PORT = 8086

AnswerFn = Callable[[str, dict, "str | None"], dict]


class BadRequest(ValueError):
    pass


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_request(body: bytes) -> tuple[str, dict, str | None]:
    """Validate a /v1/systemone body. Returns (state, questions, guidance) or raises BadRequest."""
    try:
        req = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("body must be JSON")
    if not isinstance(req, dict):
        raise BadRequest("body must be a JSON object")
    state = req.get("state")
    if isinstance(state, (dict, list)):
        state = json.dumps(state, ensure_ascii=True)
    if not isinstance(state, str):
        raise BadRequest("state must be a string or JSON value")
    guidance = req.get("guidance")
    if guidance is not None and not isinstance(guidance, str):
        raise BadRequest("guidance must be a string")
    questions = req.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise BadRequest("questions must be a non-empty object keyed by question id")
    for qid, q in questions.items():
        if not isinstance(q, dict):
            raise BadRequest(f"question {qid!r} must be an object")
        kind = q.get("type")
        if not isinstance(q.get("instructions"), str) or not q["instructions"]:
            raise BadRequest(f"question {qid!r}: instructions must be a non-empty string")
        crit = q.get("criteria")
        if kind == "noul":
            ok = crit is None or (isinstance(crit, dict) and set(crit) <= {"false", "true"}
                                  and all(isinstance(v, str) for v in crit.values()))
            if not ok:
                raise BadRequest(f"question {qid!r}: noul criteria must be {{\"false\": text, \"true\": text}}")
            continue
        if kind == "choice":
            if not isinstance(crit, dict) or not 2 <= len(crit) <= MAX_CHOICE_OPTIONS:
                raise BadRequest(f"question {qid!r}: choice needs 2..{MAX_CHOICE_OPTIONS} criteria")
        elif kind == "score":
            if not isinstance(crit, list) or not MIN_SCORE_LEVELS <= len(crit) <= MAX_SCORE_LEVELS:
                raise BadRequest(f"question {qid!r}: score needs {MIN_SCORE_LEVELS}..{MAX_SCORE_LEVELS} levels")
        else:
            raise BadRequest(f"question {qid!r}: unknown type {kind!r}")
    return state, questions, guidance


def make_server(host: str, port: int, answer: AnswerFn, info: dict) -> HTTPServer:
    """An HTTP server around `answer(state, question, guidance)`. One request at a time."""
    if not is_loopback(host):
        raise ValueError(f"8j serve binds to loopback only, not {host!r}")

    class Handler(BaseHTTPRequestHandler):
        server_version = "serve-8j"

        def log_message(self, fmt, *args):  # the request carries a command; never log it
            pass

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, **info})
            self._send(404, {"error": {"type": "not_found", "message": "GET /health or POST /v1/systemone"}})

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self._send(404, {"error": {"type": "not_found", "message": "POST /v1/systemone"}})
            try:
                n = int(self.headers.get("content-length") or 0)
            except ValueError:
                n = -1
            if n <= 0 or n > MAX_BODY_BYTES:
                return self._send(413 if n > MAX_BODY_BYTES else 400,
                                  {"error": {"type": "invalid_request", "message": f"body must be 1..{MAX_BODY_BYTES} bytes"}})
            try:
                state, questions, guidance = parse_request(self.rfile.read(n))
            except BadRequest as e:
                return self._send(400, {"error": {"type": "invalid_request", "message": str(e)}})
            t0 = time.perf_counter()
            try:
                answers = {qid: answer(state, q, guidance) for qid, q in questions.items()}
            except Exception as e:  # never guess a verdict: the caller fails closed on a 5xx
                return self._send(500, {"error": {"type": "model_error", "message": type(e).__name__}})
            self._send(200, {"model": info.get("model"), "answers": answers,
                             "latency_ms": round((time.perf_counter() - t0) * 1000, 1)})

    return HTTPServer((host, port), Handler)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--ckpt", default=os.environ.get("EIGHT_8J_CKPT"), help="8J run directory (meta.json, adapter, head.pt)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=int(os.environ.get("EIGHT_8J_PORT") or DEFAULT_PORT))
    p.add_argument("--threads", type=int, default=0, help="torch CPU threads (0 = torch default)")
    args = p.parse_args(argv)
    if not args.ckpt:
        p.error("--ckpt or EIGHT_8J_CKPT is required")
    if not is_loopback(args.host):
        p.error(f"--host must be a loopback address, not {args.host}")

    import torch

    import judge8j

    if args.threads > 0:
        torch.set_num_threads(args.threads)
    t0 = time.perf_counter()
    net, prompt, meta = judge8j.load(args.ckpt)
    judge8j.answer(net, prompt, meta, "warm-up", {"type": "noul", "instructions": "Is this a warm-up?"})
    info = {"model": meta["run"], "base": meta["model_name"]}

    def answer(state, question, guidance):
        return judge8j.answer(net, prompt, meta, state, question, guidance)

    server = make_server(args.host, args.port, answer, info)
    print(f"serve-8j: {info['model']} on http://{args.host}:{args.port} (loaded in {time.perf_counter() - t0:.1f}s)",
          file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
