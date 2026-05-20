"""Constants for the Marlin video sidecar.

Spec: docs/specs/VIDEO-INGESTION.md sections 4, 5, 9, 12.
"""

# --- Model identifiers (spec section 5.1) ---

# HuggingFace repo id of the vision model. Apache 2.0, public.
DEFAULT_VISION_MODEL = "NemoStation/Marlin-2B"

# HuggingFace repo id of the ASR model (mlx-whisper, Apple Silicon native).
DEFAULT_AUDIO_MODEL = "mlx-community/whisper-base-mlx"

# Pinned HuggingFace commit hash for the vision model.
#
# SECURITY (spec section 10): Marlin requires trust_remote_code=True, which
# executes modeling_marlin.py from the repo. The revision MUST be a specific
# commit hash, never a moving branch, so an upstream change cannot reach the
# user without a reviewed PR (8SO-labelled).
#
# HONEST CONSTRAINT: NemoStation/Marlin-2B is a GATED repo on HuggingFace.
# Its weights and trust_remote_code commit hash cannot be fetched in the
# build environment for this PR. The value below is a deliberate, clearly
# marked PLACEHOLDER. It MUST be replaced with the real pinned commit hash
# (after reviewing the diff of modeling_marlin.py) before the sidecar is
# run against real weights. The model layer raises a clear error if it is
# asked to load while this placeholder is still in place.
MARLIN_REVISION = "PLACEHOLDER_PENDING_HF_ACCESS"

# --- Device selection (spec section 4.4) ---

DEFAULT_DEVICE = "mps"
VALID_DEVICES = ("mps", "cpu")

# --- Lifecycle (spec section 4.3) ---

# Idle timeout in seconds. After this long with no requests, the sidecar
# exits to free ~5GB of RAM. The tool side transparently re-spawns.
DEFAULT_IDLE_TIMEOUT_SEC = 300.0

# --- Caption / window limits (spec section 12) ---

DEFAULT_FPS = 2.0
MAX_FRAMES = 240          # Marlin's per-window ceiling.
MIN_FRAMES = 4            # Marlin's minimum; fewer frames -> error -33004.
DEFAULT_MAX_TOKENS = 2048
MAX_FRAME_DIM = 448       # 448x448 max per frame.

# --- Chunk-and-merge (spec section 8) ---

DEFAULT_MAX_CHUNK_SEC = 120.0   # Marlin window is ~2 minutes.
SEAM_EPSILON_SEC = 0.5          # Boundary tolerance for seam dedup.
SEAM_JACCARD_THRESHOLD = 0.8    # Token-Jaccard above this merges seam events.

# --- Transcribe (spec section 13: silent video) ---

# Whisper may hallucinate text on noise/music. Segments whose no-speech
# probability exceeds this threshold are dropped.
NO_SPEECH_PROB_THRESHOLD = 0.6

# --- JSON-RPC error codes (spec section 5.8) ---

# Standard JSON-RPC 2.0 codes.
ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603

# Application range.
ERR_MODEL_NOT_LOADED = -33001
ERR_VIDEO_DECODE_FAILED = -33002
ERR_UNSUPPORTED_FORMAT = -33003
ERR_VIDEO_TOO_SHORT = -33004
ERR_OUT_OF_MEMORY = -33005
ERR_NO_AUDIO_TRACK = -33006

ERROR_NAMES = {
    ERR_PARSE: "Parse error",
    ERR_INVALID_REQUEST: "Invalid request",
    ERR_METHOD_NOT_FOUND: "Method not found",
    ERR_INVALID_PARAMS: "Invalid params",
    ERR_INTERNAL: "Internal error",
    ERR_MODEL_NOT_LOADED: "Model not loaded",
    ERR_VIDEO_DECODE_FAILED: "Video decode failed",
    ERR_UNSUPPORTED_FORMAT: "Unsupported format",
    ERR_VIDEO_TOO_SHORT: "Video too short",
    ERR_OUT_OF_MEMORY: "Out of memory",
    ERR_NO_AUDIO_TRACK: "No audio track",
}

# JSON-RPC protocol version string.
JSONRPC_VERSION = "2.0"
