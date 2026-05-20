"""Sidecar run-loop lifecycle (spec section 4.3).

These exercise the full stdio loop with in-memory string streams, so the
ready handshake, request/response framing and graceful shutdown are tested
without spawning a process or loading weights.
"""

import io
import json

from marlin_sidecar import server
from marlin_sidecar.model import MockVideoModel


def run_lines(request_lines, idle_timeout_sec=0.0):
    """Feed request lines through the run loop; return parsed output objects."""
    instream = io.StringIO("".join(line + "\n" for line in request_lines))
    outstream = io.StringIO()
    server.run(
        model=MockVideoModel(),
        idle_timeout_sec=idle_timeout_sec,
        instream=instream,
        outstream=outstream,
    )
    return [json.loads(ln) for ln in outstream.getvalue().splitlines() if ln.strip()]


def req(method, params=None, req_id=1):
    obj = {"jsonrpc": "2.0", "method": method, "id": req_id}
    if params is not None:
        obj["params"] = params
    return json.dumps(obj)


def test_run_emits_ready_notification_first():
    outputs = run_lines([req("health")])
    assert outputs[0]["method"] == "ready"
    assert "pid" in outputs[0]["params"]


def test_run_handles_initialize_then_health():
    outputs = run_lines([req("initialize"), req("health", req_id=2)])
    # outputs[0] is the ready notification.
    assert outputs[1]["result"]["ready"] is True
    assert outputs[2]["result"]["status"] == "ok"


def test_run_stops_on_shutdown_request():
    # The line after shutdown must NOT be processed: the loop exits first.
    outputs = run_lines([
        req("initialize"),
        req("shutdown", req_id=2),
        req("health", req_id=3),
    ])
    ids = [o.get("id") for o in outputs if "id" in o]
    assert 2 in ids        # shutdown was answered
    assert 3 not in ids    # health after shutdown was never reached


def test_run_exits_cleanly_on_eof():
    # No requests: just the ready notification, then EOF, then return.
    outputs = run_lines([])
    assert len(outputs) == 1
    assert outputs[0]["method"] == "ready"


def test_run_skips_blank_lines():
    instream = io.StringIO("\n   \n" + req("health") + "\n")
    outstream = io.StringIO()
    server.run(model=MockVideoModel(), idle_timeout_sec=0.0,
               instream=instream, outstream=outstream)
    outputs = [json.loads(ln) for ln in outstream.getvalue().splitlines() if ln.strip()]
    # ready notification + one health response, blank lines produced nothing.
    assert len(outputs) == 2


def test_run_notification_produces_no_response_line():
    # A health *notification* (no id) yields only the ready line.
    instream = io.StringIO(json.dumps({"jsonrpc": "2.0", "method": "health"}) + "\n")
    outstream = io.StringIO()
    server.run(model=MockVideoModel(), idle_timeout_sec=0.0,
               instream=instream, outstream=outstream)
    outputs = [json.loads(ln) for ln in outstream.getvalue().splitlines() if ln.strip()]
    assert len(outputs) == 1
    assert outputs[0]["method"] == "ready"
