/**
 * Alert rule definition
 */
interface Rule {
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  severity: string;
  silenceMinutes?: number;
}

/**
 * Evaluation result
 */
interface EvaluationResult {
  firing: boolean;
  severity: string;
  message: string;
}

/**
 * Define an alert rule
 * @param name Rule name
 * @param metric Metric name
 * @param condition Comparison operator (e.g. '>', '<=')
 * @param threshold Threshold value
 * @param severity Severity level (e.g. 'warning', 'critical')
 * @param silenceMinutes Optional silence window in minutes
 * @returns Rule object
 */
function defineRule({
  name,
  metric,
  condition,
  threshold,
  severity,
  silenceMinutes = 0
}: {
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  severity: string;
  silenceMinutes?: number;
}): Rule {
  return { name, metric, condition, threshold, severity, silenceMinutes };
}

/**
 * Evaluate a rule against a metric value
 * @param rule Rule definition
 * @param value Current metric value
 * @returns Evaluation result
 */
function evaluate(rule: Rule, value: number): EvaluationResult {
  const compare = (a: number, b: number): boolean => {
    switch (rule.condition) {
      case '>': return a > b;
      case '>=': return a >= b;
      case '<': return a < b;
      case '<=': return a <= b;
      default: return false;
    }
  };

  const firing = compare(value, rule.threshold);
  return {
    firing,
    severity: firing ? rule.severity : 'ok',
    message: `${rule.name}: ${value} ${rule.condition} ${rule.threshold}`
  };
}

/**
 * Check if rule is currently silenced
 * @param rule Rule definition
 * @param now Current timestamp in milliseconds
 * @returns True if silenced
 */
function isSilenced(rule: Rule, now = Date.now()): boolean {
  if (!rule.silenceMinutes) return false;
  const silenceStart = now - rule.silenceMinutes * 60 * 1000;
  return now > silenceStart;
}

/**
 * Evaluate multiple rules against metric values
 * @param rules Array of rules
 * @param metrics Metric values map
 * @returns Array of evaluation results
 */
function evaluateAll(rules: Rule[], metrics: Record<string, number>): EvaluationResult[] {
  return rules.map(rule => {
    const value = metrics[rule.metric];
    return evaluate(rule, value ?? 0);
  });
}

/**
 * Render rules as markdown documentation
 * @param rules Array of rules
 * @returns Markdown string
 */
function renderRules(rules: Rule[]): string {
  return rules.map(rule => 
    `### ${rule.name}\n\n- **Metric**: ${rule.metric}\n- **Condition**: ${rule.condition} ${rule.threshold}\n- **Severity**: ${rule.severity}\n- **Silence window**: ${rule.silenceMinutes ? `${rule.silenceMinutes} minutes` : 'none'}`).join('\n\n');
}

export { defineRule, evaluate, isSilenced, evaluateAll, renderRules };