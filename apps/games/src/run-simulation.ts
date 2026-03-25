/**
 * 8gent.games - Simulation Runner
 *
 * Runs the economic simulation for N ticks and outputs a summary.
 * This is the CLI entry point for testing the simulation engine.
 *
 * Usage: bun run apps/games/src/run-simulation.ts [ticks]
 */

import { createSimulation, tickSimulation, type SimulationState, type Agent } from './economy.ts';

const TICKS = parseInt(process.argv[2] ?? '100', 10);

console.log(`\n  8gent.games - Dublin Civilisation Simulator`);
console.log(`  Running ${TICKS} tick simulation...\n`);

const state = createSimulation();

// Run simulation
for (let i = 0; i < TICKS; i++) {
  tickSimulation(state);
}

// --- Summary Output ---

console.log('='.repeat(60));
console.log(`  SIMULATION COMPLETE - ${state.tick} ticks`);
console.log('='.repeat(60));

// Agent summary
console.log('\n  DISTRICT STATUS\n');
console.log(
  '  ' +
    'District'.padEnd(20) +
    'Type'.padEnd(12) +
    'Lv'.padEnd(5) +
    'Coins'.padEnd(10) +
    'Paperclips'.padEnd(12) +
    'Strategy',
);
console.log('  ' + '-'.repeat(70));

for (const agent of state.agents) {
  const paperclips = agent.inventory['paperclips'] ?? 0;
  console.log(
    '  ' +
      agent.name.padEnd(20) +
      agent.district.padEnd(12) +
      String(agent.level).padEnd(5) +
      String(agent.coins).padEnd(10) +
      String(paperclips).padEnd(12) +
      agent.strategy,
  );
}

// Total economy
const totalCoins = state.agents.reduce((s, a) => s + a.coins, 0);
const totalPaperclips = state.agents.reduce((s, a) => s + (a.inventory['paperclips'] ?? 0), 0);
const totalMarketOrders = state.market.length;

console.log('\n  ECONOMY\n');
console.log(`  Total coins in circulation: ${totalCoins}`);
console.log(`  Total paperclips produced:  ${totalPaperclips}`);
console.log(`  Active market orders:       ${totalMarketOrders}`);
console.log(`  Total events logged:        ${state.events.length}`);

// Price snapshot
console.log('\n  CURRENT PRICES\n');
for (const [resource, price] of Object.entries(state.prices)) {
  const history = state.priceHistory[resource as keyof typeof state.priceHistory];
  const trend = history && history.length >= 2
    ? history[history.length - 1] > history[history.length - 2]
      ? ' ^'
      : ' v'
    : '';
  console.log(`  ${resource.padEnd(15)} ${price}${trend}`);
}

// Top inventory holders
console.log('\n  RESOURCE LEADERS\n');
const resources = ['compute', 'data', 'creativity', 'influence', 'goods', 'contracts', 'materials', 'energy'];
for (const res of resources) {
  const leader = state.agents.reduce((best, agent) =>
    (agent.inventory[res] ?? 0) > (best.inventory[res] ?? 0) ? agent : best,
  );
  const amount = leader.inventory[res] ?? 0;
  if (amount > 0) {
    console.log(`  ${res.padEnd(15)} ${leader.name} (${amount})`);
  }
}

// Recent emergence events
const emergenceEvents = state.events
  .filter((e) => e.type === 'emergence')
  .slice(-5);

if (emergenceEvents.length > 0) {
  console.log('\n  RECENT EVENTS\n');
  for (const event of emergenceEvents) {
    console.log(`  [tick ${event.tick}] ${event.description}`);
  }
}

// Trade activity
const tradeCount = state.events.filter((e) => e.type === 'trade').length;
const craftCount = state.events.filter((e) => e.type === 'craft').length;
const harvestCount = state.events.filter((e) => e.type === 'harvest').length;

console.log('\n  ACTIVITY BREAKDOWN\n');
console.log(`  Harvests:  ${harvestCount}`);
console.log(`  Crafts:    ${craftCount}`);
console.log(`  Trades:    ${tradeCount}`);

console.log('\n' + '='.repeat(60));
console.log('  8gent.games - Dublin is alive.\n');
