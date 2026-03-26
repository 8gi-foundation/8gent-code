/**
 * Represents an Agile sprint
 */
interface Sprint {
  name: string;
  startDate: Date;
  endDate: Date;
  teamCapacity: number;
  stories: Story[];
}

/**
 * Represents a user story in a sprint
 */
interface Story {
  title: string;
  points: number;
  assignee?: string;
  priority: number;
}

/**
 * Creates a new sprint
 * @param options - Sprint configuration
 * @returns New sprint object
 */
function createSprint(options: { name: string; startDate: Date; endDate: Date; teamCapacity: number }): Sprint {
  return {
    name: options.name,
    startDate: options.startDate,
    endDate: options.endDate,
    teamCapacity: options.teamCapacity,
    stories: []
  };
}

/**
 * Adds a story to a sprint
 * @param sprint - Target sprint
 * @param story - Story to add
 */
function addStory(sprint: Sprint, story: { title: string; points: number; assignee?: string; priority: number }): void {
  sprint.stories.push({ ...story });
}

/**
 * Calculates sprint load metrics
 * @param sprint - Target sprint
 * @returns Load statistics
 */
function calculateLoad(sprint: Sprint): { totalPoints: number; capacity: number; loadPercent: number } {
  const total = sprint.stories.reduce((sum, s) => sum + s.points, 0);
  const capacity = sprint.teamCapacity;
  const loadPercent = capacity > 0 ? (total / capacity) * 100 : 0;
  return { totalPoints: total, capacity, loadPercent };
}

/**
 * Auto-assigns unassigned stories to team members
 * @param sprint - Target sprint
 * @param team - Team members with capacities
 */
function autoAssign(sprint: Sprint, team: { name: string; capacity: number }[]): void {
  const unassigned = sprint.stories.filter(s => !s.assignee);
  unassigned.sort((a, b) => b.priority - a.priority);
  
  const availableTeam = team.map(t => ({ ...t, remaining: t.capacity }));
  
  for (const story of unassigned) {
    const available = availableTeam
      .filter(m => m.remaining >= story.points)
      .sort((a, b) => b.remaining - a.remaining);
    
    if (available.length > 0) {
      const member = available[0];
      story.assignee = member.name;
      member.remaining -= story.points;
    }
  }
}

/**
 * Renders sprint board as ASCII kanban view
 * @param sprint - Target sprint
 * @returns ASCII board representation
 */
function renderBoard(sprint: Sprint): string {
  const grouped = sprint.stories.reduce((acc, story) => {
    if (!story.assignee) return acc;
    if (!acc[story.assignee]) {
      acc[story.assignee] = [];
    }
    acc[story.assignee].push(story);
    return acc;
  }, {} as Record<string, Story[]>);
  
  Object.values(grouped).forEach(stories => {
    stories.sort((a, b) => a.priority - b.priority);
  });
  
  let output = '';
  for (const [assignee, stories] of Object.entries(grouped)) {
    output += `${assignee}\n`;
    for (const story of stories) {
      output += `  - ${story.title} (${story.points} points)\n`;
    }
  }
  return output;
}

export { createSprint, addStory, calculateLoad, autoAssign, renderBoard };