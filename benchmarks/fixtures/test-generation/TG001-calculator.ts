/**
 * Fixture: TG001 - Generate Tests for Calculator
 *
 * Task: Generate comprehensive test suite for this calculator module
 * Requirements:
 * - Unit tests for all functions
 * - Edge cases (division by zero, overflow, etc.)
 * - Property-based tests where applicable
 * - 100% code coverage
 */

export type Operation = "add" | "subtract" | "multiply" | "divide" | "power" | "modulo";

export interface CalculatorResult {
  value: number;
  operation: Operation;
  operands: [number, number];
  timestamp: Date;
}

export interface CalculatorHistory {
  results: CalculatorResult[];
  lastOperation: CalculatorResult | null;
}

const history: CalculatorHistory = {
  results: [],
  lastOperation: null,
};

function recordResult(result: CalculatorResult): void {
  history.results.push(result);
  history.lastOperation = result;
}

export function add(a: number, b: number): number {
  const result = a + b;
  recordResult({
    value: result,
    operation: "add",
    operands: [a, b],
    timestamp: new Date(),
  });
  return result;
}

export function subtract(a: number, b: number): number {
  const result = a - b;
  recordResult({
    value: result,
    operation: "subtract",
    operands: [a, b],
    timestamp: new Date(),
  });
  return result;
}

export function multiply(a: number, b: number): number {
  const result = a * b;
  recordResult({
    value: result,
    operation: "multiply",
    operands: [a, b],
    timestamp: new Date(),
  });
  return result;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Division by zero");
  }
  const result = a / b;
  recordResult({
    value: result,
    operation: "divide",
    operands: [a, b],
    timestamp: new Date(),
  });
  return result;
}

export function power(base: number, exponent: number): number {
  if (exponent < 0 && base === 0) {
    throw new Error("Cannot raise zero to negative power");
  }
  const result = Math.pow(base, exponent);
  recordResult({
    value: result,
    operation: "power",
    operands: [base, exponent],
    timestamp: new Date(),
  });
  return result;
}

export function modulo(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Modulo by zero");
  }
  const result = a % b;
  recordResult({
    value: result,
    operation: "modulo",
    operands: [a, b],
    timestamp: new Date(),
  });
  return result;
}

export function getHistory(): CalculatorHistory {
  return { ...history };
}

export function clearHistory(): void {
  history.results = [];
  history.lastOperation = null;
}

export function calculate(operation: Operation, a: number, b: number): number {
  switch (operation) {
    case "add":
      return add(a, b);
    case "subtract":
      return subtract(a, b);
    case "multiply":
      return multiply(a, b);
    case "divide":
      return divide(a, b);
    case "power":
      return power(a, b);
    case "modulo":
      return modulo(a, b);
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

export function calculateChain(operations: Array<{ op: Operation; value: number }>, initial: number): number {
  let result = initial;
  for (const { op, value } of operations) {
    result = calculate(op, result, value);
  }
  return result;
}
