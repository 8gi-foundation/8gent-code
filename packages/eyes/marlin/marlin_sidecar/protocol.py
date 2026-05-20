"""Newline-delimited JSON-RPC 2.0 protocol for the Marlin sidecar.

Spec: docs/specs/VIDEO-INGESTION.md sections 4.2, 5.

One JSON object per line over stdin/stdout. stderr is logs only and is
never parsed. This module is transport-agnostic: ``dispatch`` takes a raw
line and returns a raw line (or None for notifications), so the protocol
is fully unit-testable without touching real stdio.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from . import constants, errors
from .errors import RpcError
from .handlers import HANDLERS, Session


def log(message: str) -> None:
    """Write a human-readable log line to stderr (never to stdout)."""
    print(f"[marlin-sidecar] {message}", file=sys.stderr, flush=True)


def _error_response(req_id: Any, err: RpcError) -> dict[str, Any]:
    return {
        "jsonrpc": constants.JSONRPC_VERSION,
        "id": req_id,
        "error": err.to_dict(),
    }


def _result_response(req_id: Any, result: Any) -> dict[str, Any]:
    return {
        "jsonrpc": constants.JSONRPC_VERSION,
        "id": req_id,
        "result": result,
    }


def ready_notification(pid: int) -> dict[str, Any]:
    """The one-shot 'ready' notification emitted after spawn, before load.

    Spec section 4.3 step 2. A notification has no ``id``.
    """
    return {
        "jsonrpc": constants.JSONRPC_VERSION,
        "method": "ready",
        "params": {"pid": pid},
    }


def _parse_line(line: str) -> dict[str, Any]:
    """Parse and structurally validate one JSON-RPC request line.

    Raises RpcError(-32700) on malformed JSON, (-32600) on a structurally
    invalid request object.
    """
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise errors.parse_error(f"malformed JSON: {exc}") from exc

    if not isinstance(obj, dict):
        raise errors.invalid_request("request must be a JSON object")
    if obj.get("jsonrpc") != constants.JSONRPC_VERSION:
        raise errors.invalid_request("jsonrpc field must be '2.0'")
    if "method" not in obj or not isinstance(obj["method"], str):
        raise errors.invalid_request("method must be a string")
    if "params" in obj and not isinstance(obj["params"], (dict, list)):
        raise errors.invalid_request("params must be an object or array")
    return obj


def dispatch(line: str, session: Session) -> str | None:
    """Dispatch one request line and return one response line.

    Returns None for notifications (a request with no ``id``), which take
    no response. All errors are caught and serialised; this never raises.
    """
    line = line.strip()
    if not line:
        return None

    req_id: Any = None
    try:
        request = _parse_line(line)
        # An id of None or absent means notification: no response.
        is_notification = "id" not in request
        req_id = request.get("id")

        method = request["method"]
        params = request.get("params", {})
        # Array params are valid JSON-RPC but no method here uses them.
        if isinstance(params, list):
            raise errors.invalid_params("array params are not supported")

        handler = HANDLERS.get(method)
        if handler is None:
            raise errors.method_not_found(method)

        session.queue_depth += 1
        session.touch()
        try:
            result = handler(params, session)
        finally:
            session.queue_depth -= 1
            session.touch()

        if is_notification:
            return None
        return json.dumps(_result_response(req_id, result))

    except RpcError as err:
        return json.dumps(_error_response(req_id, err))
    except Exception as exc:  # uncaught -> -32603
        log(f"internal error handling request: {exc!r}")
        return json.dumps(
            _error_response(req_id, errors.internal_error(str(exc)))
        )


def write_line(obj: dict[str, Any], stream: Any = None) -> None:
    """Write one JSON object as a single line to stdout (or a given stream)."""
    out = stream if stream is not None else sys.stdout
    out.write(json.dumps(obj) + "\n")
    out.flush()
