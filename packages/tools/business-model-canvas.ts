/**
 * Block identifiers for Business Model Canvas
 */
enum Block {
  KeyPartners = 'Key Partners',
  KeyActivities = 'Key Activities',
  KeyResources = 'Key Resources',
  ValuePropositions = 'Value Propositions',
  CustomerRelationships = 'Customer Relationships',
  Channels = 'Channels',
  CustomerSegments = 'Customer Segments',
  CostStructure = 'Cost Structure',
  RevenueStreams = 'Revenue Streams'
}

/**
 * Creates a new empty Business Model Canvas
 * @returns {Canvas} Canvas with all 9 blocks initialized
 */
function createCanvas(): Canvas {
  return {
    [Block.KeyPartners]: [],
    [Block.KeyActivities]: [],
    [Block.KeyResources]: [],
    [Block.ValuePropositions]: [],
    [Block.CustomerRelationships]: [],
    [Block.Channels]: [],
    [Block.CustomerSegments]: [],
    [Block.CostStructure]: [],
    [Block.RevenueStreams]: []
  };
}

/**
 * Sets items for a specific block
 * @param {Canvas} canvas - Canvas to modify
 * @param {Block} block - Target block
 * @param {string[]} items - Items to set
 * @returns {Canvas} Updated canvas
 */
function setBlock(canvas: Canvas, block: Block, items: string[]): Canvas {
  canvas[block] = items;
  return canvas;
}

/**
 * Validates canvas completeness
 * @param {Canvas} canvas - Canvas to validate
 * @returns {Block[]} List of empty/weak blocks
 */
function validate(canvas: Canvas): Block[] {
  return Object.entries(canvas)
    .filter(([_, items]) => items.length === 0 || items.length < 2)
    .map(([block]) => Block[block as keyof typeof Block]);
}

/**
 * Renders canvas as markdown
 * @param {Canvas} canvas - Canvas to render
 * @returns {string} Formatted markdown
 */
function renderMarkdown(canvas: Canvas): string {
  return Object.entries(canvas)
    .map(([block, items]) => {
      const header = `## ${block}`;
      const list = items.length ? items.map(i => `- ${i}`).join('\n') : 'None';
      return [header, list].join('\n');
    })
    .join('\n\n');
}

/**
 * Calculates canvas completeness score
 * @param {Canvas} canvas - Canvas to score
 * @returns {number} Score between 0-100
 */
function scoreCompleteness(canvas: Canvas): number {
  const filled = Object.values(canvas).filter(items => items.length > 0).length;
  return Math.round((filled / 9) * 100);
}

/**
 * Business Model Canvas structure
 */
interface Canvas {
  [Block.KeyPartners]: string[];
  [Block.KeyActivities]: string[];
  [Block.KeyResources]: string[];
  [Block.ValuePropositions]: string[];
  [Block.CustomerRelationships]: string[];
  [Block.Channels]: string[];
  [Block.CustomerSegments]: string[];
  [Block.CostStructure]: string[];
  [Block.RevenueStreams]: string[];
}

export { Block, createCanvas, setBlock, validate, renderMarkdown, scoreCompleteness, Canvas };