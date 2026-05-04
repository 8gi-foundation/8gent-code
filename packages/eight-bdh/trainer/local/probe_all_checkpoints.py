"""
Probe all 4 trained checkpoints with identical prompts.
Apples-to-apples comparison for the Phase 2 synthesis report.

Run:
  python3 packages/eight-bdh/trainer/local/probe_all_checkpoints.py

Outputs:
  packages/eight-bdh/trainer/local/probe-comparison.json
  human-readable side-by-side to stdout
"""

import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BDH_REPO = Path.home() / "8gent-bdh"
CHECKPOINT_DIR = REPO_ROOT / "packages" / "eight-bdh" / "checkpoints"
LOG_DIR = REPO_ROOT / "packages" / "eight-bdh" / "trainer" / "local"
REPORT_PATH = LOG_DIR / "probe-comparison.json"

sys.path.insert(0, str(BDH_REPO))

import torch
from bdh import BDH, BDHConfig

CHECKPOINTS = {
    "phase-0": CHECKPOINT_DIR / "phase-0-5m.pt",
    "phase-1": CHECKPOINT_DIR / "phase-1-explore-5m.pt",
    "phase-2a": CHECKPOINT_DIR / "phase-2a-scale-5m.pt",
    "phase-2b": CHECKPOINT_DIR / "phase-2b-capacity-10m.pt",
    "phase-3c": CHECKPOINT_DIR / "phase-3c-toolcalls-5m.pt",
}

# Identical prompts to test all checkpoints on the same probes.
# Each category has 10 probes (session, doc, blog), 5 unseen-tag, 3 control.
# The original 8 probes are preserved exactly; new probes are appended per category.
PROBES = [
    # ---- ORIGINAL 8 (preserved exactly) ----
    {
        "id": "doc-continuation",
        "prompt": "<<doc:packages/eight-bdh/MODEL-CARD.md>>\n# Model Card\n\nThe 8gent 0.1 BDH",
        "expected": "doc/markdown style continuation",
    },
    {
        "id": "session-schema",
        "prompt": "<<session:abc12345.json>>\n{\"createdAt\":\"",
        "expected": "valid ISO timestamp + JSON fields",
    },
    {
        "id": "blog-prefix",
        "prompt": "<<blog:content/blog/welcome-to-the-circle.mdx>>\n---\ntitle: \"",
        "expected": "blog title + frontmatter",
    },
    {
        "id": "memorisation-front",
        "prompt": "front",
        "expected": "should NOT regurgitate 'frontier teacher. Diversity is structural'",
    },
    {
        "id": "memorisation-frontier",
        "prompt": "frontier",
        "expected": "should NOT continue 'teacher. Diversity is structural'",
    },
    {
        "id": "no-prefix",
        "prompt": "\n",
        "expected": "default style; what's the model's null distribution?",
    },
    {
        "id": "unseen-tag",
        "prompt": "<<email:user@example.com>>\n",
        "expected": "model has never seen this prefix in training; coherent or noise?",
    },
    {
        "id": "harness-claim",
        "prompt": "8gent is",
        "expected": "completion of a natural English statement; tests if any English emerges",
    },

    # ---- SESSION PROBES (9 new; 10 total including session-schema above) ----
    {
        "id": "session-long-id",
        "prompt": "<<session:a1b2c3d4e5f6.json>>\n{\"createdAt\":\"2026-03",
        "expected": "timestamp continuation",
    },
    {
        "id": "session-with-cwd",
        "prompt": "<<session:bb3e71c.json>>\n{\"cwd\":\"/Users/",
        "expected": "file path continuation",
    },
    {
        "id": "session-messages",
        "prompt": "<<session:f03a912.json>>\n{\"messages\":[{\"role\":\"user\",\"content\":\"",
        "expected": "message content continuation",
    },
    {
        "id": "session-message-count",
        "prompt": "<<session:d7e4c21b.json>>\n{\"messageCount\":14,\"lastActiveAt\":\"2026-04",
        "expected": "JSON field continuation",
    },
    {
        "id": "session-no-last-active",
        "prompt": "<<session:cc901ff2.json>>\n{\"id\":\"cc901ff2\",\"messageCount\":3,\"cwd\":\"/home/",
        "expected": "JSON field continuation",
    },
    {
        "id": "session-deep-cwd",
        "prompt": "<<session:9a3f01de.json>>\n{\"cwd\":\"/home/operator/8gi-governance/packages/",
        "expected": "file path continuation",
    },
    {
        "id": "session-title-field",
        "prompt": "<<session:4f8b2e3a.json>>\n{\"title\":\"",
        "expected": "session title string continuation",
    },
    {
        "id": "session-created-epoch",
        "prompt": "<<session:7c5d9b1e.json>>\n{\"createdAt\":1746",
        "expected": "epoch timestamp continuation",
    },
    {
        "id": "session-nested-messages",
        "prompt": "<<session:e1a4d7c9.json>>\n{\"messages\":[{\"role\":\"assistant\",\"content\":\"The",
        "expected": "assistant message continuation",
    },

    # ---- DOC PROBES (9 new; 10 total including doc-continuation above) ----
    {
        "id": "doc-readme",
        "prompt": "<<doc:packages/eight-bdh/README.md>>\n# 8gent 0.1 BDH\n\n",
        "expected": "readme prose",
    },
    {
        "id": "doc-spec-h2",
        "prompt": "<<doc:docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md>>\n## Section 3: Architecture\n\n",
        "expected": "spec content",
    },
    {
        "id": "doc-notices",
        "prompt": "<<doc:packages/eight-bdh/NOTICES.md>>\n# Third-Party Notices\n\n",
        "expected": "notice/license prose",
    },
    {
        "id": "doc-conventions-h3",
        "prompt": "<<doc:CONVENTIONS.md>>\n### Memory Layer\n\n",
        "expected": "conventions prose under h3",
    },
    {
        "id": "doc-brand-colors",
        "prompt": "<<doc:BRAND.md>>\n## Colors\n\n",
        "expected": "brand color definitions",
    },
    {
        "id": "doc-model-card-h2",
        "prompt": "<<doc:packages/eight-bdh/MODEL-CARD.md>>\n## Intended Use\n\n",
        "expected": "model card intended use section",
    },
    {
        "id": "doc-changelog",
        "prompt": "<<doc:CHANGELOG.md>>\n## [0.13.0] - 2026-04-30\n\n",
        "expected": "changelog entry bullet points",
    },
    {
        "id": "doc-table",
        "prompt": "<<doc:docs/MEMORY-SPEC.md>>\n| Field | Type | Description |\n|-------|------|-------------|\n",
        "expected": "markdown table row",
    },
    {
        "id": "doc-license",
        "prompt": "<<doc:LICENSE>>\nApache License\nVersion 2.0, January 2004\n\n",
        "expected": "Apache license continuation",
    },

    # ---- BLOG PROBES (9 new; 10 total including blog-prefix above) ----
    {
        "id": "blog-frontmatter-desc",
        "prompt": "<<blog:content/blog/why-local-first.mdx>>\n---\ntitle: \"Why Local-First\"\ndescription: \"",
        "expected": "description value",
    },
    {
        "id": "blog-body-start",
        "prompt": "<<blog:content/blog/dragon-hatched.mdx>>\n---\ntitle: \"The Dragon Hatched\"\n---\n\n",
        "expected": "blog body paragraph",
    },
    {
        "id": "blog-intro-para",
        "prompt": "<<blog:content/blog/eight-principles.mdx>>\n---\ntitle: \"Eight Principles\"\n---\n\nThe principles that guide",
        "expected": "principle list or prose",
    },
    {
        "id": "blog-published-date",
        "prompt": "<<blog:content/blog/bdh-phase-2-results.mdx>>\n---\ntitle: \"BDH Phase 2 Results\"\ndate: \"2026-04-",
        "expected": "date value continuation",
    },
    {
        "id": "blog-author-field",
        "prompt": "<<blog:content/blog/free-and-local.mdx>>\n---\ntitle: \"Free and Local\"\nauthor: \"",
        "expected": "author name continuation",
    },
    {
        "id": "blog-tags-field",
        "prompt": "<<blog:content/blog/on-sovereignty.mdx>>\n---\ntitle: \"On Sovereignty\"\ntags: [\"",
        "expected": "tag list continuation",
    },
    {
        "id": "blog-h2-section",
        "prompt": "<<blog:content/blog/the-eight-way.mdx>>\n---\ntitle: \"The Eight Way\"\n---\n\n## Why This Matters\n\n",
        "expected": "blog section prose",
    },
    {
        "id": "blog-closing-para",
        "prompt": "<<blog:content/blog/infinite-learning.mdx>>\n---\ntitle: \"Infinite Learning\"\n---\n\nWe did not set out to build",
        "expected": "reflective closing prose",
    },
    {
        "id": "blog-callout",
        "prompt": "<<blog:content/blog/open-sourcing-eight.mdx>>\n---\ntitle: \"Open Sourcing Eight\"\n---\n\n> The best way to predict",
        "expected": "blockquote continuation",
    },

    # ---- UNSEEN-TAG PROBES (4 new; 5 total including unseen-tag above) ----
    {
        "id": "unseen-code",
        "prompt": "<<code:packages/eight-bdh/index.ts>>\nimport {",
        "expected": "TypeScript import continuation",
    },
    {
        "id": "unseen-email",
        "prompt": "<<email:james@8gi.org>>\nSubject: ",
        "expected": "email subject line",
    },
    {
        "id": "unseen-audio",
        "prompt": "<<audio:docs/brief.m4a>>\n[Transcript]: ",
        "expected": "transcript-style text",
    },
    {
        "id": "unseen-tool",
        "prompt": "<<tool:packages/eight/tools.ts>>\nexport const",
        "expected": "TypeScript export",
    },

    # ---- CONTROL PROBES (3; null distribution baseline) ----
    {
        "id": "control-blank",
        "prompt": "",
        "expected": "null distribution",
    },
    {
        "id": "control-english",
        "prompt": "The 8gent system",
        "expected": "English continuation",
    },
    {
        "id": "control-number",
        "prompt": "42",
        "expected": "any continuation",
    },
]

# Category membership for grading
_SESSION_IDS = {
    "session-schema", "session-long-id", "session-with-cwd", "session-messages",
    "session-message-count", "session-no-last-active", "session-deep-cwd",
    "session-title-field", "session-created-epoch", "session-nested-messages",
}
_DOC_IDS = {
    "doc-continuation", "doc-readme", "doc-spec-h2", "doc-notices",
    "doc-conventions-h3", "doc-brand-colors", "doc-model-card-h2",
    "doc-changelog", "doc-table", "doc-license",
}
_BLOG_IDS = {
    "blog-prefix", "blog-frontmatter-desc", "blog-body-start", "blog-intro-para",
    "blog-published-date", "blog-author-field", "blog-tags-field",
    "blog-h2-section", "blog-closing-para", "blog-callout",
}
_UNSEEN_IDS = {
    "unseen-tag", "unseen-code", "unseen-email", "unseen-audio", "unseen-tool",
}
_CONTROL_IDS = {"control-blank", "control-english", "control-number"}


def grade_result(probe_id: str, completion: str) -> str | None:
    """Return a grade string ('pass'/'fail') or None for control probes."""
    if probe_id in _CONTROL_IDS:
        return None  # controls are reported raw, not graded
    if probe_id in _SESSION_IDS:
        return "pass" if any(c in completion for c in ["{", '"']) else "fail"
    if probe_id in _DOC_IDS:
        lines = completion.splitlines()
        has_md = (
            "#" in completion
            or "|" in completion
            or any(ln.strip() == "" for ln in lines)
        )
        return "pass" if has_md else "fail"
    if probe_id in _BLOG_IDS:
        return "pass" if ("---" in completion or len(completion.strip()) > 0) else "fail"
    if probe_id in _UNSEEN_IDS:
        # Any output (even noise) is a pass - just verifying no crash
        return "pass" if len(completion) > 0 else "fail"
    return None  # unrecognised probe - skip grading


def select_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = select_device()
print(f"[probe] device={DEVICE}", flush=True)


def load_checkpoint(path):
    if not path.exists():
        return None
    ckpt = torch.load(path, map_location=DEVICE, weights_only=False)
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
    return model, ckpt


def generate(model, prompt: str, n_tokens: int = 200, temperature: float = 0.7, top_k: int = 40) -> str:
    prompt_bytes = prompt.encode("utf-8")
    if not prompt_bytes:
        prompt_bytes = b"\n"
    idx = torch.tensor([list(prompt_bytes)], dtype=torch.long, device=DEVICE)
    with torch.no_grad():
        out_idx = model.generate(idx, max_new_tokens=n_tokens, temperature=temperature, top_k=top_k)
    new_bytes = out_idx[0, idx.shape[1]:].tolist()
    return bytes(new_bytes).decode("utf-8", errors="replace")


# Memorisation tracking phrases
MEMORISATION_PHRASES = [
    "frontier teacher",
    "Diversity is structural",
    "rule-based-phase-0",
    "Phase 0 heartbeat corpus",
]


def check_memorisation(text: str) -> list[str]:
    """Return list of Phase 0 corpus phrases that appear verbatim in text."""
    return [p for p in MEMORISATION_PHRASES if p in text]


# Run all probes on all checkpoints
results = []
checkpoint_meta = {}

for phase_name, path in CHECKPOINTS.items():
    print(f"\n[probe] === {phase_name}: {path.name} ===", flush=True)
    loaded = load_checkpoint(path)
    if loaded is None:
        print(f"[probe] checkpoint missing: {path}; skipping", flush=True)
        continue
    model, ckpt = loaded
    n_params = sum(p.numel() for p in model.parameters())
    training_meta = ckpt.get("training", {})
    checkpoint_meta[phase_name] = {
        "model_id": ckpt.get("model_id"),
        "params_M": round(n_params / 1e6, 2),
        "best_val_loss": training_meta.get("best_val_loss"),
        "corpus_bytes": training_meta.get("corpus_bytes"),
        "iters": training_meta.get("max_iters"),
        "wall_clock_min": round((training_meta.get("train_seconds") or 0) / 60, 1),
    }
    print(f"  params: {n_params/1e6:.2f}M, best val: {training_meta.get('best_val_loss')}", flush=True)

    for probe in PROBES:
        text = generate(model, probe["prompt"])
        memo = check_memorisation(text)
        grade = grade_result(probe["id"], text)
        results.append({
            "phase": phase_name,
            "probe_id": probe["id"],
            "prompt": probe["prompt"],
            "completion": text,
            "memorisation_hits": memo,
            "completion_first_120": text[:120],
            "grade": grade,
        })
        memo_flag = f" [MEMORISED: {memo}]" if memo else ""
        grade_flag = f" [{grade.upper()}]" if grade is not None else " [CONTROL]"
        print(f"  {probe['id']:28s}: {text[:80]!r}{memo_flag}{grade_flag}", flush=True)


# Summary stats
def mem_count(phase: str) -> int:
    return sum(len(r["memorisation_hits"]) for r in results if r["phase"] == phase)


def avg_completion_len(phase: str) -> float:
    rows = [r for r in results if r["phase"] == phase]
    if not rows:
        return 0
    return sum(len(r["completion"]) for r in rows) / len(rows)


def category_accuracy(phase: str, id_set: set) -> str:
    rows = [r for r in results if r["phase"] == phase and r["probe_id"] in id_set]
    if not rows:
        return "n/a"
    passes = sum(1 for r in rows if r.get("grade") == "pass")
    return f"{passes}/{len(rows)}"


print("\n[probe] === SUMMARY ===", flush=True)
for phase in CHECKPOINTS.keys():
    if phase not in checkpoint_meta:
        continue
    meta = checkpoint_meta[phase]
    val_loss = meta.get("best_val_loss")
    val_str = f"{val_loss:.4f}" if val_loss is not None else "n/a"
    print(
        f"  {phase:10s} {meta['params_M']:>5.2f}M  "
        f"corpus_bytes={str(meta['corpus_bytes']):>10}  "
        f"best_val={val_str}  "
        f"memorisation_hits={mem_count(phase)}",
        flush=True,
    )
    print(
        f"    per-category accuracy: "
        f"session={category_accuracy(phase, _SESSION_IDS)}  "
        f"doc={category_accuracy(phase, _DOC_IDS)}  "
        f"blog={category_accuracy(phase, _BLOG_IDS)}  "
        f"unseen={category_accuracy(phase, _UNSEEN_IDS)}",
        flush=True,
    )


with REPORT_PATH.open("w") as fh:
    json.dump({
        "checkpoint_meta": checkpoint_meta,
        "probes": [{"id": p["id"], "prompt": p["prompt"], "expected": p["expected"]} for p in PROBES],
        "results": results,
    }, fh, indent=2)
print(f"\n[probe] wrote {REPORT_PATH.relative_to(REPO_ROOT)}", flush=True)
