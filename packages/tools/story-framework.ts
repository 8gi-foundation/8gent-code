/**
 * Builds a Hero's Journey narrative across 12 stages.
 * @param elements - Object containing all 12 stages as properties.
 * @returns The narrative structure.
 */
export function heroJourney(elements: { [key: string]: string }): { [key: string]: string } {
  return elements;
}

/**
 * Constructs a Problem-Agitate-Solve framework.
 * @param param0 - Object with problem, agitation, solution.
 * @returns The framework structure.
 */
export function pas({ problem, agitation, solution }: { problem: string; agitation: string; solution: string }): { problem: string; agitation: string; solution: string } {
  return { problem, agitation, solution };
}

/**
 * Constructs a STAR story format.
 * @param param0 - Object with situation, task, action, result.
 * @returns The story structure.
 */
export function star({ situation, task, action, result }: { situation: string; task: string; action: string; result: string }): { situation: string; task: string; action: string; result: string } {
  return { situation, task, action, result };
}

/**
 * Constructs an AIDA marketing framework.
 * @param param0 - Object with attention, interest, desire, action.
 * @returns The framework structure.
 */
export function aida({ attention, interest, desire, action }: { attention: string; interest: string; desire: string; action: string }): { attention: string; interest: string; desire: string; action: string } {
  return { attention, interest, desire, action };
}

/**
 * Renders a story document based on the framework and type.
 * @param framework - The framework object (from heroJourney, pas, etc.)
 * @param type - The type of framework ('hero', 'pas', 'star', 'aida').
 * @returns Formatted story document.
 */
export function renderStory(framework: any, type: string): any {
  switch (type) {
    case 'hero':
      return {
        title: "Hero's Journey",
        stages: [
          { name: 'Ordinary World', content: framework.ordinaryWorld },
          { name: 'Call to Adventure', content: framework.callToAdventure },
          { name: 'Refusal of the Call', content: framework.refusalOfTheCall },
          { name: 'Meeting the Mentor', content: framework.meetingTheMentor },
          { name: 'Crossing the Threshold', content: framework.crossingTheThreshold },
          { name: 'Tests, Allies, Enemies', content: framework.testsAlliesEnemies },
          { name: 'Approach to the Inmost Cave', content: framework.approachToTheInmostCave },
          { name: 'Ordeal', content: framework.ordeal },
          { name: 'Reward', content: framework.reward },
          { name: 'The Road Back', content: framework.theRoadBack },
          { name: 'Resurrection', content: framework.resurrection },
          { name: 'Return with the Elixir', content: framework.returnWithTheElixir }
        ]
      };
    case 'pas':
      return {
        title: 'Problem-Agitate-Solve',
        sections: [
          { name: 'Problem', content: framework.problem },
          { name: 'Agitation', content: framework.agitation },
          { name: 'Solution', content: framework.solution }
        ]
      };
    case 'star':
      return {
        title: 'STAR',
        sections: [
          { name: 'Situation', content: framework.situation },
          { name: 'Task', content: framework.task },
          { name: 'Action', content: framework.action },
          { name: 'Result', content: framework.result }
        ]
      };
    case 'aida':
      return {
        title: 'AIDA',
        sections: [
          { name: 'Attention', content: framework.attention },
          { name: 'Interest', content: framework.interest },
          { name: 'Desire', content: framework.desire },
          { name: 'Action', content: framework.action }
        ]
      };
    default:
      throw new Error('Unknown framework type');
  }
}