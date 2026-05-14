"""
Tests for the BDH routing eval harness.

Standalone runnable, no pytest dependency (the trainer scripts in this
folder are all plain Python entrypoints; tests match that convention):

    python3 packages/eight-bdh/trainer/local/test_eval_harness.py

Covers:
  1. Cohen's kappa math against hand-verified values.
  2. Gold set integrity: schema, unique ids, all kinds + categories present.
  3. load_gold_set rejects malformed input loudly.
  4. score_router output shape and self-consistency.
  5. _target_ok wildcard / membership logic.
  6. Heuristic sanity: scores well on keyword-obvious, and NOT 100%
     overall -- if it did, the gold set would just be the heuristic's
     own rules restated, and "+10pp vs heuristic" would be unreachable.
  7. BDH decode-path plumbing: a fresh-init (untrained) BDH runs through
     make_bdh_decide end to end without error. Proves the
     prompt -> generate -> regex-parse -> Decision pipeline works.
     Does NOT assert quality -- an untrained model has none.

Exit code 0 = all passed, 1 = at least one failed.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

LOCAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(LOCAL_DIR))

from eval_harness import (  # noqa: E402
    DEFAULT_GOLD,
    VALID_CATEGORIES,
    VALID_KINDS,
    cohens_kappa,
    load_gold_set,
    score_router,
    _target_ok,
)
from baseline_heuristic import HeuristicRouter  # noqa: E402

_PASSED = 0
_FAILED = 0


def check(name: str, fn) -> None:
    global _PASSED, _FAILED
    try:
        fn()
        _PASSED += 1
        print(f"  PASS  {name}", flush=True)
    except Exception as exc:  # noqa: BLE001 - test runner wants every failure
        _FAILED += 1
        print(f"  FAIL  {name}: {exc}", flush=True)
        traceback.print_exc()


def approx(a: float, b: float, eps: float = 1e-9) -> bool:
    return abs(a - b) <= eps


# ── 1. Cohen's kappa ────────────────────────────────────────────────────


def test_kappa_perfect_agreement() -> None:
    k = cohens_kappa(["a", "a", "b", "b"], ["a", "a", "b", "b"], ("a", "b"))
    assert approx(k, 1.0), f"expected 1.0, got {k}"


def test_kappa_total_disagreement() -> None:
    k = cohens_kappa(["a", "a", "b", "b"], ["b", "b", "a", "a"], ("a", "b"))
    assert approx(k, -1.0), f"expected -1.0, got {k}"


def test_kappa_known_partial() -> None:
    # a=[a,a,a,b] b=[a,a,b,b]: p_obs=0.75, p_exp=0.5 -> kappa=0.5
    k = cohens_kappa(["a", "a", "a", "b"], ["a", "a", "b", "b"], ("a", "b"))
    assert approx(k, 0.5), f"expected 0.5, got {k}"


def test_kappa_constant_identical() -> None:
    # both raters constant and identical: degenerate but unambiguous = 1.0
    k = cohens_kappa(["a", "a", "a"], ["a", "a", "a"], ("a", "b"))
    assert approx(k, 1.0), f"expected 1.0, got {k}"


def test_kappa_constant_disjoint() -> None:
    # raters constant but different: no chance of agreement -> 0.0
    k = cohens_kappa(["a", "a"], ["b", "b"], ("a", "b"))
    assert approx(k, 0.0), f"expected 0.0, got {k}"


def test_kappa_length_mismatch_raises() -> None:
    try:
        cohens_kappa(["a"], ["a", "b"], ("a", "b"))
    except ValueError:
        return
    raise AssertionError("expected ValueError on length mismatch")


# ── 2. Gold set integrity ───────────────────────────────────────────────


def test_gold_set_loads() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    assert len(gold) >= 40, f"expected >=40 entries, got {len(gold)}"


def test_gold_set_ids_unique() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    ids = [e["id"] for e in gold]
    assert len(ids) == len(set(ids)), "duplicate ids in gold set"


def test_gold_set_covers_all_kinds() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    kinds = {e["gold"]["kind"] for e in gold}
    missing = set(VALID_KINDS) - kinds
    assert not missing, f"gold set missing kinds: {missing}"


def test_gold_set_covers_all_categories() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    cats = {e["category"] for e in gold}
    missing = set(VALID_CATEGORIES) - cats
    assert not missing, f"gold set missing categories: {missing}"


def test_gold_set_rationales_nonempty() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    for e in gold:
        assert e["rationale"].strip(), f"{e['id']}: empty rationale"


# ── 3. load_gold_set rejects malformed input ────────────────────────────


def _write_tmp(content: str) -> Path:
    p = LOCAL_DIR / "_test_tmp_gold.jsonl"
    p.write_text(content)
    return p


def test_load_rejects_bad_json() -> None:
    p = _write_tmp('{"id": "x", not json}\n')
    try:
        load_gold_set(p)
    except ValueError:
        return
    finally:
        p.unlink(missing_ok=True)
    raise AssertionError("expected ValueError on invalid JSON")


def test_load_rejects_missing_field() -> None:
    p = _write_tmp('{"id": "x", "category": "semantic-hard", "state": {}}\n')
    try:
        load_gold_set(p)
    except ValueError:
        return
    finally:
        p.unlink(missing_ok=True)
    raise AssertionError("expected ValueError on missing field")


def test_load_rejects_bad_kind() -> None:
    bad = (
        '{"id": "x", "category": "semantic-hard", '
        '"state": {"request": "r", "context": {}, "policy": {}}, '
        '"gold": {"kind": "banana", "target_acceptable": ["*"]}, '
        '"rationale": "r"}\n'
    )
    p = _write_tmp(bad)
    try:
        load_gold_set(p)
    except ValueError:
        return
    finally:
        p.unlink(missing_ok=True)
    raise AssertionError("expected ValueError on bad gold.kind")


def test_load_rejects_duplicate_id() -> None:
    entry = (
        '{"id": "dup", "category": "semantic-hard", '
        '"state": {"request": "r", "context": {}, "policy": {}}, '
        '"gold": {"kind": "model", "target_acceptable": ["*"]}, '
        '"rationale": "r"}\n'
    )
    p = _write_tmp(entry + entry)
    try:
        load_gold_set(p)
    except ValueError:
        return
    finally:
        p.unlink(missing_ok=True)
    raise AssertionError("expected ValueError on duplicate id")


# ── 4. score_router shape ───────────────────────────────────────────────


def test_score_router_shape() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    result = score_router("heuristic", HeuristicRouter().decide, gold)
    for key in (
        "router",
        "n",
        "kind_accuracy",
        "target_accuracy",
        "undecodable",
        "cohens_kappa_vs_gold",
        "by_category",
        "by_kind",
        "confusion_gold_x_pred",
        "per_entry",
    ):
        assert key in result, f"score_router result missing '{key}'"
    assert result["n"] == len(gold)
    assert len(result["per_entry"]) == len(gold)
    assert 0.0 <= result["kind_accuracy"] <= 1.0
    # target accuracy can never exceed kind accuracy (target requires kind)
    assert result["target_accuracy"] <= result["kind_accuracy"] + 1e-9


def test_score_router_confusion_sums() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    result = score_router("heuristic", HeuristicRouter().decide, gold)
    total = sum(
        result["confusion_gold_x_pred"][g][p]
        for g in VALID_KINDS
        for p in VALID_KINDS
    )
    # confusion only counts decodable predictions; heuristic never returns None
    assert total == len(gold), f"confusion sums to {total}, expected {len(gold)}"


# ── 5. _target_ok logic ─────────────────────────────────────────────────


def test_target_ok_wildcard() -> None:
    assert _target_ok("anything", ["*"]) is True
    assert _target_ok("Read", ["Read", "Bash"]) is True
    assert _target_ok("Edit", ["Read", "Bash"]) is False


# ── 6. Heuristic sanity ─────────────────────────────────────────────────


def test_heuristic_strong_on_keyword_obvious() -> None:
    gold = load_gold_set(DEFAULT_GOLD)
    result = score_router("heuristic", HeuristicRouter().decide, gold)
    ko = result["by_category"]["keyword-obvious"]["kind_accuracy"]
    assert ko >= 0.6, f"heuristic only {ko:.0%} on keyword-obvious tier"


def test_heuristic_not_perfect_overall() -> None:
    # If the heuristic scored 100%, the gold set would just be the
    # heuristic's own rules restated and the +10pp gate would be
    # unreachable by construction. The gold set must contain cases the
    # keyword router gets wrong.
    gold = load_gold_set(DEFAULT_GOLD)
    result = score_router("heuristic", HeuristicRouter().decide, gold)
    assert result["kind_accuracy"] < 1.0, (
        "heuristic scored 100% -- gold set has no cases that defeat "
        "keyword routing; +10pp gate would be unreachable"
    )


# ── 7. BDH decode-path plumbing (untrained model) ───────────────────────


def test_bdh_decode_path_plumbing() -> None:
    """A fresh-init BDH must run through make_bdh_decide without error.
    Quality is not asserted -- an untrained model has none. This proves
    prompt -> generate -> regex-parse -> Decision is wired correctly so
    the path is ready the moment a trained checkpoint exists."""
    import torch

    sys.path.insert(0, str(Path.home() / "8gent-bdh"))
    from bdh import BDH, BDHConfig

    from eval_harness import make_bdh_decide, select_device

    device = select_device("cpu")  # cpu keeps the test cheap and deterministic-ish
    cfg = BDHConfig(
        n_layer=6,
        n_embd=160,
        n_head=4,
        mlp_internal_dim_multiplier=64,
        dropout=0.1,
        vocab_size=256,
    )
    torch.manual_seed(42)
    model = BDH(cfg).to(device)
    model.eval()
    decide = make_bdh_decide(model, device)

    gold = load_gold_set(DEFAULT_GOLD)
    decision = decide(gold[0]["state"])
    # untrained: either undecodable (None) or a structurally valid dict
    if decision is not None:
        assert decision["kind"] in VALID_KINDS, (
            f"decoded kind '{decision['kind']}' not a valid DecisionKind"
        )
        assert "target" in decision
    # the point is no exception was raised reaching here
    print("        (bdh plumbing ran; decision was "
          f"{'None/undecodable' if decision is None else decision['kind']})",
          flush=True)


# ── Runner ──────────────────────────────────────────────────────────────


def main() -> int:
    print("test_eval_harness.py", flush=True)
    print("-" * 60, flush=True)

    print("\n[1] Cohen's kappa", flush=True)
    check("kappa: perfect agreement = 1.0", test_kappa_perfect_agreement)
    check("kappa: total disagreement = -1.0", test_kappa_total_disagreement)
    check("kappa: known partial = 0.5", test_kappa_known_partial)
    check("kappa: constant identical = 1.0", test_kappa_constant_identical)
    check("kappa: constant disjoint = 0.0", test_kappa_constant_disjoint)
    check("kappa: length mismatch raises", test_kappa_length_mismatch_raises)

    print("\n[2] Gold set integrity", flush=True)
    check("gold set loads (>=40 entries)", test_gold_set_loads)
    check("gold set ids unique", test_gold_set_ids_unique)
    check("gold set covers all 5 kinds", test_gold_set_covers_all_kinds)
    check("gold set covers all 4 categories", test_gold_set_covers_all_categories)
    check("gold set rationales non-empty", test_gold_set_rationales_nonempty)

    print("\n[3] load_gold_set rejects malformed input", flush=True)
    check("rejects invalid JSON", test_load_rejects_bad_json)
    check("rejects missing field", test_load_rejects_missing_field)
    check("rejects bad gold.kind", test_load_rejects_bad_kind)
    check("rejects duplicate id", test_load_rejects_duplicate_id)

    print("\n[4] score_router", flush=True)
    check("score_router output shape", test_score_router_shape)
    check("confusion matrix sums to n", test_score_router_confusion_sums)

    print("\n[5] _target_ok logic", flush=True)
    check("_target_ok wildcard + membership", test_target_ok_wildcard)

    print("\n[6] Heuristic sanity", flush=True)
    check("heuristic strong on keyword-obvious", test_heuristic_strong_on_keyword_obvious)
    check("heuristic not 100% overall", test_heuristic_not_perfect_overall)

    print("\n[7] BDH decode-path plumbing", flush=True)
    check("untrained BDH runs through make_bdh_decide", test_bdh_decode_path_plumbing)

    print("-" * 60, flush=True)
    total = _PASSED + _FAILED
    print(f"{_PASSED}/{total} passed, {_FAILED} failed", flush=True)
    return 0 if _FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
