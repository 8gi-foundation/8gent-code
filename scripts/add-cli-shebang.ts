/**
 * Prepend Bun shebang to dist/cli.js (portable: no BSD vs GNU sed).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const out = resolve(import.meta.dirname, "../dist/cli.js");

if (!existsSync(out)) {
  console.error(`add-cli-shebang: ${out} not found (run bun build step first)`);
  process.exit(1);
}

let body = readFileSync(out, "utf8");
if (!body.startsWith("#!/")) {
  body = "#!/usr/bin/env bun\n" + body;
  writeFileSync(out, body);
}
