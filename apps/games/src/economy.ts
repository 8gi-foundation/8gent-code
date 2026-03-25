// 8gent.games - Economic Simulation Engine
// Concepts abstracted from Clawverse (MIT). Rebuilt for Bun/TypeScript.

export type DistrictType = 'tech' | 'culture' | 'trade' | 'industrial';

export type Resource =
  | 'compute'    // tech primary
  | 'data'       // tech primary
  | 'creativity' // culture primary
  | 'influence'  // culture primary
  | 'goods'      // trade primary
  | 'contracts'  // trade primary
  | 'materials'  // industrial primary
  | 'energy'     // industrial primary
  | 'paperclips'; // universal currency / win condition

export type CraftedGood =
  | 'software'      // compute + data
  | 'media'         // creativity + influence
  | 'infrastructure'// materials + energy
  | 'market_access' // goods + contracts
  | 'ai_model'      // compute + data + creativity (high tier)
  | 'paperclips';   // the ultimate output

export interface Recipe {
  name: string;
  inputs: Partial<Record<Resource, number>>;
  output: CraftedGood;
  outputAmount: number;
  ticksCost: number; // how many simulation ticks to craft
  minLevel: number;
}

export interface MarketOrder { id: string; sellerId: string; resource: Resource; amount: number; pricePerUnit: number; tick: number; }

export interface Agent {
  id: string;
  name: string;
  district: DistrictType;
  level: number;
  inventory: Record<string, number>;
  coins: number;
  gatheringSlots: GatheringSlot[];
  craftingQueue: CraftingJob[];
  strategy: AgentStrategy;
}

export interface GatheringSlot { resource: Resource; stage: 0|1|2|3; ticksRemaining: number; }
export interface CraftingJob { recipe: string; ticksRemaining: number; }
export type AgentStrategy = 'hoarder' | 'trader' | 'crafter' | 'balanced';

export interface SimulationState {
  tick: number;
  agents: Agent[];
  market: MarketOrder[];
  prices: Record<Resource, number>;
  priceHistory: Record<Resource, number[]>;
  events: SimEvent[];
}

export interface SimEvent { tick: number; type: 'trade'|'craft'|'harvest'|'price_shift'|'emergence'; agentId: string; description: string; }

const DISTRICT_YIELDS: Record<DistrictType, {
  primary: Resource[];
  secondary: Resource[];
  weak: Resource[];
}> = {
  tech: {
    primary: ['compute', 'data'],
    secondary: ['energy', 'materials'],
    weak: ['creativity', 'goods'],
  },
  culture: {
    primary: ['creativity', 'influence'],
    secondary: ['data', 'goods'],
    weak: ['compute', 'materials'],
  },
  trade: {
    primary: ['goods', 'contracts'],
    secondary: ['influence', 'creativity'],
    weak: ['energy', 'compute'],
  },
  industrial: {
    primary: ['materials', 'energy'],
    secondary: ['compute', 'contracts'],
    weak: ['creativity', 'influence'],
  },
};

const YIELD_MULTIPLIERS = { primary: 5, secondary: 1, weak: 0.2 };

const BASE_PRICES: Record<Resource, number> = {
  compute: 15,
  data: 12,
  creativity: 18,
  influence: 20,
  goods: 10,
  contracts: 25,
  materials: 8,
  energy: 10,
  paperclips: 100,
};

const GROWTH_TICKS: Record<Resource, number> = {
  compute: 3,
  data: 2,
  creativity: 4,
  influence: 5,
  goods: 2,
  contracts: 4,
  materials: 3,
  energy: 2,
  paperclips: 10,
};

export const RECIPES: Record<string, Recipe> = {
  software:       { name: 'Software',       inputs: { compute: 3, data: 2 },               output: 'software',       outputAmount: 1, ticksCost: 3, minLevel: 1 },
  media:          { name: 'Media Content',   inputs: { creativity: 2, influence: 1 },        output: 'media',          outputAmount: 1, ticksCost: 3, minLevel: 1 },
  infrastructure: { name: 'Infrastructure',  inputs: { materials: 4, energy: 3 },             output: 'infrastructure', outputAmount: 1, ticksCost: 4, minLevel: 1 },
  market_access:  { name: 'Market Access',   inputs: { goods: 3, contracts: 2 },              output: 'market_access',  outputAmount: 1, ticksCost: 3, minLevel: 2 },
  ai_model:       { name: 'AI Model',        inputs: { compute: 5, data: 4, creativity: 2 }, output: 'ai_model',       outputAmount: 1, ticksCost: 6, minLevel: 3 },
  paperclips:     { name: 'Paperclips',      inputs: { materials: 2, energy: 1 },             output: 'paperclips',     outputAmount: 3, ticksCost: 2, minLevel: 1 },
};

type PricePattern = 'increasing' | 'decreasing' | 'spike' | 'random';

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function getWeekPattern(resource: Resource, weekNumber: number): PricePattern {
  const seed = simpleHash(`${resource}-week-${weekNumber}`);
  const patterns: PricePattern[] = ['increasing', 'decreasing', 'spike', 'random'];
  return patterns[seed % 4];
}

function getDailyCoefficient(pattern: PricePattern, dayInWeek: number): number {
  switch (pattern) {
    case 'increasing':
      return 0.7 + (dayInWeek / 6) * 0.8; // 0.7 -> 1.5
    case 'decreasing':
      return 1.5 - (dayInWeek / 6) * 0.8; // 1.5 -> 0.7
    case 'spike':
      // Low all week, spike on day 5-6
      return dayInWeek >= 5 ? 1.3 + Math.random() * 0.2 : 0.7 + Math.random() * 0.1;
    case 'random':
      return 0.7 + simpleHash(`rand-${dayInWeek}`) % 80 / 100; // 0.7 - 1.5
  }
}

export function calculatePrices(tick: number): Record<Resource, number> {
  const weekNumber = Math.floor(tick / 7);
  const dayInWeek = tick % 7;
  const prices = {} as Record<Resource, number>;

  for (const [resource, basePrice] of Object.entries(BASE_PRICES)) {
    const pattern = getWeekPattern(resource as Resource, weekNumber);
    const coeff = getDailyCoefficient(pattern, dayInWeek);
    prices[resource as Resource] = Math.round(basePrice * coeff);
  }
  return prices;
}

function getYieldMultiplier(district: DistrictType, resource: Resource): number {
  const yields = DISTRICT_YIELDS[district];
  if (yields.primary.includes(resource)) return YIELD_MULTIPLIERS.primary;
  if (yields.secondary.includes(resource)) return YIELD_MULTIPLIERS.secondary;
  if (yields.weak.includes(resource)) return YIELD_MULTIPLIERS.weak;
  return 0;
}

function createGatheringSlots(district: DistrictType): GatheringSlot[] {
  const yields = DISTRICT_YIELDS[district];
  const slots: GatheringSlot[] = [];

  // Primary: 4 slots
  for (const r of yields.primary) {
    slots.push({ resource: r, stage: 0, ticksRemaining: 0 });
    slots.push({ resource: r, stage: 0, ticksRemaining: 0 });
  }
  // Secondary: 2 slots
  for (const r of yields.secondary) {
    slots.push({ resource: r, stage: 0, ticksRemaining: 0 });
  }

  return slots;
}

export function createAgent(
  id: string,
  name: string,
  district: DistrictType,
  strategy: AgentStrategy = 'balanced',
): Agent {
  return {
    id,
    name,
    district,
    level: 1,
    inventory: {},
    coins: 100,
    gatheringSlots: createGatheringSlots(district),
    craftingQueue: [],
    strategy,
  };
}

function getInventory(agent: Agent, resource: string): number {
  return agent.inventory[resource] ?? 0;
}

function addInventory(agent: Agent, resource: string, amount: number): void {
  agent.inventory[resource] = (agent.inventory[resource] ?? 0) + amount;
}

function removeInventory(agent: Agent, resource: string, amount: number): boolean {
  const current = agent.inventory[resource] ?? 0;
  if (current < amount) return false;
  agent.inventory[resource] = current - amount;
  return true;
}

function canAffordRecipe(agent: Agent, recipe: Recipe): boolean {
  for (const [res, amount] of Object.entries(recipe.inputs)) {
    if (getInventory(agent, res) < (amount ?? 0)) return false;
  }
  return agent.level >= recipe.minLevel;
}

function agentDecideGathering(agent: Agent): void {
  for (const slot of agent.gatheringSlots) {
    if (slot.stage === 0) {
      // Plant
      slot.stage = 1;
      slot.ticksRemaining = GROWTH_TICKS[slot.resource];
    }
  }
}

function agentDecideCrafting(agent: Agent, events: SimEvent[], tick: number): void {
  if (agent.craftingQueue.length >= 2) return; // Max 2 concurrent crafts

  // Strategy-based recipe selection
  const preferredRecipes: string[] = [];
  switch (agent.strategy) {
    case 'crafter':
      preferredRecipes.push('ai_model', 'software', 'media', 'infrastructure');
      break;
    case 'trader':
      preferredRecipes.push('paperclips', 'market_access');
      break;
    case 'hoarder':
      // Hoarders rarely craft
      if (tick % 5 !== 0) return;
      preferredRecipes.push('paperclips');
      break;
    case 'balanced':
      preferredRecipes.push('paperclips', 'software', 'media', 'infrastructure');
      break;
  }

  for (const recipeName of preferredRecipes) {
    const recipe = RECIPES[recipeName];
    if (recipe && canAffordRecipe(agent, recipe)) {
      // Deduct resources
      for (const [res, amount] of Object.entries(recipe.inputs)) {
        removeInventory(agent, res, amount ?? 0);
      }
      agent.craftingQueue.push({ recipe: recipeName, ticksRemaining: recipe.ticksCost });
      events.push({
        tick,
        type: 'craft',
        agentId: agent.id,
        description: `${agent.name} started crafting ${recipe.name}`,
      });
      return; // One craft decision per tick
    }
  }
}

function agentDecideTrading(
  agent: Agent,
  market: MarketOrder[],
  prices: Record<Resource, number>,
  events: SimEvent[],
  tick: number,
): void {
  const yields = DISTRICT_YIELDS[agent.district];

  // Sell surplus primary resources
  if (agent.strategy !== 'hoarder' || tick % 3 === 0) {
    for (const resource of yields.primary) {
      const amount = getInventory(agent, resource);
      if (amount > 10) {
        const sellAmount = Math.floor(amount * 0.4);
        const price = prices[resource] ?? 10;
        removeInventory(agent, resource, sellAmount);
        market.push({
          id: `${agent.id}-${tick}-${resource}`,
          sellerId: agent.id,
          resource,
          amount: sellAmount,
          pricePerUnit: price,
          tick,
        });
        events.push({
          tick,
          type: 'trade',
          agentId: agent.id,
          description: `${agent.name} listed ${sellAmount} ${resource} at ${price}/ea`,
        });
      }
    }
  }

  // Buy needed resources (weak ones for this district)
  for (const resource of yields.weak) {
    if (getInventory(agent, resource) < 5 && agent.coins > 50) {
      const order = market.find(
        (o) => o.resource === resource && o.sellerId !== agent.id && o.amount > 0,
      );
      if (order) {
        const buyAmount = Math.min(order.amount, 5);
        const totalCost = buyAmount * order.pricePerUnit;
        if (agent.coins >= totalCost) {
          agent.coins -= totalCost;
          addInventory(agent, resource, buyAmount);
          order.amount -= buyAmount;

          // Pay seller (minus 5% tax)
          // 5% tax, payment resolved in tick loop
          (order as any)._pendingPayment = (((order as any)._pendingPayment) ?? 0) + Math.floor(totalCost * 0.95);

          events.push({
            tick,
            type: 'trade',
            agentId: agent.id,
            description: `${agent.name} bought ${buyAmount} ${resource} for ${totalCost} coins`,
          });
        }
      }
    }
  }
}

export function tickSimulation(state: SimulationState): SimulationState {
  state.tick++;
  const events: SimEvent[] = [];

  // Update prices
  state.prices = calculatePrices(state.tick);

  // Track price history (keep last 14 ticks)
  for (const [resource, price] of Object.entries(state.prices)) {
    if (!state.priceHistory[resource as Resource]) {
      state.priceHistory[resource as Resource] = [];
    }
    const history = state.priceHistory[resource as Resource];
    history.push(price);
    if (history.length > 14) history.shift();
  }

  for (const agent of state.agents) {
    // 1. Progress gathering slots
    for (const slot of agent.gatheringSlots) {
      if (slot.stage > 0 && slot.stage < 3) {
        slot.ticksRemaining--;
        if (slot.ticksRemaining <= 0) {
          slot.stage = (slot.stage + 1) as 1 | 2 | 3;
          if (slot.stage < 3) {
            slot.ticksRemaining = Math.ceil(GROWTH_TICKS[slot.resource] / 2);
          }
        }
      }
      // Auto-harvest at stage 3
      if (slot.stage === 3) {
        const mult = getYieldMultiplier(agent.district, slot.resource);
        const harvested = Math.max(1, Math.round(mult));
        addInventory(agent, slot.resource, harvested);
        events.push({
          tick: state.tick,
          type: 'harvest',
          agentId: agent.id,
          description: `${agent.name} harvested ${harvested} ${slot.resource}`,
        });
        slot.stage = 0;
        slot.ticksRemaining = 0;
      }
    }

    // 2. Progress crafting queue
    for (let i = agent.craftingQueue.length - 1; i >= 0; i--) {
      const job = agent.craftingQueue[i];
      job.ticksRemaining--;
      if (job.ticksRemaining <= 0) {
        const recipe = RECIPES[job.recipe];
        if (recipe) {
          addInventory(agent, recipe.output, recipe.outputAmount);
          events.push({
            tick: state.tick,
            type: 'craft',
            agentId: agent.id,
            description: `${agent.name} crafted ${recipe.outputAmount} ${recipe.name}`,
          });
        }
        agent.craftingQueue.splice(i, 1);
      }
    }

    // 3. Agent decisions
    agentDecideGathering(agent);
    agentDecideCrafting(agent, events, state.tick);
    agentDecideTrading(agent, state.market, state.prices, events, state.tick);

    // 4. Level up check (every 20 paperclips = 1 level, max 5)
    const paperclips = getInventory(agent, 'paperclips');
    const newLevel = Math.min(5, 1 + Math.floor(paperclips / 20));
    if (newLevel > agent.level) {
      agent.level = newLevel;
      events.push({
        tick: state.tick,
        type: 'emergence',
        agentId: agent.id,
        description: `${agent.name} reached level ${newLevel}!`,
      });
    }
  }

  // Resolve pending seller payments
  for (const order of state.market) {
    const pending = (order as any)._pendingPayment;
    if (pending > 0) {
      const seller = state.agents.find((a) => a.id === order.sellerId);
      if (seller) {
        seller.coins += pending;
      }
      delete (order as any)._pendingPayment;
    }
  }

  // Clean up filled orders
  state.market = state.market.filter((o) => o.amount > 0);

  // Random emergence events (every 10 ticks)
  if (state.tick % 10 === 0) {
    const eventTypes = [
      'Data breach - all tech districts lose 20% data',
      'Cultural renaissance - culture districts get bonus creativity',
      'Trade embargo - market orders cleared',
      'Energy surplus - industrial districts double output next tick',
      'Paperclip shortage - price doubles',
    ];
    const eventIdx = simpleHash(`emergence-${state.tick}`) % eventTypes.length;
    events.push({
      tick: state.tick,
      type: 'emergence',
      agentId: 'system',
      description: eventTypes[eventIdx],
    });
  }

  state.events.push(...events);

  return state;
}

export function createSimulation(): SimulationState {
  const districts: DistrictType[] = ['tech', 'culture', 'trade', 'industrial'];
  const strategies: AgentStrategy[] = ['crafter', 'trader', 'hoarder', 'balanced'];
  const dublinDistricts = [
    { name: 'Silicon Docks', district: 'tech' as DistrictType, strategy: 'crafter' as AgentStrategy },
    { name: 'Temple Bar', district: 'culture' as DistrictType, strategy: 'balanced' as AgentStrategy },
    { name: 'IFSC', district: 'trade' as DistrictType, strategy: 'trader' as AgentStrategy },
    { name: 'Docklands', district: 'industrial' as DistrictType, strategy: 'hoarder' as AgentStrategy },
    { name: 'Smithfield', district: 'tech' as DistrictType, strategy: 'balanced' as AgentStrategy },
    { name: 'Grafton Quarter', district: 'culture' as DistrictType, strategy: 'trader' as AgentStrategy },
    { name: 'Liberties', district: 'industrial' as DistrictType, strategy: 'crafter' as AgentStrategy },
    { name: 'North Wall', district: 'trade' as DistrictType, strategy: 'balanced' as AgentStrategy },
  ];

  const agents = dublinDistricts.map((d, i) =>
    createAgent(`agent-${i}`, d.name, d.district, d.strategy),
  );

  return {
    tick: 0,
    agents,
    market: [],
    prices: calculatePrices(0),
    priceHistory: {} as Record<Resource, number[]>,
    events: [],
  };
}
