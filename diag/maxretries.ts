import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
const d = fs.mkdtempSync(path.join(os.tmpdir(), "mr-"));
const child = Bun.spawn(["ping", "-n", "3", "127.0.0.1"], { cwd: d, stdout: "ignore" });
const t0 = Date.now();
try { fs.rmSync(d, { recursive: true, force: true }); console.log("MR plain rm succeeded while child alive?!"); } catch (e: any) { console.log("MR plain rm", e.code); }
try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 }); console.log("MR maxRetries rm OK after", Date.now() - t0, "ms, exists=", fs.existsSync(d)); } catch (e: any) { console.log("MR maxRetries rm FAILED", e.code, Date.now() - t0); }
await child.exited;
