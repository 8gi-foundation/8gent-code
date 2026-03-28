# VHS Tape - 8gent Code Demo v0.2.0
# The Infinite Gentleman
#
# Install: brew install vhs
# Run: vhs demo.tape

Output demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1000
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set Padding 20

# ════════════════════════════════════════════════════════
# INTRO - The Infinite Gentleman
# ════════════════════════════════════════════════════════

Type "clear"
Enter
Sleep 500ms

Type "# ═══════════════════════════════════════════════════════"
Enter
Type "#  8gent Code - The Infinite Gentleman"
Enter
Type "#  Autonomous agentic coding. Never hit usage caps again."
Enter
Type "# ═══════════════════════════════════════════════════════"
Enter
Sleep 2s

# ════════════════════════════════════════════════════════
# SHOW THE AGENT IN ACTION
# ════════════════════════════════════════════════════════

Type "cd ~/8gent-code && 8gent"
Enter
Sleep 3s

# First interaction - show the ghost suggestion
Type "Create a"
Sleep 800ms
# Ghost suggestion appears
Sleep 1s

# Clear and show a real task
Ctrl+C
Sleep 500ms

Type "Build a React counter with TypeScript"
Enter
Sleep 8s

# Show it working
Sleep 3s

# Exit and show AST features
Type "/exit"
Enter
Sleep 1s

# ════════════════════════════════════════════════════════
# AST-FIRST EFFICIENCY (The Magic)
# ════════════════════════════════════════════════════════

Type ""
Enter
Type "# ─────────────────────────────────────────────────────────"
Enter
Type "# AST-First: 97% Token Savings"
Enter
Type "# ─────────────────────────────────────────────────────────"
Enter
Sleep 1s

Type "# Traditional: Read entire file (2,119 tokens)"
Enter
Type "wc -l packages/planner/index.ts"
Enter
Sleep 1s

Type ""
Enter
Type "# 8gent: Get just the symbols you need (61 tokens)"
Enter
Type "8gent outline packages/planner/index.ts 2>/dev/null | head -20"
Enter
Sleep 3s

Type ""
Enter
Type "# Get ONE specific function"
Enter
Type "8gent symbol packages/planner/index.ts::planTask 2>/dev/null | head -15"
Enter
Sleep 3s

# ════════════════════════════════════════════════════════
# BENCHMARK RESULTS
# ════════════════════════════════════════════════════════

Type ""
Enter
Type "# ─────────────────────────────────────────────────────────"
Enter
Type "# Benchmark: Your Savings"
Enter
Type "# ─────────────────────────────────────────────────────────"
Enter
Sleep 500ms

Type "bun run benchmark 2>/dev/null | tail -20"
Enter
Sleep 5s

# ════════════════════════════════════════════════════════
# FEATURES SUMMARY
# ════════════════════════════════════════════════════════

Type ""
Enter
Type "# ═══════════════════════════════════════════════════════"
Enter
Type "#  ✓ MCP Integration    ✓ Web Search      ✓ Multi-Agent"
Enter
Type "#  ✓ LSP Intelligence   ✓ PDF/Image       ✓ Permissions"
Enter
Type "#  ✓ BMAD Planning      ✓ Ghost Hints     ✓ Voice TTS"
Enter
Type "# ═══════════════════════════════════════════════════════"
Enter
Sleep 2s

Type ""
Enter
Type "# The Infinite Gentleman. Always at your service."
Enter
Type "# github.com/8gi-foundation/8gent-code"
Enter
Sleep 3s
