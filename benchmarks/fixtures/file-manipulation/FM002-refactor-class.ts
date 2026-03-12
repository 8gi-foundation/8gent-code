/**
 * Fixture: FM002 - Refactor Class to Functions
 *
 * Task: Convert this class-based implementation to pure functions
 */

export class Calculator {
  private result: number;

  constructor(initial: number = 0) {
    this.result = initial;
  }

  add(n: number): Calculator {
    this.result += n;
    return this;
  }

  subtract(n: number): Calculator {
    this.result -= n;
    return this;
  }

  multiply(n: number): Calculator {
    this.result *= n;
    return this;
  }

  divide(n: number): Calculator {
    if (n === 0) throw new Error("Division by zero");
    this.result /= n;
    return this;
  }

  getResult(): number {
    return this.result;
  }

  reset(): Calculator {
    this.result = 0;
    return this;
  }
}

// Usage example:
// const calc = new Calculator(10).add(5).multiply(2).getResult() // 30
