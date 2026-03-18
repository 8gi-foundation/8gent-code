export type BusinessType = 
  | 'SaaS' 
  | 'E-commerce' 
  | 'Marketplace' 
  | 'Service Platform' 
  | 'Content/Publisher' 
  | 'AI Product' 
  | 'Local Delivery' 
  | 'Subscription Box' 
  | 'Education/Fintech' 
  | 'Health & Wellness'
  | 'Mobile App' 
  | 'Dropshipping' 
  | 'Agency/Creative' 
  | 'Consulting/Freelance' 
  | 'Food/Restaurant' 
  | 'Travel/Tours' 
  | 'Membership Community' 
  | 'Other';

export interface BusinessIdea {
  name: string;
  description: string;
  type: BusinessType;
  targetAudience?: string;
  uniqueValueProposition?: string;
  problemsToSolve: string[];
  monetizationModel: 'subscription' | 'one_time' | 'freemium' | 'commission' | 'ads' | 'marketplace_fee';
  pricingStrategy?: {
    tierName?: string;
    monthlyPrice?: number;
    annualPrice?: number;
    freeTierFeatures?: Feature[];
  };
}

export interface TargetMarketAnalysis {
  totalAddressableMarket: number;
  serviceableAvailableMarket: number;
  serviceableMarket: number;
  growthRate?: number;
  keyTrends: string[];
  regulatoryEnvironment?: string;
  seasonalityFactors?: string[];
}

export interface Competitor {
  name: string;
  url: string;
  strengths: string[];
  weaknesses: string[];
  pricingModel?: string;
  targetAudience?: string;
  keyFeatures?: string[];
  marketShare?: number;
  positioningStrategy?: string;
  gapsInMarket: string[];
}

export class JBTD {
  industry: string = '';
  
  jobsToBeDone: Array<{
    customerSegment: string;
    situation: string;
    jobDescription: string;
    desiredOutcomes: string[];
    currentSolutions: string[];
    gapsPainPoints: string[];
  }> = [];

  blueOceanStrategy: {
    factorsToIgnore: string[];
    factorsToReduce: string[];
    factorsToRaise: string[];
    factorsToCreate: string[];
  } = {
    factorsToIgnore: [],
    factorsToReduce: [],
    factorsToRaise: [],
    factorsToCreate: []
  };

  newProductPositioning: {
    valueInnovations: ValueInnovation[];
    marketSegment: string;
    strategyRationale: string;
  } = {
    valueInnovations: [],
    marketSegment: '',
    strategyRationale: ''
  };

  setIndustry(industry: string) { this.industry = industry; }
  
  addJobsToBeDone(jobs: Array<Parameter<typeof this.jobsToBeDone[number]>>) {
    this.jobsToBeDone = [...this.jobsToBeDone, ...jobs];
    return this;
  }

  setBlueOceanStrategy(strategy: Parameters<typeof this.blueOceanStrategy = [])[0]) {
    this.blueOceanStrategy = strategy;
    return this;
  }

  setNewProductPositioning(positioning: Parameters<typeof this.newProductPositioning = [])[0]) {
    this.newProductPositioning = positioning;
    return this;
  }

  executeAnalysis(): string {
    const analysis = `${this.industry}\n\nJobs to be Done:\n`;
    this.jobsToBeDone.forEach((job, i) => {
      analysis += `\n${i + 1}. ${job.customerSegment} - ${job.jobDescription}\n   Gaps: ${job.gapsPainPoints.join(', ')}`;
    });
    
    if (this.blueOceanStrategy.factorsToCreate.length || this.blueOceanStrategy.factorsToRaise.length) {
      analysis += `\n\nValue Innovation:\n   Create: ${this.blueOceanStrategy.factorsToCreate.join(', ')}\n   Raise: ${this.blueOceanStrategy.factorsToRaise.join(', ')}`;
    }
    
    return analysis.trim();
  }
}

export class BrandVision {
  name: string = '';
  missionStatement: string = '';
  visionStatement: string = '';
  values: string[] = [];
  brandVoice: 'authoritative' | 'friendly' | 'witty' | 'professional' | 'casual' = 'professional';
  targetAudienceDemographics: {
    ageRange?: string;
    incomeLevel?: string;
    geography?: string;
    psychographics: string[];
  } = { psychographics: [] };
  
  visualIdentity: {
    primaryColors: string[];
    secondaryColors: string[];
    typography: { fontFamily: string; fontStyle: 'modern' | 'classic' | 'bold'; };
    logoConcept?: string;
    toneAndStyle: string;
  } = {
    primaryColors: [],
    secondaryColors: [],
    typography: { fontFamily: '', fontStyle: 'modern' },
    toneAndStyle: ''
  };

  setBrandVision(options: Parameters<typeof this.setVisualIdentity ? [never] : any>) { 
    return this; 
  }

  addValueInnovation(factor: string, category: 'create' | 'raise' | 'reduce' | 'ignore') {
    if (category === 'create') this.blueOceanStrategy.factorsToCreate.push(factor);
    else if (category === 'raise') this.blueOceanStrategy.factorsToRaise.push(factor);
    else if (category === 'reduce') this.blueOceanStrategy.fairsToReduce.push(factor);
    else if (category === 'ignore') this.blueOceanStrategy.factorsToIgnore.push(factor);
    return this;
  }

  addJobToBeDone(job: {customerSegment: string, situation: string, jobDescription: string, desiredOutcomes: string[], currentSolutions: string[], gapsPainPoints: string[]}) {
    this.jobsToBeDone.push(job);
    return this;
  }
}

export interface BrandPositioning {
  uniqueSellingProposition: string;
  brandArchetype: 'creator' | 'everyman' | 'explorer' | 'hero' | 'innovator' | 'lover' | 'outlaw' | 'caretaker' | 'ruler' | 'sage';
  brandPersonalityTraits: string[];
  messagingPillars: string[];
  competitiveAdvantage: string[];
}

export type Message = {
  topic: string;
  headline: string;
  bodyContent: string;
  callToAction: string;
  toneVariant?: 'authoritative' | 'friendly' | 'witty' | 'professional';
  targetEmotion: 'trust' | 'excitement' | 'urgency' | 'curiosity' | 'belonging' | 'empowerment';
};

export type MessageResponse = {
  messages: Message[];
  recommendedChannels: string[];
  optimalPostingTimes: string[];
  contentFormats: Array<{type: 'article' | 'video' | 'infographic' | 'poll' | 'story', frequency: number}>;
};
