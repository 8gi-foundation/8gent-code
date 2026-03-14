/**
 * Translate raw agent events to human-friendly narrator text.
 */

export function narrateToolStart(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "run_command": {
      const cmd = String(args.command || "").split(" ")[0];
      if (cmd === "bun" && String(args.command).includes("test")) return "Running tests...";
      if (cmd === "git") return `Running git ${String(args.command).split(" ").slice(1, 3).join(" ")}...`;
      if (cmd === "npm" || cmd === "bun") return `Running ${String(args.command).slice(0, 40)}...`;
      return `Executing command...`;
    }
    case "read_file": {
      const filename = String(args.path || "").split("/").pop();
      return `Reading ${filename}...`;
    }
    case "write_file": {
      const writeName = String(args.path || "").split("/").pop();
      return `Writing ${writeName}...`;
    }
    case "edit_file": {
      const editName = String(args.path || "").split("/").pop();
      return `Editing ${editName}...`;
    }
    case "list_files":
      return "Exploring directory...";
    case "search_symbols":
    case "search_text":
      return `Searching for "${String(args.query || "").slice(0, 30)}"...`;
    case "web_search":
      return `Searching the web for "${String(args.query || "").slice(0, 30)}"...`;
    case "web_fetch":
      return "Fetching web page...";
    default:
      return `Using ${toolName}...`;
  }
}

export function narrateToolEnd(toolName: string, success: boolean, durationMs: number): string {
  const time = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  if (!success) return `Failed — trying another approach...`;

  switch (toolName) {
    case "run_command": return `Command completed (${time})`;
    case "write_file": return `File written (${time})`;
    case "read_file": return `File loaded (${time})`;
    default: return `Done (${time})`;
  }
}

export function narratePlan(planText: string): string {
  // Split on numbered step patterns: "1) ...", "2. ...", "- ..."
  // Handle both multi-line and single-line plans
  const steps = planText.split(/(?=\d+[.)]\s)/).filter(s => /^\d+[.)]/.test(s.trim()));
  if (steps.length > 0) {
    const cleaned = steps.map(s => s.replace(/^\d+[.)]\s*/, "").trim()).slice(0, 5);
    return `Planning: ${cleaned.join(" → ")}`;
  }
  return "Forming a plan...";
}

export function narrateStep(text: string): string {
  const stripped = text.replace(/```[\s\S]*?```/g, "").trim();
  const firstSentence = stripped.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0];
  return firstSentence?.trim().slice(0, 120) || "Thinking...";
}
