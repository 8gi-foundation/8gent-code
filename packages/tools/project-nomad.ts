/**
 * Project N.O.M.A.D - Self-contained survival utility module
 * Provides critical tools, knowledge base, and AI assistance
 */
export class KnowledgeBase {
  private data: Map<string, string> = new Map();

  /**
   * Add survival knowledge to the database
   * @param topic Knowledge category (e.g. 'firstAid', 'foraging')
   * @param content Information string
   */
  addKnowledge(topic: string, content: string): void {
    this.data.set(topic, content);
  }

  /**
   * Retrieve survival knowledge
   * @param topic Knowledge category to query
   * @returns Stored information or empty string if not found
   */
  getKnowledge(topic: string): string {
    return this.data.get(topic) || '';
  }
}

/**
 * Resource management system for survival scenarios
 */
export class ResourceManager {
  private resources: Map<string, number> = new Map();

  /**
   * Track resource quantities
   * @param type Resource type (e.g. 'water', 'food')
   * @param amount Quantity available
   */
  trackResource(type: string, amount: number): void {
    this.resources.set(type, amount);
  }

  /**
   * Check current resource status
   * @param type Resource type to query
   * @returns Current quantity or 0 if not tracked
   */
  checkResource(type: string): number {
    return this.resources.get(type) || 0;
  }
}

/**
 * AI assistant for survival decision making
 */
export class AIAssistant {
  private knowledge: KnowledgeBase;
  private resources: ResourceManager;

  /**
   * Initialize AI assistant with knowledge and resource systems
   * @param knowledge Knowledge base instance
   * @param resources Resource manager instance
   */
  constructor(knowledge: KnowledgeBase, resources: ResourceManager) {
    this.knowledge = knowledge;
    this.resources = resources;
  }

  /**
   * Generate survival advice based on current situation
   * @param scenario Description of current survival challenge
   * @returns AI-generated survival strategy
   */
  generateStrategy(scenario: string): string {
    const water = this.resources.checkResource('water');
    const food = this.resources.checkResource('food');
    
    if (water < 1000 || food < 500) {
      return 'Prioritize finding water and food sources immediately.';
    }
    
    if (scenario.includes('injury')) {
      return this.knowledge.getKnowledge('firstAid');
    }
    
    return 'Maintain current resource levels and explore surroundings for new supplies.';
  }
}

/**
 * Initialize N.O.M.A.D system
 * @returns Tuple containing knowledge base, resource manager, and AI assistant
 */
export function initNO MAD(): [KnowledgeBase, ResourceManager, AIAssistant] {
  const knowledge = new KnowledgeBase();
  const resources = new ResourceManager();
  const assistant = new AIAssistant(knowledge, resources);
  
  // Preload critical knowledge
  knowledge.addKnowledge('firstAid', 'Apply pressure to wounds, use tourniquet if necessary');
  knowledge.addKnowledge('foraging', 'Look for edible plants with broad leaves and avoid mushrooms');
  
  return [knowledge, resources, assistant];
}