"""Export 8J (backbone with the LoRA merged, plus head) to ONNX, then quantise its weights to int8.

    python export_onnx.py --ckpt <run-dir> --out <dir>

Writes <out>/8j-fp32.onnx (+ 8j-fp32.onnx.data: over 2 GB, so the weights sit beside it),
<out>/8j-int8.onnx (weight-only 8-bit, about 1.06 GB: the 622 MB embedding table stays fp32) and
<out>/8j-meta.json (temperatures, run name, token limits). The graph takes the inputs
judge8j.Prompt.encode builds, so any runtime that can rebuild them (run_onnx.py: numpy only)
answers exactly what serve_8j.py answers:

    input_ids [1, L] int64, position_ids [1, L] int64, attention_mask [1, 1, L, L] float32
    (0 attended, -inf not), choice_read_idx [1, C] int64, answer_end_idx [1] int64,
    task_type [1] int64  ->  logits [1, C] float32 (before temperature)

8J is Artale's model (HF 8GI/8j). Weights are never written into the repo.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch

import judge8j

INPUTS = ["input_ids", "position_ids", "attention_mask", "choice_read_idx", "answer_end_idx", "task_type"]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    net, prompt, meta = judge8j.load(a.ckpt)
    # The eager attention path: a plain matmul + additive mask, which exports to stock ONNX ops.
    net.backbone.config._attn_implementation = "eager"
    enc = prompt.encode("ls -la", "Is this a sample?", ["No", "Yes"], "noul")
    args = tuple(enc[k] for k in INPUTS[:-1]) + (torch.tensor([judge8j.TASK_TYPES["noul"]]),)

    class Graph(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, input_ids, position_ids, attention_mask, choice_read_idx, answer_end_idx, task_type):
            return self.inner(input_ids=input_ids, position_ids=position_ids, attention_mask=attention_mask,
                              choice_read_idx=choice_read_idx, answer_end_idx=answer_end_idx, task_type=task_type)

    import shutil

    import onnx

    raw = out / "fp32-raw"  # the exporter writes one file per tensor; folded into one below
    raw.mkdir(exist_ok=True)
    fp32 = out / "8j-fp32.onnx"
    with torch.no_grad():
        torch.onnx.export(
            Graph(net).eval(), args, str(raw / "8j-fp32.onnx"), input_names=INPUTS, output_names=["logits"],
            dynamic_axes={"input_ids": {1: "L"}, "position_ids": {1: "L"}, "attention_mask": {2: "L", 3: "L"},
                          "choice_read_idx": {1: "C"}, "logits": {1: "C"}},
            opset_version=17, dynamo=False, external_data=True,
        )
    model = onnx.load(str(raw / "8j-fp32.onnx"))
    onnx.save(model, str(fp32), save_as_external_data=True, all_tensors_to_one_file=True,
              location="8j-fp32.onnx.data")
    shutil.rmtree(raw)
    model = onnx.load(str(fp32))  # resolves 8j-fp32.onnx.data beside the file, not in the cwd

    # Weight-only 8-bit (MatMulNBits): weights int8 in blocks of 32 with a symmetric scale each,
    # activations stay fp32. Dynamic int8 (quantize_dynamic, activations quantised too) was
    # measured first and moved pYes by up to 0.76 on the held-out split; see onnx_check.py.
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    int8 = out / "8j-int8.onnx"
    q = MatMulNBitsQuantizer(model, bits=8, block_size=32, is_symmetric=True, op_types_to_quantize=("MatMul",))
    q.process()
    q.model.save_model_to_file(str(int8), use_external_data_format=False)
    (out / "8j-meta.json").write_text(json.dumps({
        "run": meta["run"], "base": meta["model_name"], "temperatures": meta.get("temperatures") or {},
        "max_state_tokens": meta["max_state_tokens"], "max_choice_tokens": meta["max_choice_tokens"],
        "inputs": INPUTS,
    }, indent=1))
    size = lambda f: os.path.getsize(f) / 1e6
    data = fp32.with_suffix(".onnx.data")
    print(json.dumps({"fp32_mb": round(size(fp32) + (size(data) if data.exists() else 0)), "int8_mb": round(size(int8))}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
