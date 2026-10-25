"""fp32 agreement of 8J's ONNX graphs on the held-out judge-set split.

    python onnx_check.py --ckpt <run-dir> --onnx-dir <dir> --results <results.json>
                         --calibration <8j-<model>.json> [--write-encoded test-split.jsonl]

`--results` is the judge-set results file (packages/decide/eval/results/2026-10-23-8j-<model>.json,
PR #4863); its test-split rows are the commands checked. For each one:

  - judge8j (torch, fp32) is the reference pYes, with guard.ts's question and framing;
  - run_onnx.inputs rebuilds the graph inputs from token spans and must equal judge8j's own
    tensors exactly (this is what the phone runs);
  - the fp32 and int8 ONNX graphs answer through run_onnx.probs.

Tolerances, fixed before the run: fp32 ONNX |dp| <= 1e-4; int8 |dp| <= 0.02 and no verdict
change at the calibration's lines. Exit 1 when any fails.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

import judge8j
import run_onnx
from parity_check import QUESTION, guard_state

FP32_TOL = 1e-4
INT8_TOL = 0.02


def encoded(prompt: judge8j.Prompt, state: str) -> dict:
    """Token ids and spans for one noul guard question (the layout judge8j.Prompt.encode builds)."""
    tok = prompt.tok
    q = tok.encode(prompt.question_text(state, QUESTION, "noul", None))
    ids, ends = list(q), []
    for choice in judge8j.choices_for({"type": "noul"}):
        ids += prompt.begin + tok.encode(prompt.truncate(choice, prompt.max_choice_tokens)) + prompt.end
        ends.append(len(ids) - 1)
    ids += tok.encode(judge8j.ANSWER_PROMPT)
    return {"ids": ids, "q_len": len(q), "choice_ends": ends, "read_idx": [e - len(prompt.end) for e in ends], "kind": "noul"}


def verdict(p: float, low: float, high: float) -> str:
    return "escalate" if low <= p <= high else ("block" if p > high else "allow")


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--ckpt", required=True)
    a.add_argument("--onnx-dir", required=True)
    a.add_argument("--results", required=True)
    a.add_argument("--calibration", required=True)
    a.add_argument("--int8", default="8j-int8.onnx", help="int8 graph file name inside --onnx-dir")
    a.add_argument("--write-encoded")
    args = a.parse_args()

    rows = [r for r in json.load(open(args.results))["rows"] if r["split"] == "test"]
    cal = json.load(open(args.calibration))
    low, high = cal["escalateBand"]
    net, prompt, meta = judge8j.load(args.ckpt)
    t = judge8j.temperature(meta, "noul")
    d = Path(args.onnx_dir)
    fp32 = run_onnx.session(str(d / "8j-fp32.onnx"))
    int8 = run_onnx.session(str(d / args.int8))

    out, recs = [], []
    for r in rows:
        state = guard_state(r["cmd"])
        q = {"type": "noul", "instructions": QUESTION}
        ref = judge8j.answer(net, prompt, meta, state, q)["noul"]
        rec = {"cmd": r["cmd"], **encoded(prompt, state)}
        mine = run_onnx.inputs(rec)
        theirs = prompt.encode(state, QUESTION, judge8j.choices_for(q), "noul")
        same = all(np.array_equal(mine[k], theirs[k].numpy()) for k in theirs)
        same = same and int(mine["task_type"][0]) == judge8j.TASK_TYPES["noul"]
        recs.append(rec)
        out.append({"cmd": r["cmd"], "risky": r["risky"], "ref": ref, "served": r["p"], "inputs_equal": same,
                    "fp32": float(run_onnx.probs(fp32, rec, t)[1]), "int8": float(run_onnx.probs(int8, rec, t)[1])})

    dmax = lambda k: max(abs(o[k] - o["ref"]) for o in out)
    changed = [o for o in out if verdict(o["int8"], low, high) != verdict(o["ref"], low, high)]
    report = {
        "n": len(out),
        "tolerance": {"fp32": FP32_TOL, "int8": INT8_TOL, "int8_verdict_changes": 0},
        "inputs_equal": sum(o["inputs_equal"] for o in out),
        "max_abs_dp": {"torch_vs_served": dmax("served"), "fp32_onnx": dmax("fp32"), "int8_onnx": dmax("int8")},
        "mean_abs_dp_int8": float(np.mean([abs(o["int8"] - o["ref"]) for o in out])),
        "int8_rows_over_tol": sum(abs(o["int8"] - o["ref"]) > INT8_TOL for o in out),
        "lines": [low, high],
        "int8_verdict_changes": [{"cmd": o["cmd"], "ref": round(o["ref"], 4), "int8": round(o["int8"], 4),
                                  "from": verdict(o["ref"], low, high), "to": verdict(o["int8"], low, high)} for o in changed],
    }
    report["pass"] = (report["inputs_equal"] == len(out) and report["max_abs_dp"]["fp32_onnx"] <= FP32_TOL
                      and report["max_abs_dp"]["int8_onnx"] <= INT8_TOL and not changed)
    print(json.dumps(report, indent=1))
    if args.write_encoded:
        with open(args.write_encoded, "w") as f:
            for rec in recs:
                f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    torch.set_grad_enabled(False)
    sys.exit(main())
