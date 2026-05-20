"""Shared pytest fixtures for the Marlin sidecar suite.

Makes the marlin_sidecar package importable when the suite is run from the
package directory without an editable install.
"""

import os
import sys

# Allow `import marlin_sidecar` when running `pytest` from packages/eyes/marlin.
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)
