/**
 * Represents a task in the task tree.
 */
interface Task {
  id: string;
  title: string;
  effort: number;
  dependencies: string[];
  children: string[];
  depth: number;
}

/**
 * Represents a task tree with a collection of tasks and a root task ID.
 */
interface Tree {
  tasks: { [id: string]: Task };
  root: string;
}

/**
 * Creates a new task tree with a root task.
 * @param goal - The high-level goal title.
 * @param maxDepth - Maximum depth for decomposition (not used in this implementation).
 * @returns A new task tree with the root task.
 */
export function decompose(goal: string, maxDepth: number): Tree {
  const root: Task = {
    id: 'root',
    title: goal,
    effort: 0,
    dependencies: [],
    children: [],
    depth: 0,
  };
  return { tasks: { [root.id]: root }, root: root.id };
}

/**
 * Adds a new task to the tree under a specified parent.
 * @param tree - The current task tree.
 * @param parentId - ID of the parent task.
 * @param task - New task details.
 * @returns A new task tree with the added task.
 */
export function addTask(tree: Tree, parentId: string, task: { title: string; effort: number; dependencies: string[] }): Tree {
  const newId = `task-${Object.keys(tree.tasks).length + 1}`;
  const newTask: Task = {
    id: newId,
    title: task.title,
    effort: task.effort,
    dependencies: task.dependencies,
    children: [],
    depth: tree.tasks[parentId].depth + 1,
  };
  const updatedTasks = { ...tree.tasks, [newId]: newTask };
  const parent = updatedTasks[parentId];
  updatedTasks[parentId] = {
    ...parent,
    children: [...parent.children, newId],
  };
  return { ...tree, tasks: updatedTasks };
}

/**
 * Finds the longest dependency chain (critical path) in the task tree.
 * @param tree - The task tree.
 * @returns An array of task IDs representing the critical path.
 */
export function criticalPath(tree: Tree): string[] {
  const tasks = tree.tasks;
  let maxPath: string[] = [];
  for (const taskId of Object.keys(tasks)) {
    const path = findCriticalPath(taskId, tasks);
    if (path.length > maxPath.length) {
      maxPath = path;
    }
  }
  return maxPath;
}

function findCriticalPath(taskId: string, tasks: { [id: string]: Task }): string[] {
  const task = tasks[taskId];
  let maxLen = 0;
  let bestPath: string[] = [taskId];
  for (const dep of task.dependencies) {
    const depPath = findCriticalPath(dep, tasks);
    if (depPath.length > maxLen) {
      maxLen = depPath.length;
      bestPath = [taskId, ...depPath];
    }
  }
  return bestPath;
}

/**
 * Calculates the total effort of all leaf tasks in the tree.
 * @param tree - The task tree.
 * @returns Total effort of leaf tasks.
 */
export function totalEffort(tree: Tree): number {
  let sum = 0;
  for (const taskId of Object.keys(tree.tasks)) {
    const task = tree.tasks[taskId];
    if (task.children.length === 0) {
      sum += task.effort;
    }
  }
  return sum;
}

/**
 * Renders the task tree as an ASCII tree with effort estimates.
 * @param tree - The task tree.
 * @returns ASCII representation of the task tree.
 */
export function renderTree(tree: Tree): string {
  const lines: string[] = [];
  const buildLines = (taskId: string, indent: string) => {
    const task = tree.tasks[taskId];
    lines.push(`${indent}- ${task.title} (effort: ${task.effort})`);
    for (const childId of task.children) {
      buildLines(childId, indent + '  ');
    }
  };
  buildLines(tree.root, '');
  return lines.join('\n');
}