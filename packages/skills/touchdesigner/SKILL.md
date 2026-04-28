---
name: touchdesigner
description: Drive Derivative TouchDesigner from outside the editor for generative visuals, projection mapping, real-time AV. Use when the user mentions TouchDesigner, .toe files, TOPs/CHOPs/DATs/SOPs, OSC control of visuals, projection mapping, VJ rigs, particle systems, real-time audio-reactive scenes, or wants the agent to author/edit a .toe project. Skip for static design tools (Photoshop, Figma) or non-Derivative "touchdesigner-like" tools.
trigger: /touchdesigner
---

# TouchDesigner

Real-time node-based visual environment by Derivative. The agent drives it from outside the editor by sending OSC, TCP, or HTTP requests to running TD instances, and edits `.toe` projects via the `td` Python module when launched in headless / scripted mode.

## When to invoke

- User wants to build or modify a TouchDesigner scene (particles, audio-reactive visuals, projection mapping, MIDI-driven stage rigs).
- User mentions specific operator families: TOPs (textures), CHOPs (channels/audio), DATs (data/text), SOPs (geometry), MATs (materials), COMPs (containers).
- User wants to bridge TouchDesigner to another tool (Ableton, MaxMSP, MIDI controllers, VR headsets, OSC sources, web).
- User asks for a `.toe` file or to script `td` Python.

## Skip when

- User wants generic VFX or game-engine work (use Blender / Unreal skills).
- User wants 2D motion graphics in After Effects / Figma.

## Core surfaces

| What | Where it lives | Use when |
|---|---|---|
| **OSC In/Out CHOP** | A CHOP node inside the .toe project | External app sends OSC messages to drive params (most common bridge) |
| **TCP/IP DAT** | A DAT node | Bidirectional text protocol with another process |
| **Web Server DAT** | A DAT node | Expose TD as an HTTP server, control from a browser or curl |
| **Touch In DAT** | A DAT node | Receive Touch protocol messages from another TD instance |
| **`td` Python module** | Available inside TD's scripting | Author scenes programmatically when TD is running |
| **`tdu` utilities** | Inside TD | Convenience helpers — colour, math, file I/O |

## Default control bridge: OSC

OSC is the most reliable way for an outside agent to drive TouchDesigner. Setup the user's project once, then drive it from anywhere:

1. In the .toe project, drop an **OSC In CHOP**. Default port `7000`.
2. Map incoming addresses to scene parameters via either:
   - Channel routing in the OSC In CHOP (per-address channels)
   - A **CHOP Execute DAT** that reacts to changes
3. From outside (Python / Node / shell):

```python
# python-osc - https://pypi.org/project/python-osc/
from pythonosc import udp_client
client = udp_client.SimpleUDPClient("127.0.0.1", 7000)
client.send_message("/scene/intensity", 0.85)
client.send_message("/scene/color", [1.0, 0.4, 0.2])
```

```bash
# from a shell with `oscchief` (`brew install oscchief`):
oscchief send 127.0.0.1 7000 /scene/intensity f 0.85
```

## Web Server DAT — HTTP control

When the user wants curl-able control (no OSC client required):

1. Drop a **Web Server DAT**, set port `9980`, "Active" on.
2. In the DAT's `onHTTPRequest` callback (Python):

```python
def onHTTPRequest(webServerDAT, request, response):
    path = request['uri']
    if path == '/intensity':
        op('constant1').par.value0 = float(request['data'] or 0.5)
        response['statusCode'] = 200
        response['data'] = 'ok'
    return response
```

3. Drive from outside:

```bash
curl -X POST 127.0.0.1:9980/intensity -d "0.85"
```

## Programmatic editing — `td` module inside TD

If the agent has filesystem access to the project directory but TD must apply the change, write a `tdInit.py` startup script or a Text DAT that the user runs:

```python
# Example: build a particle system from scratch
proj = root  # the project root COMP
geo = proj.create(geoCOMP, 'particles_geo')
sop = geo.create(sphereSOP, 'src')
sop.par.rad = 0.05
particle_render = proj.create(renderTOP, 'render')
out = proj.create(outTOP, 'out')
particle_render.outputConnectors[0].connect(out.inputConnectors[0])
```

Run it via TD's textport (Alt+T) or set a Text DAT to "Run" with `Ctrl+Shift+R`.

## Project structure on disk

```
my-project/
  my-project.toe          # binary scene file
  td/                     # external Python modules (sys.path is auto-extended)
  media/                  # videos, images, audio
  shaders/                # GLSL .frag / .vert
```

When editing, prefer placing logic in **external `.py` files** under `td/` so the agent can edit them with `read_file` / `edit_file`. The .toe file references them via `tdu.Dependency` or `op('text1').module`.

## Patterns the agent should keep handy

### Audio-reactive scene
- **Audio Device In CHOP** -> **Audio Spectrum CHOP** -> **Math CHOP** (smooth) -> drive a **Constant TOP** colour or a **Geometry COMP** scale.

### Particle burst on MIDI note
- **MIDI In CHOP** -> **Trigger CHOP** -> **Particle SOP**'s `birth` channel via **CHOP to** reference.

### Projection mapping
- **NDI Out TOP** or **Window COMP** with **stretched aspect**, mapped onto a `Cam Schnappi` or a manual UV-mapped **Geometry COMP**.

### MIDI controller surface
- **MIDI In CHOP** + **Channel Mapping** for MIDI-CC -> parameter pairs. Save a `.tox` palette so it's reusable across projects.

## Anti-patterns

- **Don't auto-edit binary .toe files**. They are not human-readable. Always work through Python (`td` module) or external .py files.
- **Don't assume TD is running**. First check: `lsof -i :7000` (default OSC port) or `lsof -i :9980` (Web Server). If nothing is listening, ask the user to open the project before sending control messages.
- **Don't hardcode operator paths**. Use `op('name')` references with stable names so reorganising the project doesn't break the bridge.
- **Don't run heavy Python in the main TD thread**. Use a **Thread CHOP** or offload to an external process; TD targets 60fps and a slow callback drops frames.

## Quick verification recipe

When the user asks "is TD reachable from this script?":

1. `lsof -i :7000` — if nothing, ask user to start the project + add OSC In CHOP.
2. Send `oscchief send 127.0.0.1 7000 /ping i 1` — should appear in the OSC In CHOP's `ping` channel.
3. If no channel: confirm OSC In CHOP is "Active" and port matches.

## Reference

- TD Python docs: https://docs.derivative.ca/Category:Python
- OSC In CHOP: https://docs.derivative.ca/OSC_In_CHOP
- Web Server DAT: https://docs.derivative.ca/Web_Server_DAT
- `td` module API: https://docs.derivative.ca/Td_Module
