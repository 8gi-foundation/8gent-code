"""
Side-by-side decision comparison: BDH vs heuristic baseline.

Phase 0 demonstration of the eval pattern. NOT a quality measurement -
the rule-based corpus has no ground-truth labels, so what this measures
is how often the trained BDH model and the heuristic baseline agree on
`decision.kind` and `decision.target` for the same inputs.

Useful as:
- Smoke check that BDH outputs are decodable to a valid Decision
- Indicator of whether BDH learned anything beyond the corpus prior
- Template for the Phase 1 eval harness (which adds gold-set ground truth)

Run after training completes:
  python3 packages/eight-bdh/trainer/local/compare_decisions.py

Outputs:
  packages/eight-bdh/trainer/local/phase-0-comparison-report.json
  human-readable side-by-side to stdout
"""

import json
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
CHECKPOINT = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints" / "phase-0-5m.pt"
JSONL_CORPUS = REPO_ROOT / "packages" / "eight-bdh" / "data" / "phase-0-seed-42.jsonl"
LOG_DIR = REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local"
REPORT_PATH = LOG_DIR / "phase-0-comparison-report.json"

sys.path.insert(0, str(BDH_REPO))
sys.path.insert(0, str(LOG_DIR))

import torch
from bdh import BDH, BDHConfig
from baseline_heuristic import HeuristicRouter

# ── Device ──────────────────────────────────────────────────────────────

def select_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")

DEVICE = select_device()
print(f"[compare] device={DEVICE}", flush=True)

# ── Load BDH ────────────────────────────────────────────────────────────

if not CHECKPOINT.exists():
    print(f"[error] checkpoint not found at {CHECKPOINT}", file=sys.stderr)
    sys.exit(1)

print(f"[compare] loading {CHECKPOINT.name}", flush=True)
ckpt = torch.load(CHECKPOINT, map_location=DEVICE, weights_only=False)
cfg_d = ckpt["config"]
cfg = BDHConfig(
    n_layer=cfg_d["n_layer"],
    n_embd=cfg_d["n_embd"],
    n_head=cfg_d["n_head"],
    mlp_internal_dim_multiplier=cfg_d["mlp_internal_dim_multiplier"],
    dropout=cfg_d["dropout"],
    vocab_size=cfg_d["vocab_size"],
)
model = BDH(cfg).to(DEVICE)
model.load_state_dict(ckpt["model_state_dict"])
model.eval()

heuristic = HeuristicRouter()

# ── Decoder for BDH output ──────────────────────────────────────────────

KIND_PATTERN = re.compile(r'"kind":"(model|agent|tool|reject|clarify)"')
TARGET_PATTERN = re.compile(r'"target":"([^"]+)"')


def bdh_decide(state: dict) -> dict | None:
    """Generate from BDH a continuation of the state JSON, then try to
    parse a Decision out of the byte stream. Returns None if undecodable."""
    # Prompt: full state JSON + start of decision
    state_json = json.dumps({"state": state}, separators=(",", ":"), sort_keys=True)
    # Strip the closing brace so the model continues into the decision
    prompt = state_json[:-1] + ',"decision":{'
    prompt_bytes = prompt.encode("utf-8")
    idx = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=DEVICE)
    with torch.no_grad():
        out_idx = model.generate(idx, max_new_tokens=200, temperature=0.6, top_k=40)
    new_bytes = out_idx[0, idx.shape[1]:].tolist()
    text = bytes(new_bytes).decode("utf-8", errors="replace")

    # Try to extract kind and target via regex (the model output is messy)
    kind_m = KIND_PATTERN.search(text)
    target_m = TARGET_PATTERN.search(text)
    if not kind_m:
        return None
    return {
        "kind": kind_m.group(1),
        "target": target_m.group(1) if target_m else "<unparsed>",
        "raw_completion": text[:200],
    }


# ── Sample states (held-out, hand-built) ─────────────────────────────────

# These are NOT from the training corpus; they are realistic routing
# scenarios designed to probe both routers' behaviour.

samples = [
    {
        "id": "h1",
        "request": "rewrite this auth middleware to use the new policy engine",
        "context": {
            "tools_available": ["Read", "Edit", "Bash", "AgentTool"],
            "vessels_available": ["8TO", "8SO"],
            "budget_remaining": {"tokens": 80000, "ms": 600000},
            "history_summary": "user has been debugging auth for 20 minutes",
        },
        "policy": {"authority_level": 3, "deny_actions": ["push_to_main"]},
    },
    {
        "id": "h2",
        "request": "what files changed in the last commit",
        "context": {
            "tools_available": ["Read", "Bash"],
            "vessels_available": ["8TO"],
            "budget_remaining": {"tokens": 4000, "ms": 30000},
            "history_summary": "fresh session",
        },
        "policy": {"authority_level": 1, "deny_actions": []},
    },
    {
        "id": "h3",
        "request": "deploy to production",
        "context": {
            "tools_available": ["Bash"],
            "vessels_available": ["8DO", "8SO"],
            "budget_remaining": {"tokens": 8000, "ms": 60000},
            "history_summary": "first interaction of the day",
        },
        "policy": {"authority_level": 2, "deny_actions": ["push_to_main"]},
    },
    {
        "id": "h4",
        "request": "summarise the project status",
        "context": {
            "tools_available": ["Read"],
            "vessels_available": ["8EO"],
            "budget_remaining": {"tokens": 4000, "ms": 30000},
            "history_summary": "fresh session",
        },
        "policy": {"authority_level": 1, "deny_actions": []},
    },
    {
        "id": "h5",
        "request": "fix the failing test in packages/eight/agent.test.ts",
        "context": {
            "tools_available": ["Read", "Edit", "Bash"],
            "vessels_available": ["8TO", "8SO"],
            "budget_remaining": {"tokens": 12000, "ms": 90000},
            "history_summary": "last attempt failed CI",
        },
        "policy": {"authority_level": 2, "deny_actions": []},
    },
    {
        "id": "h6",
        "request": "scan the repo for hardcoded credentials",
        "context": {
            "tools_available": ["Grep", "Read"],
            "vessels_available": ["8SO"],
            "budget_remaining": {"tokens": 4000, "ms": 30000},
            "history_summary": "fresh session",
        },
        "policy": {"authority_level": 2, "deny_actions": []},
    },
    {
        "id": "h7",
        "request": "investigate why the daemon is running hot",
        "context": {
            "tools_available": ["Bash", "Read"],
            "vessels_available": ["8TO"],
            "budget_remaining": {"tokens": 12000, "ms": 90000},
            "history_summary": "pager just fired",
        },
        "policy": {"authority_level": 2, "deny_actions": []},
    },
    {
        "id": "h8",
        "request": "draft a changelog entry for v0.13",
        "context": {
            "tools_available": ["Read"],
            "vessels_available": ["8MO"],
            "budget_remaining": {"tokens": 4000, "ms": 30000},
            "history_summary": "fresh session",
        },
        "policy": {"authority_level": 1, "deny_actions": []},
    },
]

# ── Run both ────────────────────────────────────────────────────────────

results = []
agree_kind = 0
agree_target = 0
bdh_undecodable = 0
bdh_total_ms = 0.0

print(f"\n[compare] running {len(samples)} held-out scenarios", flush=True)
print(f"{'id':<5}{'request':<60}{'heuristic kind/target':<35}{'bdh kind/target':<35}", flush=True)
print("-" * 135, flush=True)

for s in samples:
    state = {"request": s["request"], "context": s["context"], "policy": s["policy"]}
    h = heuristic.decide(state)

    t0 = time.time()
    b = bdh_decide(state)
    bdh_ms = (time.time() - t0) * 1000
    bdh_total_ms += bdh_ms

    if b is None:
        bdh_undecodable += 1
        bdh_str = "<undecodable>"
        agreed_kind = False
        agreed_target = False
    else:
        bdh_str = f"{b['kind']}/{b['target']}"
        agreed_kind = b["kind"] == h["kind"]
        agreed_target = b.get("target") == h["target"]
        if agreed_kind:
            agree_kind += 1
        if agreed_target:
            agree_target += 1

    h_str = f"{h['kind']}/{h['target']}"
    req_short = s["request"][:55] + ("..." if len(s["request"]) > 55 else "")
    print(f"{s['id']:<5}{req_short:<60}{h_str:<35}{bdh_str:<35}", flush=True)

    results.append({
        "id": s["id"],
        "request": s["request"],
        "heuristic": h,
        "bdh": b,
        "bdh_inference_ms": round(bdh_ms, 1),
        "agreed_kind": agreed_kind,
        "agreed_target": agreed_target,
    })

# ── Summary ─────────────────────────────────────────────────────────────

n = len(samples)
decodable = n - bdh_undecodable
print("", flush=True)
print(f"[summary] BDH decodable     : {decodable}/{n} ({100*decodable/n:.0f}%)", flush=True)
print(f"[summary] kind agreement    : {agree_kind}/{n} ({100*agree_kind/n:.0f}%)", flush=True)
print(f"[summary] target agreement  : {agree_target}/{n} ({100*agree_target/n:.0f}%)", flush=True)
print(f"[summary] avg BDH inference : {bdh_total_ms/n:.1f}ms", flush=True)

# ── Caveat ──────────────────────────────────────────────────────────────

print("", flush=True)
print("[caveat] This is NOT a quality measurement. The training corpus has", flush=True)
print("[caveat] no ground-truth labels. Agreement here measures whether BDH", flush=True)
print("[caveat] and heuristic happen to converge on the same answer, not", flush=True)
print("[caveat] whether either is correct. Phase 1 needs the gold set.", flush=True)

# ── Report ──────────────────────────────────────────────────────────────

with REPORT_PATH.open("w") as fh:
    json.dump({
        "phase": 0,
        "purpose": "demonstration of eval pattern; not a quality gate",
        "device": str(DEVICE),
        "checkpoint": str(CHECKPOINT.relative_to(REPO_ROOT)),
        "n_samples": n,
        "summary": {
            "bdh_decodable": decodable,
            "bdh_decodable_rate": decodable / n,
            "kind_agreement": agree_kind,
            "kind_agreement_rate": agree_kind / n,
            "target_agreement": agree_target,
            "target_agreement_rate": agree_target / n,
            "avg_bdh_inference_ms": bdh_total_ms / n,
        },
        "samples": results,
    }, fh, indent=2)

print(f"\n[compare] wrote {REPORT_PATH.relative_to(REPO_ROOT)}", flush=True)
