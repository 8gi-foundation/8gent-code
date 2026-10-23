"""8J inference, rebuilt for serving.

8J is Artale's System One decision model (HF 8GI/8j): a Qwen3 backbone with a LoRA adapter and a
small attention head that scores named options in one forward pass, no generation. This module
is the inference path of the 8GI/8j-eval Space (tokenization.py, network.py, logger.py,
inference.py), rebuilt with nothing for training:

  - the prompt layout, position ids, attention mask and read indices match the Space token for
    token, so the checkpoint sees exactly what it was trained on;
  - the LoRA adapter is merged into the backbone weights at load time (W += alpha/r * B @ A), so
    serving needs no PEFT and the merged graph exports to ONNX as plain linear layers;
  - every name and path comes from the checkpoint's meta.json and adapter_config.json.

`parity_check.py` proves this matches the Space's own `answer()` on the eval commands.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("USE_TF", "0")

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

TASK_TYPES = {"choice": 0, "noul": 1, "score": 2}
TASK_PROMPTS = {
    "choice": "Choose the best option.",
    "score": "Rate it on the given scale.",
    "noul": "Answer yes or no.",
}
ANSWER_PROMPT = "The answer is:"


# ---- prompt -------------------------------------------------------------------------------------


class Prompt:
    """Token layout for one question. Holds the tokenizer; pure functions of it otherwise."""

    def __init__(self, tokenizer, max_state_tokens: int, max_choice_tokens: int):
        self.tok = tokenizer
        self.max_state_tokens = max_state_tokens
        self.max_choice_tokens = max_choice_tokens
        self.begin = tokenizer.encode("<option>")
        self.end = tokenizer.encode("</option>")

    def truncate(self, text: str, max_tokens: int, tail_ratio: float = 0.25) -> str:
        tokens = self.tok.encode(text)
        if len(tokens) <= max_tokens:
            return text
        tail = max(1, int(max_tokens * tail_ratio))
        head = max(1, max_tokens - tail)
        if tail >= len(tokens):
            return self.tok.decode(tokens[-max_tokens:])
        return self.tok.decode(tokens[:head] + tokens[-tail:])

    def question_text(self, state: str, instructions: str, kind: str, guidance: str | None) -> str:
        parts = [TASK_PROMPTS[kind]]
        if guidance:
            parts.append(f"Guidance: {guidance}")
        parts.append(f"Question: {instructions}")
        parts.append(f"\n{self.truncate(state, self.max_state_tokens)}\n")
        return "\n".join(parts)

    def encode(self, state: str, instructions: str, choices: list[str], kind: str,
               guidance: str | None = None) -> dict:
        question = self.tok.encode(self.question_text(state, instructions, kind, guidance))
        tokens = list(question)
        q_len = len(question)
        choice_ends: list[int] = []
        for choice in choices:
            tokens += self.begin + self.tok.encode(self.truncate(choice, self.max_choice_tokens)) + self.end
            choice_ends.append(len(tokens) - 1)
        tokens += self.tok.encode(ANSWER_PROMPT)
        length = len(tokens)

        # Position ids: the question counts up; every choice restarts where the question ended;
        # the answer starts after the longest choice, so every choice token is in its past.
        pos = list(range(q_len))
        start = q_len
        for end in choice_ends:
            pos += [q_len + i for i in range(end - start + 1)]
            start = end + 1
        answer_start = max(pos) + 1
        pos += [answer_start + i for i in range(length - len(pos))]

        # Attention: causal over the question; each choice causal within itself and sees the
        # question; the answer sees everything before it and is causal within itself.
        mask = torch.zeros((length, length))
        mask[:q_len, :q_len] = torch.tril(torch.ones(q_len, q_len))
        start = q_len
        for end in choice_ends:
            n = end - start + 1
            mask[start:end + 1, start:end + 1] = torch.tril(torch.ones(n, n))
            start = end + 1
        mask[q_len:, :q_len] = 1
        a0 = choice_ends[-1] + 1
        mask[a0:, :a0] = 1
        mask[a0:, a0:] = torch.tril(torch.ones(length - a0, length - a0))

        return {
            "input_ids": torch.tensor([tokens], dtype=torch.long),
            "position_ids": torch.tensor([pos], dtype=torch.long),
            # Additive 4D mask [1, 1, L, L]: 0 where attended, -inf elsewhere (the Space's collate_fn).
            "attention_mask": torch.where(mask == 0, -float("inf"), 0.0)[None, None],
            # Read each choice at its last content token, not at the closing ">" of </option>.
            "choice_read_idx": torch.tensor([[e - len(self.end) for e in choice_ends]], dtype=torch.long),
            "answer_end_idx": torch.tensor([length - 1], dtype=torch.long),
        }


# ---- head ---------------------------------------------------------------------------------------
# Parameter names match the Space's ChoiceHead so head.pt loads with strict=True.


class _SelfAttention(nn.Module):
    def __init__(self, hidden: int, dim: int):
        super().__init__()
        self.dim = dim
        self.q, self.k, self.v = nn.Linear(hidden, dim), nn.Linear(hidden, dim), nn.Linear(hidden, dim)
        self.o = nn.Linear(dim, hidden)

    def forward(self, x, valid):
        scores = torch.einsum("bqd,bkd->bqk", self.q(x), self.k(x)) / math.sqrt(self.dim)
        scores = scores.masked_fill(~valid[:, None, :], -float("inf"))
        return self.o(torch.einsum("bqk,bkd->bqd", torch.softmax(scores, dim=-1), self.v(x)))


class _Block(nn.Module):
    def __init__(self, hidden: int, dim: int):
        super().__init__()
        self.norm1, self.norm2 = nn.LayerNorm(hidden), nn.LayerNorm(hidden)
        self.attn = _SelfAttention(hidden, dim)
        self.mlp = nn.Sequential(nn.Linear(hidden, dim), nn.GELU(), nn.Linear(dim, hidden))

    def forward(self, x, valid):
        x = x + self.attn(self.norm1(x), valid)
        return x + self.mlp(self.norm2(x))


class ChoiceHead(nn.Module):
    def __init__(self, hidden_dim: int, new_dim: int, num_layers: int, num_task_types: int):
        super().__init__()
        self.new_dim = new_dim
        self.task_embedding = nn.Embedding(num_task_types, hidden_dim)
        self.input_norm = nn.LayerNorm(hidden_dim)
        self.layers = nn.ModuleList([_Block(hidden_dim, new_dim) for _ in range(num_layers)])
        self.final_norm = nn.LayerNorm(hidden_dim)
        self.answer_proj = nn.Linear(hidden_dim, new_dim)
        self.choice_proj = nn.Linear(hidden_dim, new_dim)

    def forward(self, choice_emb, answer_emb, task_type):
        # One request at a time, every choice valid: no padding to mask.
        x = torch.cat([self.task_embedding(task_type)[:, None], choice_emb, answer_emb[:, None]], dim=1)
        x = self.input_norm(x)
        valid = torch.ones(x.shape[:2], dtype=torch.bool)
        for layer in self.layers:
            x = layer(x, valid)
        x = self.final_norm(x)
        answer = self.answer_proj(x[:, -1])
        choices = self.choice_proj(x[:, 1:-1])
        return torch.einsum("bd,bcd->bc", answer, choices) / math.sqrt(self.new_dim)


# ---- model --------------------------------------------------------------------------------------


class Judge8J(nn.Module):
    """Backbone (LoRA merged) plus head. forward() returns the raw choice logits [1, C]."""

    def __init__(self, backbone, head):
        super().__init__()
        self.backbone, self.head = backbone, head

    def forward(self, input_ids, position_ids, attention_mask, choice_read_idx, answer_end_idx, task_type):
        hidden = self.backbone(input_ids=input_ids, attention_mask=attention_mask, position_ids=position_ids,
                               use_cache=False).last_hidden_state.float()
        choice_emb = hidden[0, choice_read_idx[0]][None]
        answer_emb = hidden[0, answer_end_idx]
        return self.head(choice_emb, answer_emb, task_type)


def merge_lora(backbone: nn.Module, ckpt: Path) -> int:
    """Fold the adapter into the backbone in place. Returns how many linear layers changed."""
    from safetensors.torch import load_file

    cfg = json.loads((ckpt / "adapter_config.json").read_text())
    if cfg.get("use_dora") or cfg.get("use_rslora"):
        raise ValueError("8j: DoRA / rsLoRA adapters are not supported by the merge")
    scale = cfg["lora_alpha"] / cfg["r"]
    weights = load_file(str(ckpt / "adapter_model.safetensors"))
    prefix = "base_model.model."
    merged = 0
    modules = dict(backbone.named_modules())
    for key, a in weights.items():
        if not key.endswith(".lora_A.weight"):
            continue
        name = key[len(prefix):-len(".lora_A.weight")]
        b = weights[key.replace(".lora_A.", ".lora_B.")]
        layer = modules[name]
        with torch.no_grad():
            layer.weight += scale * (b.float() @ a.float())
        merged += 1
    if merged == 0:
        raise ValueError(f"8j: no LoRA weights in {ckpt}; refusing to serve the bare backbone")
    return merged


def load(ckpt_dir: str | os.PathLike) -> tuple[Judge8J, Prompt, dict]:
    """Load a published 8J run directory (meta.json, adapter, head.pt). CPU, fp32, eval mode."""
    from transformers import AutoTokenizer, Qwen3Model

    ckpt = Path(ckpt_dir)
    meta = json.loads((ckpt / "meta.json").read_text())
    temps = ckpt / "temperatures.json"
    if "temperatures" not in meta and temps.exists():
        meta["temperatures"] = json.loads(temps.read_text())["temperatures"]
    base = meta["model_name"]
    overrides = {} if meta.get("num_layers") is None else {"num_hidden_layers": meta["num_layers"]}
    backbone = Qwen3Model.from_pretrained(base, dtype=torch.float32, **overrides)
    merge_lora(backbone, ckpt)
    head = ChoiceHead(hidden_dim=backbone.config.hidden_size, **meta["head_config"])
    head.load_state_dict(torch.load(ckpt / "head.pt", map_location="cpu"), strict=True)
    net = Judge8J(backbone, head).eval()
    prompt = Prompt(AutoTokenizer.from_pretrained(base), meta["max_state_tokens"], meta["max_choice_tokens"])
    meta["run"] = ckpt.name
    return net, prompt, meta


def choices_for(question: dict) -> list[str]:
    """The Space's question_to_choices, for one validated question."""
    kind = question["type"]
    if kind == "noul":
        # A two-way choice, "No" first. An optional rubric {"false": ..., "true": ...} replaces the
        # bare words: it is the whole signal for a gate, so it is kept as the option text.
        crit = question.get("criteria") or {}
        return [crit.get("false") or "No", crit.get("true") or "Yes"]
    if kind == "choice":
        crit = question["criteria"]
        return [f"{k}: {v}" if v is not None else str(k) for k, v in crit.items()]
    # Score levels share position ids, so the index is written into the text to keep the order.
    return [f"{i}: {level}" for i, level in enumerate(question["criteria"])]


def temperature(meta: dict, kind: str) -> float:
    t = float((meta.get("temperatures") or {}).get(kind, 1.0))
    return t if t > 0 else 1.0


@torch.no_grad()
def logits_for(net: Judge8J, prompt: Prompt, state: str, question: dict, guidance: str | None = None):
    kind = question["type"]
    enc = prompt.encode(state, question["instructions"], choices_for(question), kind, guidance)
    return net(task_type=torch.tensor([TASK_TYPES[kind]]), **enc)[0].float()


def answer(net: Judge8J, prompt: Prompt, meta: dict, state: str, question: dict, guidance: str | None = None) -> dict:
    """One typed answer in the model card's shape (the Space's inference.answer)."""
    kind = question["type"]
    probs = torch.softmax(logits_for(net, prompt, state, question, guidance) / temperature(meta, kind), -1).tolist()
    if kind == "noul":
        return {"type": "noul", "noul": probs[1]}
    if kind == "choice":
        keys = list(question["criteria"])
        best = max(range(len(keys)), key=probs.__getitem__)
        return {"type": "choice", "choice": keys[best], "probabilities": dict(zip(keys, probs))}
    return {"type": "score", "score": sum(i * p for i, p in enumerate(probs)), "probabilities": probs}
