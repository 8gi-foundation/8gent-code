"""`python -m marlin_sidecar` entry point.

Runs the JSON-RPC sidecar on stdin/stdout (spec section 4.3). For the CLI
with subcommands (serve, bench) use the `marlin` console script instead.
"""

import sys

from .server import run_from_stdio

if __name__ == "__main__":
    sys.exit(run_from_stdio())
