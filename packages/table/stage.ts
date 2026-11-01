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
	/**
	 * The huddle's channel, when this page is talking to the real daemon.
	 *
	 * The daemon fans `huddle:slide` / `huddle:speak` out with
	 * broadcastToChannel(), which reaches only connections listed in
	 * `subscribedChannels` - and ONLY `message:subscribe` ever puts a connection
	 * there. `huddle:subscribe` returns a snapshot and nothing more, so a page
	 * that sent just that frame sat on "waiting for the first turn" for the whole
	 * huddle. Measured against the live daemon before this changed: a
	 * huddle:subscribe-only client received `huddle:state` and not one slide
	 * across three turns and 76 seconds.
	 *
	 * Asking through `message:subscribe` deliberately reuses the read
	 * authorization the store already enforces (it throws for a private channel
	 * the actor is not a member of), so this widens no trust surface - it goes
	 * through the front door that already has the guard on it.
	 *
	 * Optional because the replay harness (stage-replay.ts) pushes frames straight
	 * down its own socket and has no channels at all.
	 */
	channelId?: string;
}

/**
 * Build the stage page. Pure - same options in, same HTML out. The page is
 * self-contained: no external stylesheet, no CDN, no font download, nothing
 * that leaves the box.
 */
export function stagePage(opts: StagePageOptions): string {
	const cfg = JSON.stringify({
		huddleId: opts.huddleId,
		wsUrl: opts.wsUrl,
		settleMs: STAGE_SETTLE_MS,
		channelId: opts.channelId ?? "",
	});
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
  /* A slide is authored at a FIXED 1920x1080 with overflow:hidden (see
     slide-render.ts), because the bake screenshots it at exactly that size. A
     stage viewed at any OTHER size therefore showed the top-left crop of a huge
     canvas - which, since a slide's own padding is 112px/128px, is a rectangle of
     empty background. It only ever looked right at full HD.
     So the slot owns the enter/park animation and the frame owns the FIT: the
     iframe keeps its authored 1920x1080 geometry and is scaled to letterbox into
     whatever viewport it has. Two elements because both effects are transforms,
     and one property cannot hold both. */
  .slot{position:absolute;inset:0;overflow:hidden;
    transition:transform .42s cubic-bezier(.2,.7,.2,1),opacity .42s ease;
    transform:translateX(0);opacity:1}
  .slot.parked{transform:translateX(-8%) scale(.97);opacity:0}
  .frame{position:absolute;top:0;left:0;border:0;width:1920px;height:1080px;
    transform-origin:top left}
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
  /* The narration band. The slide carries the ARGUMENT; this carries what is
     actually being said, so the story is legible with the sound off and during
     the seconds before a slide exists. Sits above the HUD, never over it. */
  #said{position:absolute;left:0;right:0;bottom:52px;padding:14px 40px;
    background:linear-gradient(to top,rgba(9,10,12,.92),rgba(9,10,12,0));
    color:#EFEAE4;font-size:21px;line-height:1.45;text-align:center;
    opacity:0;transition:opacity .28s ease;pointer-events:none}
  #said.show{opacity:1}
</style>
</head>
<body>
  <div id="stage">
    <div id="idle"><h2>${topic || "8gent huddle"}</h2><div>waiting for the first turn</div></div>
    <div id="said"></div>
    <div id="hud"><span id="dot"></span><span id="who">-</span><span id="phase">idle</span><span id="topic">${topic}</span></div>
  </div>
  <audio id="voice"></audio>
<script>
(function(){
  "use strict";
  var CFG = ${cfg};
  var stage = document.getElementById("stage");
  var idle  = document.getElementById("idle");
  var said  = document.getElementById("said");
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
  // Letterbox one 1920x1080 slide into the current viewport. Pure geometry, and
  // it runs again on resize so the stage is correct in a 600pt app pane, a
  // full-screen browser, and a phone alike.
  var SLIDE_W = 1920, SLIDE_H = 1080;
  function fit(frame){
    var vw = stage.clientWidth, vh = stage.clientHeight;
    if (!vw || !vh) return;
    var s = Math.min(vw / SLIDE_W, vh / SLIDE_H);
    var x = (vw - SLIDE_W * s) / 2, y = (vh - SLIDE_H * s) / 2;
    frame.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")";
  }
  function fitAll(){
    var frames = stage.querySelectorAll(".frame");
    for (var i = 0; i < frames.length; i++) fit(frames[i]);
  }
  window.addEventListener("resize", fitAll);

  function showSlide(turnId, html, name){
    var slot = document.createElement("div");
    slot.className = "slot";
    var frame = document.createElement("iframe");
    frame.className = "frame";
    frame.setAttribute("sandbox", "");         // no scripts, no same-origin
    frame.setAttribute("aria-label", "slide by " + (name || "officer"));
    frame.srcdoc = html;
    slot.appendChild(frame);
    stage.insertBefore(slot, hudNode());
    fit(frame);
    idle.classList.add("hidden");

    var prev = live;
    live = slot;
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        if (prev){
          prev.classList.add("parked");
          prev.setAttribute("aria-hidden","true");
          // Parked slots stay in the DOM briefly so the transition can run,
          // then leave - an hour-long huddle must not accumulate 200 iframes.
          setTimeout(function(){ prev.remove(); }, 600);
        }
        // Fit again now that layout has actually settled. A host that sizes its web
        // view AFTER the first paint (an app pane laying out its window, a phone
        // rotating) would otherwise leave the first slide scaled to a viewport that
        // no longer exists.
        fitAll();
        setTimeout(function(){
          fitAll();
          send({ type:"huddle:stage_ready", huddleId: CFG.huddleId, turnId: turnId });
        }, CFG.settleMs);
      });
    });
  }

  function hudNode(){ return document.getElementById("hud"); }

  function speak(turnId, url){
    if (!url){ return; }             // quiet hours or no TTS: slide only
    audio.src = url;
    // NOTE: the stage does NOT yield when the audio ends, and must not.
    // huddle:yield is human-only and only valid for the holder of the turn; a
    // viewer watching an OFFICER speak holds nothing. Sending it anyway made the
    // FloorMachine broadcast HUDDLE_FORBIDDEN to the whole channel after every
    // single turn - which surfaced to James as a red
    // "human:local: cannot yield a turn you do not hold" for something he had not
    // done. The daemon's own speak timer already releases an agent turn, so there
    // was never anything for the stage to release.
    var p = audio.play();
    if (p && p.catch) p.catch(function(){ /* autoplay refused: the daemon's timer still releases */ });
  }

  function connect(){
    ws = new WebSocket(CFG.wsUrl);
    ws.onopen = function(){
      // The snapshot (who holds the floor right now, on a reconnect mid-huddle).
      send({ type:"huddle:subscribe", huddleId: CFG.huddleId });
      // The live frames. huddle:slide/huddle:speak are fanned out per CHANNEL, and
      // message:subscribe is the only frame that enrols this connection - without
      // it the stage receives the snapshot and then silence. seed:0 because a
      // stage renders slides, never the channel's message backlog.
      if (CFG.channelId) send({ type:"message:subscribe", channelId: CFG.channelId, seed: 0 });
    };
    ws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (!m || m.huddleId !== CFG.huddleId) return;
      switch(m.type){
        case "huddle:floor":
          setHud(m.name || m.holder, "preparing", false);
          // Name WHO is thinking rather than showing nothing. An officer's turn
          // takes several seconds before its slide exists, and James watched
          // that gap as a black rectangle with a name band underneath: "there's
          // not enough visuals going on... it's just a name coming up still".
          // Only while nothing has been presented yet - once a slide is up the
          // previous one stays parked, which is the designed behaviour and far
          // better than replacing it with a spinner.
          if (!live) {
            idle.classList.remove("hidden");
            idle.textContent = "";
            var h2 = document.createElement("h2");
            h2.textContent = String(m.name || m.holder || "");
            var sub = document.createElement("div");
            sub.textContent = "taking the floor";
            idle.appendChild(h2); idle.appendChild(sub);
          }
          break;
        case "huddle:slide":
          showSlide(m.turnId, m.html, m.name);
          setHud(m.name || m.holder, "on the floor", true);
          break;
        case "huddle:speak":
          // textContent, never innerHTML: this is model output on a page
          // that renders slides, and it is never markup.
          if (m.text) { said.textContent = m.text; said.classList.add("show"); }
          speak(m.turnId, m.audioUrl);
          break;
        case "huddle:floor_released":
          said.classList.remove("show");
          setHud(hud.who.textContent, "released", false);
          // Stopping the audio here USED to be unconditional, which turned any
          // early release into an audible cut mid-sentence - James watching a
          // live huddle: "the 8gents get cut off after only a few seconds". The
          // floor now holds the turn for the narration's MEASURED length, so a
          // normal release already lands after the last word; pausing on it only
          // ever truncates. A human CUT is the one case where silence is the
          // whole point, so that one still stops immediately. Any other case is
          // superseded naturally when the next turn sets audio.src.
          if (m.reason === "cut" || m.reason === "skipped") {
            try { audio.pause(); } catch(e){}
          }
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
