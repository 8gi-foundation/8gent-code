/**
 * TradingAgents Chinese Enhanced Edition - Core module for multi-agent financial trading
 * @module TradingAgents
 */

/**
 * Represents a trading agent with specific role and behavior
 */
interface Agent {
  /**
   * Process market data and execute actions
   * @param data Market data input
   * @returns Action result
   */
  process(data: MarketData): ActionResult;
}

/**
 * Market data interface
 */
interface MarketData {
  symbol: string;
  price: number;
  volume: number;
  timestamp: Date;
}

/**
 * Action result from agent processing
 */
interface ActionResult {
  action: 'buy' | 'sell' | 'hold';
  quantity: number;
  confidence: number;
}

/**
 * Market simulation class
 */
class Market {
  private prices: Map<string, number> = new Map();

  /**
   * Update market price for a symbol
   * @param symbol Trading symbol
   * @param price New price
   */
  updatePrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  /**
   * Get current price for a symbol
   * @param symbol Trading symbol
   * @returns Current price
   */
  getPrice(symbol: string): number {
    return this.prices.get(symbol) || 0;
  }
}

/**
 * Analyst agent implementation
 */
class Analyst implements Agent {
  process(data: MarketData): ActionResult {
    // Simple moving average analysis
    const trend = data.price > 100 ? 'bullish' : 'bearish';
    return {
      action: trend === 'bullish' ? 'buy' : 'sell',
      quantity: 100,
      confidence: Math.abs(data.price - 100) / 50
    };
  }
}

/**
 * Trader agent implementation
 */
class Trader implements Agent {
  process(data: MarketData): ActionResult {
    // Execute trades based on signals
    return {
      action: 'hold',
      quantity: 0,
      confidence: 0.5
    };
  }
}

/**
 * Risk manager agent implementation
 */
class RiskManager implements Agent {
  process(data: MarketData): ActionResult {
    // Simple stop-loss logic
    if (data.price < 90) {
      return { action: 'sell', quantity: 50, confidence: 0.8 };
    }
    return { action: 'hold', quantity: 0, confidence: 0.5 };
  }
}

/**
 * Main trading agents framework
 */
export class TradingAgents {
  private agents: Agent[] = [];
  private market: Market = new Market();

  /**
   * Add an agent to the system
   * @param agent Agent instance
   */
  addAgent(agent: Agent): void {
    this.agents.push(agent);
  }

  /**
   * Execute trading logic for a symbol
   * @param symbol Trading symbol
   * @returns Aggregate action result
   */
  executeTrade(symbol: string): ActionResult {
    const price = this.market.getPrice(symbol);
    const data: MarketData = { symbol, price, volume: 0, timestamp: new Date() };
    
    let result: ActionResult = { action: 'hold', quantity: 0, confidence: 0 };
    
    for (const agent of this.agents) {
      const action = agent.process(data);
      result.confidence += action.confidence / this.agents.length;
      
      if (action.confidence > result.confidence) {
        result = action;
      }
    }
    
    return result;
  }

  /**
   * Update market price
   * @param symbol Trading symbol
   * @param price New price
   */
  updateMarketPrice(symbol: string, price: number): void {
    this.market.updatePrice(symbol, price);
  }
}

/**
 * Create and configure a new trading agents system
 * @returns Configured TradingAgents instance
 */
export function createTradingSystem(): TradingAgents {
  const system = new TradingAgents();
  system.addAgent(new Analyst());
  system.addAgent(new Trader());
  system.addAgent(new RiskManager());
  return system;
}