import { BusinessIdea, Message } from '../types';

export class QuestioningEngine {
  private questions: string[] = [];
  private context: Record<string, any> = {};
  
  constructor(private businessType: string) {
    this.initializeQuestionBank();
  }

  initializeQuestionBank() {
    const questionSets = {
      industryAgnostic: [
        "What problem are we solving?",
        "Who specifically has this problem?",
        "How much is this problem costing them in time/money/frustration?",
        "What have they tried before?",
        "Why haven't existing solutions worked?",
        "What would make this irresistible to solve?",
        "What's different about this approach?",
        "Can we articulate the 'aha' moment clearly?",
        "Is there urgency or timing that matters?",
        "How will adoption spread once started?"
      ],
      marketDiscovery: [
        "What demographic/psychographic segments need this most?",
        "Where do they currently look for solutions?",
        "What information sources influence their decisions?",
        "What's blocking purchase or adoption right now?",
        "Who influences their buying decision?",
        "What budget constraints exist?",
        "Is this a top-of-funnel or urgent need?"
      ],
      competitorAnalysis: [
        "What are the market leaders offering?",
        "Where do they underdeliver on customer expectations?",
        "What price points dominate each segment?",
        "How satisfied are current customers with existing options?",
        "What features are table stakes vs. competitive advantages?",
        "Where's white space in positioning landscapes?"
      ]
    };

    this.questions = questionSets.industryAgnostic;
  }

  askSequential(startingSet: string = 'industryAgnostic'): void {
    const set = Object.entries(questionSets)[0][1]; // For now, just use defaults
    let i = 0;
    
    while (i < set.length) {
      const question = set[i];
      console.log(`\n[${this.businessType}] Q${i + 1}: ${question}`);
      
      // In production, would prompt user or call LLM for answer
      this.processAnswer(question, null);
      i++;
    }
  }

  async processAnswer(question: string, answer: string | null): Promise<void> {
    this.context[question] = answer || "No answer yet";
    
    // Analyze answers and determine next questions dynamically
    const implications = this.analyzeImplications(answer);
    
    if (implications.nextQuestions && implications.nextQuestions.length > 0) {
      this.questions = [...this.questions, ...implications.nextQuestions];
    }

    // Generate message based on context accumulated
    if (Object.keys(this.context).length >= 5) {
      await this.generateMessage();
    }
  }

  analyzeImplications(answer: string): { nextQuestions: string[]; insights: string[] } {
    const lowerAnswer = answer?.toLowerCase() || '';
    
    const implicationMap: Record<string, any> = {
      'pain': {
        nextQuestions: [
          "How severe is this pain on a scale of 1-10?",
          "What happens if they don't address it soon?"
        ],
        insights: ["High pain point identified"]
      },
      '$': {
        nextQuestions: ["What's their acceptable expenditure range?"],
        insights: ["Monetization path clear"]
      },
      'time': {
        nextQuestions: ["Is this a fast-cycle or long-cycle decision?"],
        insights: ["Timing dynamics noted"]
      }
    };

    const keyTerms = Object.keys(implicationMap);
    for (const term of keyTerms) {
      if (lowerAnswer.includes(term)) {
        return implicationMap[term];
      }
    }

    return { nextQuestions: [], insights: ["General context noted"] };
  }

  private async generateMessage(): Promise<void> {
    // Generate message based on current knowledge
    const messages = await this.buildMessagingFramework();
    console.log("\n=== RECOMMENDED MESSAGES ===");
    messages.forEach(m => {
      console.log(`\nTopic: ${m.topic}`);
      console.log(`  Headline: ${m.headline}`);
      console.log(`  Body preview: ${m.bodyContent.substring(0, 150)}...`);
    });
  }

  private async buildMessagingFramework(): Promise<Message[]> {
    // This would be enhanced with LLM calls in production
    const templates = [
      {
        topic: "Market Opportunity",
        headline: `Why ${this.businessType === 'Other' ? 'Your Idea' : this.businessType}s Dominate`,
        bodyContent: "The market is ripe for disruption. Customers are frustrated with current options, and your solution offers a compelling alternative...",
        cta: "Discover how we're solving this"
      },
      {
        topic: "Pain Point Empathy",
        headline: "We Get Your Frustration",
        bodyContent: "You don't have to struggle with [problem]. We built something specifically for people like you...",
        cta: "See how it helps"
      },
      {
        topic: "Early Access Invite",
        headline: "Be Among the First",
        bodyContent: "Join our beta community and shape the future of [solution category] right now...",
        cta: "Reserve your spot"
      }
    ];

    return templates;
  }
}

// Export singleton for easy access
export const questioningEngine = new QuestioningEngine('');
