/**
 * 8gent Huddle Phase 1 - the STAGE (spec sections 5.1 and 8).
 *
 * One page, loaded once, never navigating again. Slides are appended into the
 * live DOM as `huddle:slide` frames arrive; the previous slide is PARKED (kept
 * in the DOM, translated off-stage, aria-hidden) so the surface grows rather
 * than resetting. One window, one audio element, one uninterrupted session, one
 * clock.
 *
 * The visual is driven by the FloorMachine that already exists. There is no
 * second timeline: whoever holds the floor is on screen, and the slide advances
 * when the floor moves. The stage has no opinion about turn order at all.
 *
 * THE SYNC GATE (spec 5.1, steps 6-7): on receiving `huddle:slide` the stage
 * composites the slide, waits two animation frames plus a settle, and only then
 * sends `huddle:stage_ready { turnId }`. The daemon does not send
 * `huddle:speak` until it has that ack for that exact turnId, so voice can
 * never start before its slide is on screen. If no stage is connected the
 * daemon proceeds anyway after STAGE_READY_CAP_MS, so a headless huddle still
 * bakes a correct artifact.
 *
 * SECURITY: slide HTML arrives already escaped and already rendered by the pure
 * compiled-in renderer, and is mounted in a sandboxed iframe with a srcdoc, so
 * the stage's own script context is never shared with slide content.
 */

export const STAGE_SETTLE_MS = 250;
/** How long the daemon waits for stage_ready before proceeding headless. */
export const STAGE_READY_CAP_MS = 3_000;

export interface StagePageOptions {
	huddleId: string;
	/** WebSocket URL of the daemon, e.g. "ws://127.0.0.1:18789". */
	wsUrl: string;
	topic: string;
}

/**
 * Build the stage page. Pure - same options in, same HTML out. The page is
 * self-contained: no external stylesheet, no CDN, no font download, nothing
 * that leaves the box.
 */
export function stagePage(opts: StagePageOptions): string {
	const cfg = JSON.stringify({ huddleId: opts.huddleId, wsUrl: opts.wsUrl, settleMs: STAGE_SETTLE_MS });
	const topic = opts.topic.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>8gent huddle stage</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;overflow:hidden;background:#0A0908;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;
    color:#FAF7F4}
  #stage{position:relative;width:100%;height:100%}
  .frame{position:absolute;inset:0;border:0;width:100%;height:100%;
    transition:transform .42s cubic-bezier(.2,.7,.2,1),opacity .42s ease;
    transform:translateX(0);opacity:1}
  .frame.parked{transform:translateX(-8%) scale(.97);opacity:0}
  #hud{position:absolute;left:0;right:0;bottom:0;height:76px;display:flex;align-items:center;
    gap:20px;padding:0 32px;background:linear-gradient(0deg,rgba(10,9,8,.94),rgba(10,9,8,0));
    font-size:17px;letter-spacing:.02em;pointer-events:none}
  #who{font-weight:600}
  #phase{color:#8A8078;text-transform:uppercase;letter-spacing:.16em;font-size:13px}
  #dot{width:11px;height:11px;border-radius:50%;background:#8A8078;flex:none}
  #dot.live{background:#F07A28;box-shadow:0 0 0 0 rgba(240,122,40,.6);animation:pulse 1.8s infinite}
  @keyframes pulse{70%{box-shadow:0 0 0 14px rgba(240,122,40,0)}100%{box-shadow:0 0 0 0 rgba(240,122,40,0)}}
  #topic{margin-left:auto;color:#C8C2BA}
  #idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:18px;color:#8A8078}
  #idle h2{font-size:34px;color:#FAF7F4;font-weight:600}
  #idle.hidden{display:none}
</style>
</head>
<body>
  <div id="stage">
    <div id="idle"><h2>${topic || "8gent huddle"}</h2><div>waiting for the first turn</div></div>
    <div id="hud"><span id="dot"></span><span id="who">-</span><span id="phase">idle</span><span id="topic">${topic}</span></div>
  </div>
  <audio id="voice"></audio>
<script>
(function(){
  "use strict";
  var CFG = ${cfg};
  var stage = document.getElementById("stage");
  var idle  = document.getElementById("idle");
  var hud   = { who: document.getElementById("who"), phase: document.getElementById("phase"), dot: document.getElementById("dot") };
  var audio = document.getElementById("voice");
  var live  = null;   // the currently mounted frame
  var ws;

  function send(obj){ try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch(e){} }

  function setHud(name, phase, isLive){
    hud.who.textContent = name || "-";
    hud.phase.textContent = phase || "";
    hud.dot.className = isLive ? "live" : "";
  }

  // Mount a slide, park the previous one, then ACK. The two rAFs plus the
  // settle are the gate: we only tell the daemon we are ready once the browser
  // has actually composited the new frame.
  function showSlide(turnId, html, name){
    var frame = document.createElement("iframe");
    frame.className = "frame";
    frame.setAttribute("sandbox", "");         // no scripts, no same-origin
    frame.setAttribute("aria-label", "slide by " + (name || "officer"));
    frame.srcdoc = html;
    stage.insertBefore(frame, hudNode());
    idle.classList.add("hidden");

    var prev = live;
    live = frame;
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        if (prev){
          prev.classList.add("parked");
          prev.setAttribute("aria-hidden","true");
          // Parked frames stay in the DOM briefly so the transition can run,
          // then leave - an hour-long huddle must not accumulate 200 iframes.
          setTimeout(function(){ prev.remove(); }, 600);
        }
        setTimeout(function(){ send({ type:"huddle:stage_ready", huddleId: CFG.huddleId, turnId: turnId }); }, CFG.settleMs);
      });
    });
  }

  function hudNode(){ return document.getElementById("hud"); }

  function speak(turnId, url){
    if (!url){ return; }             // quiet hours or no TTS: slide only
    audio.src = url;
    audio.onended = function(){ send({ type:"huddle:yield", huddleId: CFG.huddleId, turnId: turnId }); };
    var p = audio.play();
    if (p && p.catch) p.catch(function(){ /* autoplay refused: the daemon's timer still releases */ });
  }

  function connect(){
    ws = new WebSocket(CFG.wsUrl);
    ws.onopen = function(){ send({ type:"huddle:subscribe", huddleId: CFG.huddleId }); };
    ws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (!m || m.huddleId !== CFG.huddleId) return;
      switch(m.type){
        case "huddle:floor":
          setHud(m.name || m.holder, "preparing", false);
          break;
        case "huddle:slide":
          showSlide(m.turnId, m.html, m.name);
          setHud(m.name || m.holder, "on the floor", true);
          break;
        case "huddle:speak":
          speak(m.turnId, m.audioUrl);
          break;
        case "huddle:floor_released":
          setHud(hud.who.textContent, "released", false);
          try { audio.pause(); } catch(e){}
          break;
        case "huddle:closed":
          setHud("", "closed", false);
          idle.classList.remove("hidden");
          idle.innerHTML = "<h2>Huddle closed</h2><div>baking the artifact</div>";
          break;
      }
    };
    // Floor state lives only in the daemon, so reconnecting is always safe:
    // huddle:subscribe returns the full snapshot.
    ws.onclose = function(){ setTimeout(connect, 1200); };
  }
  connect();
})();
</script>
</body>
</html>
`;
}
