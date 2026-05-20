"""Run loop for the Marlin sidecar.

Spec: docs/specs/VIDEO-INGESTION.md section 4.3 (lifecycle).

Owns the stdio read loop, the ready handshake and idle-shutdown. Inference
and protocol concerns live in handlers.py / protocol.py; this module is the
thin glue that wires them to real file descriptors.
"""

from __future__ import annotations

import os
import sys
import threading

from . import constants, protocol
from .handlers import Session
from .model import MockVideoModel, VideoModel


def _idle_watchdog(session: Session, idle_timeout_sec: float,
                   stop_event: threading.Event) -> None:
    """Background thread: exit the process after an idle period.

    Spec section 4.3 step 5. After ``idle_timeout_sec`` with no requests
    the sidecar exits to free ~5GB of RAM; the tool re-spawns on demand.
    """
    while not stop_event.is_set():
        if session.idle_sec() >= idle_timeout_sec:
            protocol.log(
                f"idle for {idle_timeout_sec:.0f}s, shutting down to free RAM"
            )
            # Hard exit: this thread is a daemon and stdin may be blocked.
            os._exit(0)
        stop_event.wait(timeout=min(idle_timeout_sec / 4.0, 30.0))


def run(
    model: VideoModel | None = None,
    idle_timeout_sec: float = constants.DEFAULT_IDLE_TIMEOUT_SEC,
    instream=None,
    outstream=None,
) -> int:
    """Run the sidecar read loop until EOF or shutdown.

    Parameters allow tests to inject a mock model and string streams.
    Returns a process exit code.
    """
    instream = instream if instream is not None else sys.stdin
    outstream = outstream if outstream is not None else sys.stdout

    session = Session(model=model)

    # 1. Ready handshake: emitted before models load (spec section 4.3 step 2).
    protocol.write_line(protocol.ready_notification(os.getpid()), outstream)
    protocol.log(f"ready, pid={os.getpid()}, awaiting initialize")

    # Idle watchdog runs only against a real stdin (a file descriptor).
    stop_event = threading.Event()
    watchdog: threading.Thread | None = None
    if idle_timeout_sec > 0 and hasattr(instream, "fileno"):
        try:
            instream.fileno()
            watchdog = threading.Thread(
                target=_idle_watchdog,
                args=(session, idle_timeout_sec, stop_event),
                daemon=True,
            )
            watchdog.start()
        except (OSError, ValueError):
            # Not a real fd (e.g. StringIO in tests): skip the watchdog.
            watchdog = None

    exit_code = 0
    try:
        for line in instream:
            response = protocol.dispatch(line, session)
            if response is not None:
                outstream.write(response + "\n")
                outstream.flush()
            if session.shutdown_requested:
                protocol.log("shutdown requested, exiting")
                break
    except KeyboardInterrupt:  # pragma: no cover
        protocol.log("interrupted")
        exit_code = 130
    finally:
        stop_event.set()

    return exit_code


def run_from_stdio() -> int:
    """Entry point used by `python -m marlin_sidecar`.

    Selects the model implementation. ``MARLIN_SIDECAR_MOCK=1`` forces the
    mock model, which lets the package be smoke-tested (and the health
    probe answered) without any model weights installed.
    """
    use_mock = os.environ.get("MARLIN_SIDECAR_MOCK") == "1"
    model: VideoModel | None = MockVideoModel() if use_mock else None
    if use_mock:
        protocol.log("MARLIN_SIDECAR_MOCK=1: using mock model, no weights loaded")

    idle = float(os.environ.get(
        "MARLIN_SIDECAR_IDLE_SEC", constants.DEFAULT_IDLE_TIMEOUT_SEC
    ))
    return run(model=model, idle_timeout_sec=idle)
