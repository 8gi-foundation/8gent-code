/**
 * 8gent.games - HTTP API
 *
 * Minimal HTTP server for the simulation engine.
 * Deployable to Vercel (via Bun adapter) or standalone.
 *
 * Endpoints:
 *   GET  /             - Landing page (HTML)
 *   GET  /api/state    - Current simulation state (JSON)
 *   POST /api/tick     - Advance simulation by N ticks
 *   POST /api/reset    - Reset simulation
 *   GET  /api/agent/:id - Single agent details
 */

import { createSimulation, tickSimulation, type SimulationState } from './economy.ts';

let state: SimulationState = createSimulation();

const BRAND_ORANGE = '#E8610A';
const FONT_STACK = "'Inter', -apple-system, sans-serif";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function landingPage(): string {
  const agents = state.agents
    .map((a) => {
      const paperclips = a.inventory['paperclips'] ?? 0;
      const totalResources = Object.values(a.inventory).reduce((s, v) => s + v, 0);
      return `
        <div class="agent-card">
          <div class="agent-name">${a.name}</div>
          <div class="agent-meta">${a.district} - Lv${a.level} - ${a.strategy}</div>
          <div class="agent-stats">
            <span>${a.coins} coins</span>
            <span>${paperclips} paperclips</span>
            <span>${totalResources} resources</span>
          </div>
        </div>`;
    })
    .join('');

  const priceRows = Object.entries(state.prices)
    .map(([resource, price]) => {
      const history = state.priceHistory[resource as keyof typeof state.priceHistory];
      const trend = history && history.length >= 2
        ? history[history.length - 1] > history[history.length - 2]
          ? '<span style="color: #22c55e">^</span>'
          : '<span style="color: #ef4444">v</span>'
        : '';
      return `<tr><td>${resource}</td><td>${price} ${trend}</td></tr>`;
    })
    .join('');

  const recentEvents = state.events
    .slice(-8)
    .reverse()
    .map((e) => `<div class="event"><span class="event-tick">[${e.tick}]</span> ${e.description}</div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>8gent.games - Dublin Civilisation Simulator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${FONT_STACK};
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: clamp(16px, 4vw, 48px);
    }
    h1 {
      font-family: 'Fraunces', Georgia, serif;
      font-weight: 800;
      font-size: clamp(24px, 5vw, 40px);
      color: ${BRAND_ORANGE};
      margin-bottom: 4px;
    }
    .subtitle {
      color: #888;
      font-size: clamp(12px, 2.5vw, 16px);
      margin-bottom: clamp(24px, 4vw, 40px);
    }
    .tick-display {
      font-size: clamp(14px, 3vw, 18px);
      color: ${BRAND_ORANGE};
      margin-bottom: 24px;
    }
    .controls {
      display: flex;
      gap: 12px;
      margin-bottom: clamp(24px, 4vw, 40px);
      flex-wrap: wrap;
    }
    button {
      font-family: ${FONT_STACK};
      font-size: 14px;
      padding: 10px 20px;
      border: 1px solid #333;
      background: #1a1a1a;
      color: #e5e5e5;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }
    button:hover { border-color: ${BRAND_ORANGE}; color: ${BRAND_ORANGE}; }
    button.primary { background: ${BRAND_ORANGE}; border-color: ${BRAND_ORANGE}; color: #fff; }
    button.primary:hover { background: #c75408; }
    .section-title {
      font-size: clamp(14px, 3vw, 18px);
      font-weight: 600;
      margin-bottom: 12px;
      color: #ccc;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
      margin-bottom: clamp(24px, 4vw, 40px);
    }
    .agent-card {
      background: #141414;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 16px;
      transition: border-color 0.2s;
    }
    .agent-card:hover { border-color: ${BRAND_ORANGE}; }
    .agent-name { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
    .agent-meta { color: #888; font-size: 13px; margin-bottom: 8px; }
    .agent-stats { display: flex; gap: 12px; font-size: 13px; color: #aaa; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: clamp(24px, 4vw, 40px);
      font-size: 14px;
    }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1a1a1a; }
    th { color: #888; font-weight: 500; }
    .events {
      background: #0f0f0f;
      border: 1px solid #1a1a1a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: clamp(24px, 4vw, 40px);
      max-height: 300px;
      overflow-y: auto;
    }
    .event { font-size: 13px; padding: 4px 0; border-bottom: 1px solid #151515; }
    .event-tick { color: ${BRAND_ORANGE}; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
    .footer { color: #555; font-size: 12px; text-align: center; margin-top: 40px; }
    .footer a { color: ${BRAND_ORANGE}; text-decoration: none; }
    @media (max-width: 600px) {
      .grid { grid-template-columns: 1fr; }
      .agent-stats { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>8gent.games</h1>
    <div class="subtitle">Dublin Civilisation Simulator - Paperclip Economy</div>
    <div class="tick-display">Tick ${state.tick}</div>

    <div class="controls">
      <button class="primary" onclick="tick(1)">Tick +1</button>
      <button onclick="tick(10)">+10</button>
      <button onclick="tick(50)">+50</button>
      <button onclick="resetSim()">Reset</button>
    </div>

    <div class="section-title">Districts</div>
    <div class="grid">${agents}</div>

    <div class="section-title">Market Prices</div>
    <div style="overflow-x: auto;">
      <table>
        <tr><th>Resource</th><th>Price</th></tr>
        ${priceRows}
      </table>
    </div>

    <div class="section-title">Event Log</div>
    <div class="events">${recentEvents || '<div class="event" style="color:#555">No events yet. Run some ticks.</div>'}</div>

    <div class="footer">
      <a href="https://8gent.games">8gent.games</a> -
      Part of the <a href="https://8gentos.com">8gent OS</a> ecosystem
    </div>
  </div>
  <script>
    async function tick(n) {
      await fetch('/api/tick', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ticks: n}) });
      location.reload();
    }
    async function resetSim() {
      await fetch('/api/reset', { method: 'POST' });
      location.reload();
    }
  </script>
</body>
</html>`;
}

const server = Bun.serve({
  port: parseInt(process.env.PORT ?? '3000', 10),
  fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Routes
    if (url.pathname === '/' && req.method === 'GET') {
      return htmlResponse(landingPage());
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return jsonResponse({
        tick: state.tick,
        agents: state.agents.map((a) => ({
          id: a.id,
          name: a.name,
          district: a.district,
          level: a.level,
          coins: a.coins,
          inventory: a.inventory,
          strategy: a.strategy,
        })),
        prices: state.prices,
        marketOrders: state.market.length,
        recentEvents: state.events.slice(-20),
      });
    }

    if (url.pathname === '/api/tick' && req.method === 'POST') {
      return (async () => {
        const body = await req.json().catch(() => ({}));
        const ticks = Math.min((body as any).ticks ?? 1, 1000);
        for (let i = 0; i < ticks; i++) {
          tickSimulation(state);
        }
        return jsonResponse({ tick: state.tick, ticksAdvanced: ticks });
      })();
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      state = createSimulation();
      return jsonResponse({ tick: 0, status: 'reset' });
    }

    if (url.pathname.startsWith('/api/agent/') && req.method === 'GET') {
      const agentId = url.pathname.split('/').pop();
      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
      return jsonResponse(agent);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
});

console.log(`8gent.games server running on http://localhost:${server.port}`);
