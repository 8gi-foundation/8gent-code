/**
 * Linux (and general) setup checks aligned with docs/TODO-LINUX.md §Models through §Optional polish.
 *
 * Run: bun run linux:check
 *      8gent linux-check [--full]
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const REPO_ROOT = join(import.meta.dirname, "..");

export interface LinuxCheckOptions {
  /** Run typecheck + lint (slower) */
  full?: boolean;
  /** Machine-readable JSON to stdout */
  json?: boolean;
  /** Skip model/provider rows (use after `harness doctor` in `8gent doctor`) */
  workspaceOnly?: boolean;
}

function sh(cmd: string): { ok: boolean; out: string } {
  const r = spawnSync("bash", ["-lc", cmd], { encoding: "utf8", maxBuffer: 2_000_000 });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

function commandExists(bin: string): boolean {
  return sh(`command -v '${bin.replace(/'/g, "'\\''")}' >/dev/null 2>&1`).ok;
}

function loadConfigText(dir: string): string | null {
  const p = join(dir, ".8gent", "config.json");
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function configSuggestsOpenRouter(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("openrouter")) return true;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const stack = [j];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      for (const [k, v] of Object.entries(o)) {
        const key = k.toLowerCase();
        if (
          (key.includes("openrouter") || key === "apikey" || key === "api_key") &&
          typeof v === "string" &&
          v.length > 8
        ) {
          return true;
        }
        if (v && typeof v === "object") stack.push(v as Record<string, unknown>);
      }
    }
  } catch {
    /* not JSON */
  }
  return false;
}

async function checkOllama(): Promise<{ pass: boolean; detail: string }> {
  try {
    const resp = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { pass: false, detail: `HTTP ${resp.status}` };
    const data = (await resp.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map(m => m.name);
    if (names.length === 0) return { pass: false, detail: "Running but no models (run: ollama pull <model>)" };
    return { pass: true, detail: `Models: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}` };
  } catch {
    return { pass: false, detail: "Not reachable at 127.0.0.1:11434" };
  }
}

export async function runLinuxSetupCheck(opts: LinuxCheckOptions = {}): Promise<number> {
  const rows: { id: string; pass: boolean; detail: string; optional: boolean }[] = [];

  if (!opts.workspaceOnly) {
    const ollama = await checkOllama();
    const homeCfg = loadConfigText(homedir());
    const cwdCfg = loadConfigText(process.cwd());
    const orEnv = !!process.env.OPENROUTER_API_KEY?.trim();
    const orFile =
      (homeCfg && configSuggestsOpenRouter(homeCfg)) || (cwdCfg && configSuggestsOpenRouter(cwdCfg));

    const modelReady = ollama.pass || orEnv || orFile;
    rows.push({
      id: "models.ollama",
      pass: ollama.pass,
      detail: ollama.detail,
      optional: true,
    });
    rows.push({
      id: "models.openrouter",
      pass: orEnv || orFile,
      detail: orEnv
        ? "OPENROUTER_API_KEY set"
        : orFile
          ? "config.json mentions OpenRouter or API key"
          : "No OPENROUTER_API_KEY / config hint",
      optional: true,
    });
    rows.push({
      id: "models.any",
      pass: modelReady,
      detail: modelReady ? "OK (Ollama and/or OpenRouter path)" : "Need: Ollama with ≥1 model, or OpenRouter key/config",
      optional: false,
    });

    rows.push({
      id: "manual.chat_turn",
      pass: true,
      detail: "Manual: ./start.sh then send one message in the TUI",
      optional: true,
    });
  }

  const atlas = join(REPO_ROOT, "apps/lil-eight/sprites/atlas.png");
  const runner = join(REPO_ROOT, "apps/lil-eight/run-terminal-pet.sh");
  const desktopBuilt = join(REPO_ROOT, "apps/lil-eight/build/linux/8gent-lil-eight-term.desktop");
  const desktopInstalled = join(homedir(), ".local/share/applications/8gent-lil-eight-term.desktop");

  rows.push({
    id: "pet.sprites",
    pass: existsSync(atlas),
    detail: existsSync(atlas) ? atlas : "Run: bun run pet:build:linux",
    optional: false,
  });
  rows.push({
    id: "pet.runner",
    pass: existsSync(runner) && sh(`test -x '${runner.replace(/'/g, "'\\''")}'`).ok,
    detail: runner,
    optional: false,
  });
  rows.push({
    id: "pet.desktop_built",
    pass: existsSync(desktopBuilt),
    detail: desktopBuilt,
    optional: true,
  });
  rows.push({
    id: "pet.desktop_menu",
    pass: existsSync(desktopInstalled),
    detail: existsSync(desktopInstalled)
      ? "Installed in ~/.local/share/applications"
      : "Optional: cp apps/lil-eight/build/linux/*.desktop ~/.local/share/applications/",
    optional: true,
  });

  const terms = ["gnome-terminal", "kitty", "konsole", "xfce4-terminal", "alacritty", "xterm"].filter(
    commandExists,
  );
  rows.push({
    id: "pet.terminals",
    pass: terms.length > 0,
    detail: terms.length ? `Found: ${terms.join(", ")}` : "Install one terminal for /pet start window",
    optional: true,
  });

  const espeak = commandExists("espeak-ng") || commandExists("espeak");
  const spd = commandExists("spd-say");
  rows.push({
    id: "polish.tts",
    pass: espeak || spd,
    detail: espeak || spd ? "TTS CLI present" : "Optional: sudo apt install espeak-ng (terminal pet voice)",
    optional: true,
  });

  const distShebang = join(REPO_ROOT, "dist/cli.js");
  let buildOk = true;
  if (existsSync(distShebang)) {
    const head = readFileSync(distShebang, "utf8").slice(0, 24);
    buildOk = head.startsWith("#!/");
  }
  rows.push({
    id: "polish.cli_shebang",
    pass: !existsSync(distShebang) || buildOk,
    detail: existsSync(distShebang)
      ? buildOk
        ? "dist/cli.js has shebang (bun run build)"
        : "Run bun run build to refresh dist/cli.js"
      : "dist/cli.js absent (only needed for global npm install)",
    optional: true,
  });

  if (opts.full) {
    const tc = sh(`cd '${REPO_ROOT.replace(/'/g, "'\\''")}' && bun run typecheck`);
    rows.push({
      id: "polish.typecheck",
      pass: tc.ok,
      detail: tc.ok ? "typecheck OK" : tc.out.slice(0, 400) || "typecheck failed",
      optional: true,
    });
    const lt = sh(`cd '${REPO_ROOT.replace(/'/g, "'\\''")}' && bun run lint`);
    rows.push({
      id: "polish.lint",
      pass: lt.ok,
      detail: lt.ok ? "lint OK" : lt.out.slice(0, 400) || "lint failed",
      optional: true,
    });
  }

  const requiredFail = rows.filter(r => !r.optional && !r.pass);
  const anyFail = rows.some(r => !r.pass && !r.optional);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: !anyFail,
          exitCode: anyFail ? 1 : 0,
          workspaceOnly: !!opts.workspaceOnly,
          checks: rows.map(({ id, pass, detail, optional }) => ({ id, pass, detail, optional })),
        },
        null,
        2,
      ),
    );
    return anyFail ? 1 : 0;
  }

  const banner = opts.workspaceOnly
    ? "\n  Linux workspace (pet, terminals, TTS, build — see TODO-LINUX.md)\n"
    : "\n  8gent Linux setup check (docs/TODO-LINUX.md)\n";
  console.log(banner);
  for (const r of rows) {
    const icon = r.pass ? "\x1b[32m✓\x1b[0m" : r.optional ? "\x1b[33m○\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const tag = r.optional ? " (optional)" : "";
    console.log(`  ${icon} ${r.id.padEnd(22)} ${r.detail}${tag}`);
  }
  console.log();
  if (!opts.full) {
    console.log(
      "  \x1b[2m--full adds typecheck + lint. linux-check --json for machines. 8gent doctor runs this after core checks.\x1b[0m\n",
    );
  }

  if (requiredFail.length) {
    console.log("  \x1b[31mRequired checks failed — see TODO-LINUX.md\x1b[0m\n");
    return 1;
  }
  console.log("  \x1b[32mRequired checks passed.\x1b[0m\n");
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const code = await runLinuxSetupCheck({
    full: args.includes("--full"),
    json: args.includes("--json"),
    workspaceOnly: args.includes("--workspace-only"),
  });
  process.exit(code);
}

if (import.meta.main) {
  main();
}
