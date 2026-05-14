"""
BDH routing eval harness.

This is the Phase 1 prerequisite the Phase 2 synthesis named as priority #1:
"heuristic baseline + held-out gold set + kappa probe". Until this exists,
every BDH phase report can only cite byte-level val_loss, never routing
correctness. This harness closes that gap.

What it does
------------
1. Loads a held-out gold set (`gold_set.jsonl`) of hand-authored
   (state -> correct decision.kind) pairs. Each entry carries an explicit
   rationale tracing the label to the routing contract, and a difficulty
   category so accuracy can be read per-tier.
2. Always scores the deterministic `HeuristicRouter` from
   `baseline_heuristic.py` against the gold set. This is the baseline
   the spec section 9 gate ("+10pp routing accuracy vs heuristic") needs.
3. Optionally loads a trained BDH checkpoint and scores it the same way:
   decode the model's byte stream into a Decision, compare `kind` to gold.
4. Computes Cohen's kappa (agreement corrected for chance) for each rater
   against gold, plus a per-kind confusion matrix and a per-category
   accuracy breakdown.
5. Measures single-forward-pass latency for the model (the production
   routing path -- NOT 80-byte autoregressive generation, which the
   Phase 0 verify script wrongly measured).
6. Writes a JSON report and prints a human-readable table.

What it does NOT do
-------------------
- It does not claim the gold set is production traffic. It is a
  hand-authored contract-conformance + generalisation test set, n=40,
  v1. See EVAL-HARNESS.md for exactly what that means and does not mean.
- It does not change training. It scores checkpoints; it is read-only
  with respect to the model.
- Without a checkpoint it runs baseline-only. That is the expected mode
  today: the Phase 0/1/2 checkpoints were M2-Max-local and gitignored,
  and are not on disk. The harness is built so the next run is scorable
  the moment it produces a checkpoint.

Usage
-----
    # baseline only (no checkpoint needed)
    python3 packages/eight-bdh/trainer/local/eval_harness.py

    # score a trained checkpoint against the gold set
    python3 packages/eight-bdh/trainer/local/eval_harness.py \
        --checkpoint packages/eight-bdh/checkpoints/phase-3c-toolcalls-5m.pt

    # custom gold set / output path / device
    python3 packages/eight-bdh/trainer/local/eval_harness.py \
        --gold path/to/gold.jsonl --out path/to/report.json --device cpu

Exit code is 0 on a clean run regardless of score; this is a measurement
tool, not a gate. The ship-gate decision is made by reading the report.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
LOCAL_DIR = Path(__file__).resolve().parent
DEFAULT_GOLD = LOCAL_DIR / "gold_set.jsonl"
DEFAULT_OUT = LOCAL_DIR / "eval-report.json"

sys.path.insert(0, str(LOCAL_DIR))
from baseline_heuristic import HeuristicRouter  # noqa: E402

VALID_KINDS = ("model", "agent", "tool", "reject", "clarify")
VALID_CATEGORIES = (
    "keyword-obvious",
    "semantic-hard",
    "adversarial-phrasing",
    "policy-edge",
)


# ── Gold set ────────────────────────────────────────────────────────────


def load_gold_set(path: Path) -> list[dict[str, Any]]:
    """Load and validate the gold set. Raises ValueError on any malformed
    entry -- a broken gold set must fail loud, not score silently wrong."""
    if not path.exists():
        raise FileNotFoundError(f"gold set not found: {path}")
    entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for lineno, raw in enumerate(path.read_text().splitlines(), start=1):
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path.name}:{lineno}: invalid JSON: {exc}") from exc
        for field in ("id", "category", "state", "gold", "rationale"):
            if field not in entry:
                raise ValueError(f"{path.name}:{lineno}: missing field '{field}'")
        eid = entry["id"]
        if eid in seen_ids:
            raise ValueError(f"{path.name}:{lineno}: duplicate id '{eid}'")
        seen_ids.add(eid)
        if entry["category"] not in VALID_CATEGORIES:
            raise ValueError(
                f"{path.name}:{lineno}: bad category '{entry['category']}'"
            )
        gold = entry["gold"]
        if gold.get("kind") not in VALID_KINDS:
            raise ValueError(
                f"{path.name}:{lineno}: bad gold.kind '{gold.get('kind')}'"
            )
        if not isinstance(gold.get("target_acceptable"), list) or not gold[
            "target_acceptable"
        ]:
            raise ValueError(
                f"{path.name}:{lineno}: gold.target_acceptable must be a non-empty list"
            )
        state = entry["state"]
        for field in ("request", "context", "policy"):
            if field not in state:
                raise ValueError(
                    f"{path.name}:{lineno}: state missing '{field}'"
                )
        entries.append(entry)
    if not entries:
        raise ValueError(f"{path.name}: gold set is empty")
    return entries


# ── Cohen's kappa ───────────────────────────────────────────────────────


def cohens_kappa(
    labels_a: list[str], labels_b: list[str], classes: tuple[str, ...] = VALID_KINDS
) -> float:
    """Cohen's kappa: agreement between two raters corrected for the
    agreement expected by chance given each rater's label distribution.

    kappa = (p_observed - p_expected) / (1 - p_expected)

    1.0 = perfect agreement. 0.0 = no better than chance. Negative =
    worse than chance. Returns 1.0 when both raters are constant and
    identical (degenerate but unambiguous); 0.0 when p_expected == 1.
    """
    if len(labels_a) != len(labels_b):
        raise ValueError("kappa: label lists must be the same length")
    n = len(labels_a)
    if n == 0:
        raise ValueError("kappa: empty label lists")
    p_observed = sum(1 for a, b in zip(labels_a, labels_b) if a == b) / n
    p_expected = 0.0
    for c in classes:
        pa = sum(1 for a in labels_a if a == c) / n
        pb = sum(1 for b in labels_b if b == c) / n
        p_expected += pa * pb
    if p_expected >= 1.0:
        return 1.0 if p_observed >= 1.0 else 0.0
    return (p_observed - p_expected) / (1.0 - p_expected)


# ── Scoring ─────────────────────────────────────────────────────────────


def _target_ok(predicted_target: str, acceptable: list[str]) -> bool:
    if "*" in acceptable:
        return True
    return predicted_target in acceptable


def score_router(
    name: str,
    decide: Callable[[dict[str, Any]], dict[str, Any] | None],
    gold: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run a router's decide() over the gold set and compute aggregates.

    `decide` returns a decision dict ({kind, target, ...}) or None when
    the output was undecodable (only the BDH path can return None).
    """
    per_entry: list[dict[str, Any]] = []
    pred_kinds: list[str] = []
    gold_kinds: list[str] = []
    kind_correct = 0
    target_correct = 0
    undecodable = 0
    # confusion[gold_kind][pred_kind] = count
    confusion = {g: {p: 0 for p in VALID_KINDS} for g in VALID_KINDS}
    # per-category tallies
    by_category: dict[str, dict[str, int]] = {
        c: {"n": 0, "kind_correct": 0} for c in VALID_CATEGORIES
    }
    # per-gold-kind tallies
    by_kind: dict[str, dict[str, int]] = {
        k: {"n": 0, "kind_correct": 0} for k in VALID_KINDS
    }

    for entry in gold:
        g_kind = entry["gold"]["kind"]
        g_targets = entry["gold"]["target_acceptable"]
        category = entry["category"]
        by_category[category]["n"] += 1
        by_kind[g_kind]["n"] += 1

        decision = decide(entry["state"])
        if decision is None:
            undecodable += 1
            pred_kind = "<undecodable>"
            pred_target = "<undecodable>"
            kind_ok = False
            target_ok = False
        else:
            pred_kind = decision.get("kind", "<missing>")
            pred_target = decision.get("target", "<missing>")
            kind_ok = pred_kind == g_kind
            target_ok = kind_ok and _target_ok(pred_target, g_targets)
            if pred_kind in confusion[g_kind]:
                confusion[g_kind][pred_kind] += 1

        if kind_ok:
            kind_correct += 1
            by_category[category]["kind_correct"] += 1
            by_kind[g_kind]["kind_correct"] += 1
        if target_ok:
            target_correct += 1

        # for kappa: undecodable maps to a sentinel so it never accidentally
        # agrees with a real gold kind
        pred_kinds.append(pred_kind if pred_kind in VALID_KINDS else "<none>")
        gold_kinds.append(g_kind)

        per_entry.append(
            {
                "id": entry["id"],
                "category": category,
                "request": entry["state"]["request"],
                "gold_kind": g_kind,
                "pred_kind": pred_kind,
                "pred_target": pred_target,
                "kind_correct": kind_ok,
                "target_correct": target_ok,
            }
        )

    n = len(gold)
    kappa = cohens_kappa(
        pred_kinds, gold_kinds, classes=VALID_KINDS + ("<none>",)
    )

    return {
        "router": name,
        "n": n,
        "kind_accuracy": kind_correct / n,
        "target_accuracy": target_correct / n,
        "undecodable": undecodable,
        "undecodable_rate": undecodable / n,
        "cohens_kappa_vs_gold": kappa,
        "by_category": {
            c: {
                "n": v["n"],
                "kind_accuracy": (v["kind_correct"] / v["n"]) if v["n"] else None,
            }
            for c, v in by_category.items()
        },
        "by_kind": {
            k: {
                "n": v["n"],
                "kind_accuracy": (v["kind_correct"] / v["n"]) if v["n"] else None,
            }
            for k, v in by_kind.items()
        },
        "confusion_gold_x_pred": confusion,
        "per_entry": per_entry,
    }


# ── BDH model path ──────────────────────────────────────────────────────

_KIND_PATTERN = re.compile(r'"kind"\s*:\s*"(model|agent|tool|reject|clarify)"')
_TARGET_PATTERN = re.compile(r'"target"\s*:\s*"([^"]+)"')


def select_device(requested: str | None):
    import torch

    if requested:
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")


def load_bdh(checkpoint_path: Path, device):
    """Load a trained BDH checkpoint. Returns (model, config_dict)."""
    import torch

    sys.path.insert(0, str(BDH_REPO))
    from bdh import BDH, BDHConfig

    ckpt = torch.load(checkpoint_path, map_location=device, weights_only=False)
    cfg_d = ckpt["config"]
    cfg = BDHConfig(
        n_layer=cfg_d["n_layer"],
        n_embd=cfg_d["n_embd"],
        n_head=cfg_d["n_head"],
        mlp_internal_dim_multiplier=cfg_d["mlp_internal_dim_multiplier"],
        dropout=cfg_d["dropout"],
        vocab_size=cfg_d["vocab_size"],
    )
    model = BDH(cfg).to(device)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    return model, cfg_d


def make_bdh_decide(model, device) -> Callable[[dict[str, Any]], dict[str, Any] | None]:
    """Build a decide(state) closure over a loaded BDH model. Prompts the
    model with the state JSON plus the opening of the decision object,
    generates a continuation, and regex-extracts a Decision. Returns None
    when no kind can be parsed (the byte stream was undecodable)."""
    import torch

    def decide(state: dict[str, Any]) -> dict[str, Any] | None:
        state_json = json.dumps(
            {"state": state}, separators=(",", ":"), sort_keys=True
        )
        prompt = state_json[:-1] + ',"decision":{'
        prompt_bytes = list(prompt.encode("utf-8"))
        idx = torch.tensor([prompt_bytes], dtype=torch.long, device=device)
        with torch.no_grad():
            out = model.generate(idx, max_new_tokens=200, temperature=0.6, top_k=40)
        new_bytes = out[0, idx.shape[1] :].tolist()
        text = bytes(new_bytes).decode("utf-8", errors="replace")
        kind_m = _KIND_PATTERN.search(text)
        if not kind_m:
            return None
        target_m = _TARGET_PATTERN.search(text)
        return {
            "kind": kind_m.group(1),
            "target": target_m.group(1) if target_m else "<unparsed>",
            "raw_completion": text[:200],
        }

    return decide


def measure_latency(model, device, n_runs: int = 30, block: int = 512) -> dict[str, float]:
    """Single-forward-pass latency, the production routing path. NOT
    autoregressive generation. Reports p50/p95/mean in milliseconds."""
    import torch

    idx = torch.randint(0, 256, (1, block), dtype=torch.long, device=device)
    # warmup
    for _ in range(3):
        with torch.no_grad():
            model(idx)
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize()
    samples: list[float] = []
    for _ in range(n_runs):
        t0 = time.perf_counter()
        with torch.no_grad():
            model(idx)
        if device.type == "mps":
            torch.mps.synchronize()
        elif device.type == "cuda":
            torch.cuda.synchronize()
        samples.append((time.perf_counter() - t0) * 1000.0)
    samples.sort()
    return {
        "n_runs": n_runs,
        "block": block,
        "p50_ms": round(samples[len(samples) // 2], 2),
        "p95_ms": round(samples[min(len(samples) - 1, int(len(samples) * 0.95))], 2),
        "mean_ms": round(sum(samples) / len(samples), 2),
    }


# ── Report rendering ────────────────────────────────────────────────────


def _pct(x: float | None) -> str:
    return "  n/a" if x is None else f"{100 * x:5.1f}%"


def print_report(report: dict[str, Any]) -> None:
    gold_n = report["gold_set"]["n"]
    print("", flush=True)
    print("=" * 72, flush=True)
    print(f" BDH routing eval  --  gold set n={gold_n}", flush=True)
    print("=" * 72, flush=True)

    rows = [report["heuristic"]]
    if report.get("bdh"):
        rows.append(report["bdh"])

    print(
        f"\n{'router':<14}{'kind acc':>10}{'target acc':>12}"
        f"{'kappa':>9}{'undecod':>10}",
        flush=True,
    )
    print("-" * 55, flush=True)
    for r in rows:
        print(
            f"{r['router']:<14}{_pct(r['kind_accuracy']):>10}"
            f"{_pct(r['target_accuracy']):>12}"
            f"{r['cohens_kappa_vs_gold']:>9.3f}"
            f"{r['undecodable']:>6}/{r['n']:<3}",
            flush=True,
        )

    if report.get("bdh"):
        delta = report["bdh"]["kind_accuracy"] - report["heuristic"]["kind_accuracy"]
        gate = report["spec_gates"]
        print(
            f"\n  BDH vs heuristic: {delta * 100:+.1f}pp kind accuracy "
            f"(spec section 9 Phase 1 gate: +10.0pp)",
            flush=True,
        )
        print(
            f"  Phase 1 routing gate: "
            f"{'PASS' if gate['phase_1_plus_10pp_vs_heuristic'] else 'NOT MET'}",
            flush=True,
        )
        print(
            f"  Phase 0 routing gate (>=70% kind acc): "
            f"{'PASS' if gate['phase_0_70pct_kind_acc'] else 'NOT MET'}",
            flush=True,
        )
        if report["bdh"].get("latency"):
            lat = report["bdh"]["latency"]
            print(
                f"  single-forward latency: p50 {lat['p50_ms']}ms  "
                f"p95 {lat['p95_ms']}ms  (Phase 1 gate: p95 <=80ms -> "
                f"{'PASS' if gate['phase_1_p95_latency_80ms'] else 'NOT MET'})",
                flush=True,
            )

    # per-category, the honest tier breakdown
    for r in rows:
        print(f"\n  {r['router']} -- accuracy by difficulty tier:", flush=True)
        for cat, v in r["by_category"].items():
            print(
                f"    {cat:<22} {_pct(v['kind_accuracy'])}  (n={v['n']})",
                flush=True,
            )

    print(
        "\n[caveat] Gold set is hand-authored contract-conformance + "
        "generalisation,",
        flush=True,
    )
    print(
        "[caveat] n=40, v1. Not production traffic, not the 5k Phase 1 "
        "set. The",
        flush=True,
    )
    print(
        "[caveat] harness scales to any gold file; see EVAL-HARNESS.md.",
        flush=True,
    )


# ── Main ────────────────────────────────────────────────────────────────


def run_eval(
    gold_path: Path,
    checkpoint_path: Path | None,
    device_str: str | None,
) -> dict[str, Any]:
    gold = load_gold_set(gold_path)

    heuristic = HeuristicRouter()
    heuristic_result = score_router("heuristic", heuristic.decide, gold)

    report: dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gold_set": {
            "path": str(gold_path.relative_to(REPO_ROOT))
            if gold_path.is_relative_to(REPO_ROOT)
            else str(gold_path),
            "n": len(gold),
            "kind": "hand-authored contract-conformance + generalisation, v1",
        },
        "heuristic": heuristic_result,
        "bdh": None,
        "spec_gates": {
            "phase_0_70pct_kind_acc": None,
            "phase_1_plus_10pp_vs_heuristic": None,
            "phase_1_p95_latency_80ms": None,
        },
    }

    if checkpoint_path is not None:
        if not checkpoint_path.exists():
            raise FileNotFoundError(f"checkpoint not found: {checkpoint_path}")
        device = select_device(device_str)
        print(f"[eval] device={device}", flush=True)
        print(f"[eval] loading {checkpoint_path.name}", flush=True)
        model, cfg_d = load_bdh(checkpoint_path, device)
        bdh_decide = make_bdh_decide(model, device)
        print(f"[eval] scoring BDH over {len(gold)} gold entries", flush=True)
        bdh_result = score_router("bdh", bdh_decide, gold)
        bdh_result["latency"] = measure_latency(model, device)
        bdh_result["checkpoint"] = (
            str(checkpoint_path.relative_to(REPO_ROOT))
            if checkpoint_path.is_relative_to(REPO_ROOT)
            else str(checkpoint_path)
        )
        bdh_result["config"] = cfg_d
        bdh_result["device"] = str(device)
        report["bdh"] = bdh_result
        report["spec_gates"] = {
            "phase_0_70pct_kind_acc": bdh_result["kind_accuracy"] >= 0.70,
            "phase_1_plus_10pp_vs_heuristic": (
                bdh_result["kind_accuracy"]
                - heuristic_result["kind_accuracy"]
            )
            >= 0.10,
            "phase_1_p95_latency_80ms": bdh_result["latency"]["p95_ms"] <= 80.0,
        }

    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="BDH routing eval harness (heuristic baseline + gold set + kappa)."
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=None,
        help="path to a trained BDH .pt checkpoint; omit for baseline-only",
    )
    parser.add_argument(
        "--gold",
        type=Path,
        default=DEFAULT_GOLD,
        help=f"gold set JSONL (default: {DEFAULT_GOLD.name})",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"JSON report output path (default: {DEFAULT_OUT.name})",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="force device: mps | cpu | cuda (default: auto-detect)",
    )
    args = parser.parse_args()

    report = run_eval(args.gold, args.checkpoint, args.device)
    print_report(report)

    args.out.write_text(json.dumps(report, indent=2))
    rel = (
        args.out.relative_to(REPO_ROOT)
        if args.out.is_relative_to(REPO_ROOT)
        else args.out
    )
    print(f"\n[eval] wrote {rel}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
