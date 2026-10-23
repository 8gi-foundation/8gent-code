"""Run 8J's ONNX graph with numpy and onnxruntime only: the phone side (Termux, no torch).

    python run_onnx.py --model 8j-int8.onnx --meta 8j-meta.json --encoded test-split.jsonl [--threads N]

`--encoded` holds one prompt per line, already tokenised (onnx_check.py --write-encoded writes
it from judge8j.Prompt): {"cmd", "ids", "q_len", "choice_ends", "read_idx", "kind"}. Position ids
and the attention mask are rebuilt here from those spans, exactly as judge8j.Prompt.encode
builds them, so this measures the model, not a tokenizer. Prints one JSON line per prompt
({"cmd", "p", "ms"}) and a final summary: latency p50 / p95 and peak RSS.

8J is Artale's model (HF 8GI/8j).
"""

from __future__ import annotations

import argparse
import json
import resource
import sys
import time

import numpy as np

TASK_TYPES = {"choice": 0, "noul": 1, "score": 2}


def inputs(rec: dict) -> dict:
    """The graph's six inputs for one encoded prompt (judge8j.Prompt.encode, rebuilt in numpy)."""
    ids = rec["ids"]
    q_len, ends = rec["q_len"], rec["choice_ends"]
    length = len(ids)
    pos = list(range(q_len))
    start = q_len
    for end in ends:
        pos += [q_len + i for i in range(end - start + 1)]
        start = end + 1
    a_start = max(pos) + 1
    pos += [a_start + i for i in range(length - len(pos))]

    mask = np.zeros((length, length), dtype=np.float32)
    mask[:q_len, :q_len] = np.tril(np.ones((q_len, q_len), dtype=np.float32))
    start = q_len
    for end in ends:
        n = end - start + 1
        mask[start:end + 1, start:end + 1] = np.tril(np.ones((n, n), dtype=np.float32))
        start = end + 1
    mask[q_len:, :q_len] = 1
    a0 = ends[-1] + 1
    mask[a0:, :a0] = 1
    mask[a0:, a0:] = np.tril(np.ones((length - a0, length - a0), dtype=np.float32))
    additive = np.where(mask == 0, np.float32(-np.inf), np.float32(0.0))[None, None]

    return {
        "input_ids": np.asarray([ids], dtype=np.int64),
        "position_ids": np.asarray([pos], dtype=np.int64),
        "attention_mask": additive,
        "choice_read_idx": np.asarray([rec["read_idx"]], dtype=np.int64),
        "answer_end_idx": np.asarray([length - 1], dtype=np.int64),
        "task_type": np.asarray([TASK_TYPES[rec["kind"]]], dtype=np.int64),
    }


def probs(session, rec: dict, temperature: float) -> np.ndarray:
    logits = session.run(["logits"], inputs(rec))[0][0].astype(np.float64) / temperature
    e = np.exp(logits - logits.max())
    return e / e.sum()


def session(model: str, threads: int = 0):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    if threads > 0:
        opts.intra_op_num_threads = threads
    return ort.InferenceSession(model, opts, providers=["CPUExecutionProvider"])


def peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1e6 if sys.platform == "darwin" else peak / 1e3  # bytes on macOS, KiB on Linux


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--meta", required=True)
    p.add_argument("--encoded", required=True)
    p.add_argument("--threads", type=int, default=0)
    a = p.parse_args()
    meta = json.load(open(a.meta))
    t0 = time.perf_counter()
    sess = session(a.model, a.threads)
    load_s = time.perf_counter() - t0
    recs = [json.loads(line) for line in open(a.encoded) if line.strip()]
    temp = lambda kind: float((meta.get("temperatures") or {}).get(kind, 1.0)) or 1.0
    probs(sess, recs[0], temp(recs[0]["kind"]))  # warm-up, not timed
    times = []
    for rec in recs:
        t = time.perf_counter()
        pr = probs(sess, rec, temp(rec["kind"]))
        ms = (time.perf_counter() - t) * 1000
        times.append(ms)
        print(json.dumps({"cmd": rec["cmd"], "p": float(pr[1]), "ms": round(ms, 1)}))
    times.sort()
    q = lambda f: times[min(len(times) - 1, int(round(f * (len(times) - 1))))]
    print(json.dumps({"summary": True, "n": len(times), "load_s": round(load_s, 2), "p50_ms": round(q(0.5), 1),
                      "p95_ms": round(q(0.95), 1), "peak_rss_mb": round(peak_rss_mb()), "model": a.model}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
