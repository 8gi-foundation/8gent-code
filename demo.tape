# VHS Tape - 8gent Code Demo
# Install: brew install vhs
# Run: vhs demo.tape

Output demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 800
Set Height 500
Set Theme "Catppuccin Mocha"

Type "# 8gent Code - Never hit usage caps again"
Enter
Sleep 1s

Type "cd ~/8gent-code"
Enter
Sleep 500ms

Type "# Get the outline of a TypeScript file"
Enter
Sleep 500ms

Type "bun run bin/8gent.ts outline packages/planner/index.ts"
Enter
Sleep 3s

Type "# Now get just one symbol - the Planner class"
Enter
Sleep 500ms

Type "bun run bin/8gent.ts symbol packages/planner/index.ts::Planner | head -30"
Enter
Sleep 3s

Type "# 97% less tokens than reading the whole file!"
Enter
Sleep 1s

Type "# Run the benchmark to see savings across your codebase"
Enter
Sleep 500ms

Type "bun run benchmark"
Enter
Sleep 5s

Type "# github.com/8gent/8gent-code"
Enter
Sleep 2s
