"""
Heuristic baseline router.

This is the missing Phase 1 prerequisite per the boardroom decision (8TO,
Rishi): the spec section 9 gate "+10pp routing accuracy vs heuristic" is
unfalsifiable without a heuristic to measure against. The existing
packages/orchestration/task-dispatcher.ts is a task lifecycle state
machine, not a router.

This module is a deliberate stand-in: rule-based, deterministic, no ML.
It applies the kind of heuristics a thoughtful engineer would write if
they had a weekend. It is intended to be beaten by 8gent 0.1, not
admired.

Usage:
    from baseline_heuristic import HeuristicRouter
    router = HeuristicRouter()
    decision = router.decide(state)

API matches the BDH `decide()` shape so the eval harness can swap one
for the other transparently.
"""

from typing import Any
import re


# ── Trigger word lists ──────────────────────────────────────────────────

DESTRUCTIVE_TRIGGERS = {
    "deploy", "delete", "drop", "rm ", "rm -", "force push", "force-push",
    "main branch", "production", "rollback", "purge", "wipe", "uninstall",
    "downgrade",
}

CLARIFY_TRIGGERS = {
    "what about", "should i", "could you also", "tbh",
}

READ_ONLY_TRIGGERS = {
    "what files", "show me", "list ", "find ", "search ", "describe",
    "summarise", "summarize", "explain", "what does", "where is",
    "git log", "git status", "git diff", "last commit", "recent",
    "scan", "audit", "review", "compare ",
}

CODE_EDIT_TRIGGERS = {
    "rewrite", "refactor", "fix", "add a", "add the", "remove the",
    "extract", "rename", "move ", "split ", "merge ", "implement",
    "wire ", "wire up", "patch ", "update the", "change the",
}

TEST_TRIGGERS = {
    "test", "spec", "unit test", "integration test", "coverage",
}

DOC_TRIGGERS = {
    "doc", "readme", "changelog", "release notes", "documentation",
}

DEBUG_TRIGGERS = {
    "debug", "investigate", "why is", "why does", "stuck", "broken",
    "failing", "running hot", "slow", "leak", "regression",
}

PLAN_TRIGGERS = {
    "plan ", "roadmap", "strategy", "design", "architect",
}

# Vessel routing hints (which 8GI officer fits which task)
VESSEL_HINTS = {
    "8SO": {"auth", "security", "policy", "deny", "credential", "secret",
            "token", "compliance", "gdpr", "soc2", "iso", "encrypt"},
    "8TO": {"refactor", "architecture", "implement", "build", "wire ",
            "perf", "optimi", "benchmark", "infra"},
    "8DO": {"design", "ui", "ux", "darkmode", "settings panel", "accessibility",
            "brand", "theme", "layout"},
    "8PO": {"product", "user value", "jtbd", "priorit", "scope"},
    "8MO": {"changelog", "release notes", "blog", "narrative", "launch story"},
    "8CO": {"community", "contributor", "discord", "ecosystem", "partner"},
    "8GO": {"governance", "constitution", "policy.yaml", "audit", "boardroom"},
    "8EO": {"strategy", "mission", "vision", "roadmap", "decision"},
}

DEFAULT_BUDGETS = {
    "tool":     {"tokens": 500,   "ms": 5000},
    "model":    {"tokens": 4000,  "ms": 30000},
    "agent":    {"tokens": 12000, "ms": 90000},
    "reject":   {"tokens": 100,   "ms": 1000},
    "clarify":  {"tokens": 1000,  "ms": 10000},
}


def _matches_any(text: str, triggers) -> bool:
    return any(t in text for t in triggers)


class HeuristicRouter:
    """Deterministic, rule-based router. The baseline 8gent 0.1 needs to beat."""

    def decide(self, state: dict[str, Any]) -> dict[str, Any]:
        request = (state.get("request") or "").lower()
        context = state.get("context") or {}
        policy = state.get("policy") or {}

        deny_actions = set((policy.get("deny_actions") or []))
        authority_level = policy.get("authority_level", 0)
        budget = context.get("budget_remaining") or {}
        tokens_left = int(budget.get("tokens", 0))
        ms_left = int(budget.get("ms", 0))
        history = (context.get("history_summary") or "").lower()
        vessels_available = set(context.get("vessels_available") or [])
        tools_available = set(context.get("tools_available") or [])

        # ── 0. Budget exhaustion -> reject ─────────────────────────────
        if tokens_left <= 0 or ms_left <= 0:
            return self._reject("budget-exhausted", confidence=0.95)

        # ── 1. Destructive + low authority -> clarify ─────────────────
        if _matches_any(request, DESTRUCTIVE_TRIGGERS):
            if authority_level < 3:
                return self._clarify("destructive-low-authority", confidence=0.85)
            if "push_to_main" in deny_actions and ("push" in request or "merge" in request):
                return self._reject("deny-listed-action", confidence=0.95)
            return self._clarify("destructive-needs-confirm", confidence=0.78)

        # ── 2. Pure read query -> tool dispatch ───────────────────────
        if _matches_any(request, READ_ONLY_TRIGGERS):
            tool = self._pick_read_tool(request, tools_available)
            return self._tool(tool, confidence=0.88)

        # ── 3. Recent failure or loop -> escalate to specialist agent ─
        if "fail" in history or "loop" in history or "stuck" in history:
            vessel = self._pick_vessel(request, vessels_available, fallback="8TO")
            return self._agent(vessel, confidence=0.72)

        # ── 4. Code edit -> agent dispatch ────────────────────────────
        if _matches_any(request, CODE_EDIT_TRIGGERS):
            vessel = self._pick_vessel(request, vessels_available, fallback="8TO")
            return self._agent(vessel, confidence=0.74)

        # ── 5. Test work -> tool (Bash) for run, agent for write ─────
        if _matches_any(request, TEST_TRIGGERS):
            if "run" in request or "execute" in request:
                return self._tool("Bash", confidence=0.82)
            return self._agent("8TO", confidence=0.7)

        # ── 6. Docs / changelog -> model (no tool needed) ─────────────
        if _matches_any(request, DOC_TRIGGERS):
            return self._model("8gent/eight-1.0-q3:14b", confidence=0.74)

        # ── 7. Debugging -> agent (8TO) ───────────────────────────────
        if _matches_any(request, DEBUG_TRIGGERS):
            return self._agent("8TO", confidence=0.7)

        # ── 8. Planning -> model with longer budget ───────────────────
        if _matches_any(request, PLAN_TRIGGERS):
            return self._model("8gent/eight-1.0-q3:14b", confidence=0.7,
                               budget={"tokens": 8000, "ms": 60000})

        # ── 9. Catch-all -> short model call (local generalist) ────────
        return self._model("8gent/eight-1.0-q3:14b", confidence=0.6)

    # ── Decision builders ──────────────────────────────────────────────

    def _agent(self, target: str, confidence: float, budget: dict | None = None) -> dict:
        return {
            "kind": "agent",
            "target": target,
            "budget": budget or DEFAULT_BUDGETS["agent"],
            "confidence": round(confidence, 2),
        }

    def _tool(self, target: str, confidence: float, budget: dict | None = None) -> dict:
        return {
            "kind": "tool",
            "target": target,
            "budget": budget or DEFAULT_BUDGETS["tool"],
            "confidence": round(confidence, 2),
        }

    def _model(self, target: str, confidence: float, budget: dict | None = None) -> dict:
        return {
            "kind": "model",
            "target": target,
            "budget": budget or DEFAULT_BUDGETS["model"],
            "confidence": round(confidence, 2),
        }

    def _reject(self, target: str, confidence: float) -> dict:
        return {
            "kind": "reject",
            "target": target,
            "budget": DEFAULT_BUDGETS["reject"],
            "confidence": round(confidence, 2),
        }

    def _clarify(self, target: str, confidence: float) -> dict:
        return {
            "kind": "clarify",
            "target": target,
            "budget": DEFAULT_BUDGETS["clarify"],
            "confidence": round(confidence, 2),
        }

    # ── Helpers ────────────────────────────────────────────────────────

    def _pick_read_tool(self, request: str, available: set[str]) -> str:
        # Prefer Bash for git, Read for file inspection, Grep for search
        if any(g in request for g in ["git ", "commit", "branch", "log"]):
            return "Bash" if "Bash" in available else next(iter(available), "Bash")
        if any(g in request for g in ["search ", "find ", "grep "]):
            return "Grep" if "Grep" in available else next(iter(available), "Grep")
        if "read" in request or "show" in request:
            return "Read" if "Read" in available else next(iter(available), "Read")
        return next(iter(available), "Read")

    def _pick_vessel(self, request: str, available: set[str], fallback: str) -> str:
        # Score each vessel by how many of its hint terms appear
        best = fallback
        best_score = 0
        for code, hints in VESSEL_HINTS.items():
            score = sum(1 for h in hints if h in request)
            if score > best_score:
                best_score = score
                best = code
        # Respect availability if specified
        if available and best not in available:
            return fallback if fallback in available else next(iter(available), fallback)
        return best


if __name__ == "__main__":
    # Self-test against a few hand-crafted cases
    router = HeuristicRouter()
    cases = [
        {
            "request": "deploy to production",
            "context": {"budget_remaining": {"tokens": 4000, "ms": 30000}},
            "policy": {"authority_level": 2, "deny_actions": []},
        },
        {
            "request": "what files changed in the last commit",
            "context": {"budget_remaining": {"tokens": 4000, "ms": 30000},
                        "tools_available": ["Read", "Bash"]},
            "policy": {"authority_level": 1},
        },
        {
            "request": "rewrite this auth middleware to use the new policy engine",
            "context": {"budget_remaining": {"tokens": 12000, "ms": 90000},
                        "vessels_available": ["8TO", "8SO"]},
            "policy": {"authority_level": 3},
        },
        {
            "request": "summarise the project status",
            "context": {"budget_remaining": {"tokens": 4000, "ms": 30000}},
            "policy": {"authority_level": 1},
        },
    ]
    for s in cases:
        print(s["request"], "->", router.decide(s))
