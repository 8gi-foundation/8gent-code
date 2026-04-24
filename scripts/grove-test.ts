const peerUrl = process.argv[2] || "wss://grove-peer-a.fly.dev";
const prompt = process.argv[3] || "What is 2 + 2? Reply in one short sentence.";
console.log(`[grove-test] target=${peerUrl}`);
console.log(`[grove-test] prompt=${prompt}`);
const ws = new WebSocket(peerUrl);
const start = Date.now();
let firstTokenAt: number | null = null;
let collected = "";
const timeout = setTimeout(() => { console.error(`[grove-test] timeout 90s`); ws.close(); process.exit(1); }, 90_000);
ws.onopen = () => {
  console.log(`[grove-test] connected in ${Date.now() - start}ms — creating session`);
  ws.send(JSON.stringify({ type: "session:create", channel: "api" }));
};
ws.onmessage = (event) => {
  let msg: any;
  try { msg = JSON.parse(String(event.data)); } catch { return; }
  if (msg.type === "session:created") {
    console.log(`[grove-test] session=${msg.sessionId} — sending prompt`);
    ws.send(JSON.stringify({ type: "prompt", text: prompt }));
    return;
  }
  if (msg.type === "event") {
    if (msg.event === "agent:stream") {
      const chunk = msg.payload?.chunk as string | undefined;
      if (chunk) {
        if (firstTokenAt === null) { firstTokenAt = Date.now(); console.log(`\n[grove-test] first token at ${firstTokenAt - start}ms`); }
        collected += chunk;
        process.stdout.write(chunk);
      }
      return;
    }
    if (msg.event === "session:end") {
      const total = Date.now() - start;
      const ttft = firstTokenAt ? firstTokenAt - start : null;
      console.log(`\n[grove-test] DONE — total=${total}ms ttft=${ttft}ms collected=${collected.length} chars`);
      clearTimeout(timeout); ws.close(); process.exit(collected.length > 0 ? 0 : 1);
    }
    if (msg.event === "agent:error") {
      console.error(`\n[grove-test] agent error:`, JSON.stringify(msg.payload));
      clearTimeout(timeout); ws.close(); process.exit(1);
    }
  }
  if (msg.type === "error") { console.error(`[grove-test] gateway error: ${msg.message}`); }
};
ws.onerror = (err: any) => { console.error(`[grove-test] ws error:`, err?.message || err); };
ws.onclose = () => { clearTimeout(timeout); if (collected.length === 0) { console.error(`[grove-test] closed without tokens`); process.exit(1); } };
