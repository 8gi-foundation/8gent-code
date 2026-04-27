/**
 * Rollout plan with stages and current stage index.
 */
interface Rollout {
  stages: Stage[];
  currentStage: number;
}

/**
 * Stage details including percentage, dates, users, and status.
 */
interface Stage {
  percentage: number;
  start: Date;
  end: Date;
  users: number;
  status: 'pending' | 'go' | 'no-go';
}

/**
 * Generates a rollout plan with staged percentages, timing, and user counts.
 * @param options - Configuration object with stages, total users, start date, and stage duration (days)
 * @returns Rollout plan
 */
function plan({ stages, totalUsers, startDate, stageDuration }: { stages: number[], totalUsers: number, startDate: Date, stageDuration: number }): Rollout {
  const plan: Rollout = { stages: [], currentStage: 0 };
  let currentDate = new Date(startDate);
  for (const [i, percentage] of stages.entries()) {
    const start = new Date(currentDate);
    const end = new Date(start);
    end.setDate(end.getDate() + stageDuration);
    plan.stages.push({
      percentage,
      start,
      end,
      users: Math.round((percentage / 100) * totalUsers),
      status: 'pending'
    });
    currentDate = end;
  }
  return plan;
}

/**
 * Evaluates a stage based on error rate, latency, and complaints.
 * @param stage - Stage to evaluate
 * @param metrics - Error rate (percent), latency (ms), complaints (count)
 * @returns 'go' if metrics are acceptable, 'no-go' otherwise
 */
function evaluate(stage: Stage, { errorRate, latency, complaints }: { errorRate: number, latency: number, complaints: number }): 'go' | 'no-go' {
  if (errorRate < 1 && latency < 200 && complaints < 5) return 'go';
  return 'no-go';
}

/**
 * Advances to the next stage or halts rollout.
 * @param rollout - Current rollout plan
 */
function nextStage(rollout: Rollout): void {
  if (rollout.currentStage >= rollout.stages.length - 1) return;
  const currentStage = rollout.stages[rollout.currentStage];
  if (currentStage.status === 'go') {
    rollout.currentStage++;
  } else {
    rollout.currentStage = -1;
  }
}

/**
 * Renders ASCII Gantt-style rollout timeline.
 * @param rollout - Current rollout plan
 * @returns ASCII timeline string
 */
function renderPlan(rollout: Rollout): string {
  return rollout.stages.map(stage => {
    const start = stage.start.toISOString().split('T')[0];
    const end = stage.end.toISOString().split('T')[0];
    return `Stage ${stage.percentage}%: [${'█'.repeat(stage.percentage / 2)}] ${start} to ${end}`;
  }).join('\n');
}

export { plan, evaluate, nextStage, renderPlan, Rollout, Stage };