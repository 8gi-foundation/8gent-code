---
name: test-generator
trigger: /test-generator
description: Automatically generates comprehensive test suites with high coverage. Creates unit tests, integration tests, edge cases, and mocks for functions, classes, and APIs.
category: testing
tools: [read_file, ast_parse, infer_types, generate_mocks]
---

# Test Generator Skill

Generates comprehensive test suites automatically by analyzing code structure, inferring behavior, and creating test cases for normal flows, edge cases, and error conditions.

## What It Generates

### Unit Tests
- Function/method behavior tests
- Input validation tests
- Edge case coverage
- Error handling tests
- Mock dependencies

### Integration Tests
- API endpoint tests
- Database operation tests
- External service integration
- Authentication flows
- End-to-end scenarios

### Test Utilities
- Mock factories
- Test fixtures
- Setup/teardown helpers
- Custom matchers
- Test data generators

## Supported Frameworks

- **JavaScript/TypeScript**: Jest, Vitest, Mocha
- **Python**: pytest, unittest
- **Go**: testing package
- **Java**: JUnit 5
- **Rust**: built-in test framework

## Usage

Generate tests for file:
```
/test-generator src/utils/validator.ts
```

Generate for entire module:
```
/test-generator src/api/
```

With specific framework:
```
/test-generator src/auth.ts --framework=vitest
```

Focus on edge cases:
```
/test-generator src/parser.ts --focus=edge-cases
```

## Output Format

```
TEST SUITE GENERATED
====================

File: src/utils/validator.ts
Framework: Jest
Test File: src/utils/__tests__/validator.test.ts

TESTS GENERATED: 15

Functions Covered:
  ✓ validateEmail() - 3 tests
  ✓ validatePassword() - 4 tests
  ✓ validateUsername() - 3 tests
  ✓ sanitizeInput() - 5 tests

Estimated Coverage: 87%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generated Test Code:

// src/utils/__tests__/validator.test.ts
import { validateEmail, validatePassword, validateUsername, sanitizeInput } from '../validator';

describe('validateEmail', () => {
  describe('valid inputs', () => {
    it('should accept standard email format', () => {
      expect(validateEmail('user@example.com')).toBe(true);
    });

    it('should accept email with subdomain', () => {
      expect(validateEmail('user@mail.example.com')).toBe(true);
    });

    it('should accept email with plus addressing', () => {
      expect(validateEmail('user+tag@example.com')).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject email without @', () => {
      expect(validateEmail('userexample.com')).toBe(false);
    });

    it('should reject email without domain', () => {
      expect(validateEmail('user@')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(validateEmail('')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle null input', () => {
      expect(() => validateEmail(null as any)).toThrow();
    });

    it('should handle undefined input', () => {
      expect(() => validateEmail(undefined as any)).toThrow();
    });

    it('should handle very long email (>254 chars)', () => {
      const longEmail = 'a'.repeat(250) + '@example.com';
      expect(validateEmail(longEmail)).toBe(false);
    });
  });
});

describe('validatePassword', () => {
  describe('valid passwords', () => {
    it('should accept password meeting all requirements', () => {
      expect(validatePassword('Passw0rd!')).toBe(true);
    });

    it('should accept password with special characters', () => {
      expect(validatePassword('P@ssw0rd#2024')).toBe(true);
    });
  });

  describe('invalid passwords', () => {
    it('should reject password too short', () => {
      const result = validatePassword('Pass1!');
      expect(result).toBe(false);
    });

    it('should reject password without numbers', () => {
      expect(validatePassword('Password!')).toBe(false);
    });

    it('should reject password without uppercase', () => {
      expect(validatePassword('passw0rd!')).toBe(false);
    });

    it('should reject password without special chars', () => {
      expect(validatePassword('Passw0rd')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(validatePassword('')).toBe(false);
    });

    it('should handle whitespace-only password', () => {
      expect(validatePassword('        ')).toBe(false);
    });

    it('should handle very long password (>128 chars)', () => {
      const longPwd = 'P@ssw0rd' + 'a'.repeat(130);
      expect(validatePassword(longPwd)).toBe(false);
    });
  });
});

describe('sanitizeInput', () => {
  describe('XSS prevention', () => {
    it('should strip script tags', () => {
      const input = '<script>alert("xss")</script>Hello';
      expect(sanitizeInput(input)).toBe('Hello');
    });

    it('should strip event handlers', () => {
      const input = '<div onclick="evil()">Text</div>';
      expect(sanitizeInput(input)).toBe('Text');
    });

    it('should handle multiple attack vectors', () => {
      const input = '<img src=x onerror="alert(1)">';
      expect(sanitizeInput(input)).not.toContain('onerror');
    });
  });

  describe('SQL injection prevention', () => {
    it('should escape single quotes', () => {
      const input = "admin' OR '1'='1";
      const result = sanitizeInput(input);
      expect(result).not.toContain("'");
    });

    it('should handle SQL comments', () => {
      const input = 'admin--';
      expect(sanitizeInput(input)).not.toContain('--');
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      expect(sanitizeInput('')).toBe('');
    });

    it('should handle null input', () => {
      expect(sanitizeInput(null as any)).toBe('');
    });

    it('should preserve safe HTML entities', () => {
      expect(sanitizeInput('&lt;div&gt;')).toBe('&lt;div&gt;');
    });

    it('should handle unicode characters', () => {
      expect(sanitizeInput('Hello 世界 🌍')).toBe('Hello 世界 🌍');
    });
  });
});

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SETUP INSTRUCTIONS
==================

1. Install dependencies:
   npm install --save-dev jest @types/jest ts-jest

2. Configure Jest (jest.config.js):
   ```javascript
   module.exports = {
     preset: 'ts-jest',
     testEnvironment: 'node',
     collectCoverageFrom: ['src/**/*.ts'],
     coverageThreshold: {
       global: {
         branches: 80,
         functions: 80,
         lines: 80,
         statements: 80
       }
     }
   };
   ```

3. Add test script to package.json:
   ```json
   {
     "scripts": {
       "test": "jest",
       "test:watch": "jest --watch",
       "test:coverage": "jest --coverage"
     }
   }
   ```

4. Run tests:
   npm test

COVERAGE ANALYSIS
=================

Estimated Coverage by Category:

  Statements:   87% ████████████████████
  Branches:     82% ███████████████████
  Functions:    91% █████████████████████
  Lines:        85% ████████████████████

Uncovered Areas:
  - Error handling for network failures (line 45-52)
  - Edge case: malformed UTF-8 (line 89)
  - Deprecated legacy method (line 123)

To reach 90% coverage, add:
  1. Tests for network error scenarios
  2. Malformed input edge cases
  3. Legacy method deprecation test

NEXT STEPS
==========

1. Review generated tests for accuracy
2. Run tests: npm test
3. Add domain-specific test cases
4. Mock external dependencies
5. Set up CI/CD integration
```

## Test Generation Process

1. **Parse Code**: Extract functions, classes, types via AST
2. **Infer Behavior**: Analyze function signatures, return types, side effects
3. **Identify Edge Cases**: Null/undefined, empty arrays, boundary values
4. **Generate Assertions**: Based on types and expected behavior
5. **Create Mocks**: For external dependencies (DB, APIs, file system)
6. **Calculate Coverage**: Estimate statement/branch coverage
7. **Generate Setup**: Framework config, test utilities

## Test Categories

### Happy Path Tests
- Valid inputs
- Expected outputs
- Normal flow

### Edge Cases
- Boundary values (0, -1, MAX_INT)
- Empty collections
- Null/undefined
- Very large inputs

### Error Conditions
- Invalid inputs
- Type mismatches
- Thrown exceptions
- Async rejections

### Integration Scenarios
- Database operations
- API calls
- File I/O
- Authentication

## Mocking Strategies

Automatically generates mocks for:
- Database connections
- HTTP clients
- File system operations
- External APIs
- Time/Date functions
- Random number generators

## Integration

Works with:
- `/code-review` - Generate tests for identified issues
- `/security-audit` - Generate security-focused tests
- `/documentation-writer` - Document test coverage

## Configuration

Options:
- `--framework=jest|vitest|mocha` - Choose test framework
- `--focus=edge-cases` - Prioritize edge case coverage
- `--focus=security` - Security-focused tests
- `--mocks` - Generate mock factories
- `--coverage-target=90` - Set coverage goal
- `--integration` - Include integration tests

## Examples

### Example 1: Simple Function
```
/test-generator src/math.ts
```

Input:
```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```

Output:
```typescript
describe('add', () => {
  it('should add positive numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
  
  it('should add negative numbers', () => {
    expect(add(-2, -3)).toBe(-5);
  });
  
  it('should handle zero', () => {
    expect(add(0, 5)).toBe(5);
  });
  
  it('should handle large numbers', () => {
    expect(add(Number.MAX_SAFE_INTEGER, 1)).toBeLessThan(Infinity);
  });
});
```

### Example 2: API Endpoint
```
/test-generator src/api/users.ts
```

Output:
```typescript
describe('POST /users', () => {
  it('should create user with valid data', async () => {
    const response = await request(app)
      .post('/users')
      .send({ email: 'test@example.com', password: 'Pass123!' });
    
    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('id');
  });
  
  it('should reject duplicate email', async () => {
    // Create user first
    await createUser({ email: 'test@example.com' });
    
    const response = await request(app)
      .post('/users')
      .send({ email: 'test@example.com', password: 'Pass123!' });
    
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already exists/i);
  });
  
  it('should validate email format', async () => {
    const response = await request(app)
      .post('/users')
      .send({ email: 'invalid', password: 'Pass123!' });
    
    expect(response.status).toBe(400);
  });
});
```

### Example 3: With Mocks
```
/test-generator src/services/payment.ts --mocks
```

Output:
```typescript
// Generated mock factory
export const mockStripeClient = () => ({
  charges: {
    create: jest.fn().mockResolvedValue({
      id: 'ch_123',
      status: 'succeeded'
    })
  }
});

describe('PaymentService', () => {
  let paymentService: PaymentService;
  let stripeClient: ReturnType<typeof mockStripeClient>;
  
  beforeEach(() => {
    stripeClient = mockStripeClient();
    paymentService = new PaymentService(stripeClient);
  });
  
  it('should process payment successfully', async () => {
    const result = await paymentService.charge(100, 'usd');
    
    expect(result.success).toBe(true);
    expect(stripeClient.charges.create).toHaveBeenCalledWith({
      amount: 10000,
      currency: 'usd'
    });
  });
});
```

## Notes

- Generates executable tests, not templates
- Infers behavior from types and names
- Creates realistic test data
- Handles async operations correctly
- Follows framework conventions
- Integrates with existing test suites
- Updates as code changes (re-run to sync)
