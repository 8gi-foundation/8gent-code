---
name: documentation-writer
trigger: /documentation-writer
description: Automatically generates comprehensive documentation including README, API docs, guides, and changelogs. Analyzes code structure and creates clear, maintainable documentation.
category: documentation
tools: [read_file, ast_parse, extract_comments, analyze_structure]
---

# Documentation Writer Skill

Generates comprehensive, professional documentation by analyzing code structure, extracting comments, inferring behavior, and creating structured guides for developers and users.

## What It Generates

### Project Documentation
- **README.md**: Project overview, installation, quick start
- **CONTRIBUTING.md**: Contribution guidelines, development setup
- **CHANGELOG.md**: Version history and release notes
- **LICENSE**: License file with proper formatting

### API Documentation
- Function/method signatures
- Parameter descriptions
- Return types and values
- Usage examples
- Type definitions

### Guides
- Getting Started tutorials
- Architecture overview
- Deployment guides
- Troubleshooting sections
- FAQ documents

### Code Comments
- JSDoc/TSDoc annotations
- Inline code explanations
- TODO/FIXME tracking
- Deprecation notices

## Usage

Generate full project docs:
```
/documentation-writer
```

Document specific file:
```
/documentation-writer src/api/users.ts
```

Update README only:
```
/documentation-writer --type=readme
```

Generate API reference:
```
/documentation-writer --type=api-docs
```

## Output Format

```
DOCUMENTATION GENERATED
=======================

Project: my-api
Generated: 2026-03-23

FILES CREATED: 7

Core Documentation:
  ✓ README.md (2.3 KB)
  ✓ CONTRIBUTING.md (1.8 KB)
  ✓ CHANGELOG.md (890 bytes)
  ✓ LICENSE (1.1 KB)

API Documentation:
  ✓ docs/api/users.md (3.4 KB)
  ✓ docs/api/posts.md (2.9 KB)

Guides:
  ✓ docs/getting-started.md (4.2 KB)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generated README.md:

# My API

> A modern REST API built with Node.js and TypeScript

[![Build Status](https://img.shields.io/github/workflow/status/user/my-api/ci)](https://github.com/user/my-api/actions)
[![Coverage](https://img.shields.io/codecov/c/github/user/my-api)](https://codecov.io/gh/user/my-api)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- 🚀 Fast and efficient REST API
- 🔒 Secure authentication with JWT
- 📊 Built-in rate limiting
- 📝 Comprehensive API documentation
- ✅ 95% test coverage
- 🐳 Docker support

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Start development server
npm run dev
```

The API will be available at `http://localhost:3000`

## API Endpoints

### Users

```http
GET    /api/users          # List all users
GET    /api/users/:id      # Get user by ID
POST   /api/users          # Create new user
PUT    /api/users/:id      # Update user
DELETE /api/users/:id      # Delete user
```

### Posts

```http
GET    /api/posts          # List all posts
GET    /api/posts/:id      # Get post by ID
POST   /api/posts          # Create new post
```

See [API Documentation](docs/api/) for detailed endpoint information.

## Configuration

Create a `.env` file in the root directory:

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb

# Authentication
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Format code
npm run format

# Build for production
npm run build

# Start production server
npm start
```

## Project Structure

```
my-api/
├── src/
│   ├── api/              # API routes and controllers
│   │   ├── users.ts
│   │   └── posts.ts
│   ├── middleware/       # Express middleware
│   │   ├── auth.ts
│   │   ├── errorHandler.ts
│   │   └── rateLimit.ts
│   ├── models/           # Data models
│   ├── services/         # Business logic
│   ├── utils/            # Utility functions
│   └── server.ts         # Application entry point
├── tests/                # Test files
├── docs/                 # Documentation
├── .env.example          # Environment template
├── package.json
└── tsconfig.json
```

## Testing

We maintain 95%+ test coverage:

```bash
# Run all tests
npm test

# Run specific test file
npm test -- users.test.ts

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Deployment

### Docker

```bash
# Build image
docker build -t my-api .

# Run container
docker run -p 3000:3000 --env-file .env my-api
```

### Docker Compose

```bash
docker-compose up -d
```

### Manual Deployment

```bash
# Build application
npm run build

# Start production server
NODE_ENV=production node dist/server.js
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Security

Found a security vulnerability? Please email security@example.com instead of opening a public issue.

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) file for details.

## Support

- 📖 [Documentation](docs/)
- 🐛 [Issue Tracker](https://github.com/user/my-api/issues)
- 💬 [Discussions](https://github.com/user/my-api/discussions)

## Acknowledgments

- Built with [Express.js](https://expressjs.com/)
- Database: [PostgreSQL](https://www.postgresql.org/)
- ORM: [Prisma](https://www.prisma.io/)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generated API Documentation (docs/api/users.md):

# Users API

## Overview

User management endpoints for creating, retrieving, updating, and deleting users.

Base URL: `/api/users`

## Endpoints

### List Users

```http
GET /api/users
```

Returns a paginated list of users.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| page | number | No | Page number (default: 1) |
| limit | number | No | Items per page (default: 20) |
| sort | string | No | Sort field (default: createdAt) |
| order | string | No | Sort order: asc or desc (default: desc) |

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/users?page=1&limit=10" \
  -H "Authorization: Bearer <token>"
```

**Example Response:**

```json
{
  "data": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "email": "user@example.com",
      "name": "John Doe",
      "role": "user",
      "createdAt": "2026-03-23T10:00:00Z",
      "updatedAt": "2026-03-23T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "pages": 5
  }
}
```

**Status Codes:**

- `200 OK` - Success
- `401 Unauthorized` - Missing or invalid token
- `500 Internal Server Error` - Server error

### Get User by ID

```http
GET /api/users/:id
```

Retrieves a single user by ID.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string (UUID) | Yes | User ID |

**Example Request:**

```bash
curl -X GET "http://localhost:3000/api/users/123e4567-e89b-12d3-a456-426614174000" \
  -H "Authorization: Bearer <token>"
```

**Example Response:**

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "email": "user@example.com",
  "name": "John Doe",
  "role": "user",
  "createdAt": "2026-03-23T10:00:00Z",
  "updatedAt": "2026-03-23T10:00:00Z"
}
```

**Status Codes:**

- `200 OK` - Success
- `404 Not Found` - User not found
- `401 Unauthorized` - Missing or invalid token

### Create User

```http
POST /api/users
```

Creates a new user.

**Request Body:**

```json
{
  "email": "newuser@example.com",
  "password": "SecurePass123!",
  "name": "Jane Smith",
  "role": "user"
}
```

**Validation Rules:**

- `email`: Valid email format, unique
- `password`: Min 8 chars, must contain uppercase, lowercase, number, special char
- `name`: Min 2 chars, max 100 chars
- `role`: One of: user, admin, moderator

**Example Response:**

```json
{
  "id": "789e0123-e89b-12d3-a456-426614174000",
  "email": "newuser@example.com",
  "name": "Jane Smith",
  "role": "user",
  "createdAt": "2026-03-23T11:30:00Z"
}
```

**Status Codes:**

- `201 Created` - User created successfully
- `400 Bad Request` - Validation error
- `409 Conflict` - Email already exists
- `401 Unauthorized` - Missing or invalid token

### Update User

```http
PUT /api/users/:id
```

Updates an existing user. Only the user themselves or an admin can update.

**Request Body:**

```json
{
  "name": "Updated Name",
  "email": "updated@example.com"
}
```

**Status Codes:**

- `200 OK` - User updated
- `400 Bad Request` - Validation error
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - User not found

### Delete User

```http
DELETE /api/users/:id
```

Soft deletes a user. Admin only.

**Status Codes:**

- `204 No Content` - User deleted
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - User not found

## Authentication

All endpoints require authentication via JWT token in Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

Get a token via POST /api/auth/login

## Rate Limiting

- 100 requests per 15 minutes per IP
- Returns `429 Too Many Requests` when exceeded

## Error Responses

All error responses follow this format:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": {
      "field": "email",
      "constraint": "required"
    }
  }
}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ANALYSIS
========

Coverage: 85% Complete

Missing Sections:
  - Architecture diagrams
  - Performance characteristics
  - Troubleshooting guide
  - Migration guides

Recommendations:
  1. Add architecture diagram to README
  2. Create troubleshooting.md for common issues
  3. Document database schema in docs/database.md
  4. Add deployment guides for major platforms
  5. Include example .env for all environments
```

## Documentation Process

1. **Analyze Structure**: Parse project files, understand architecture
2. **Extract Information**: Read code comments, function signatures, types
3. **Infer Behavior**: Understand what code does from implementation
4. **Generate Content**: Create structured documentation
5. **Add Examples**: Include realistic usage examples
6. **Format Output**: Apply consistent markdown formatting
7. **Validate Links**: Ensure all internal links work

## Documentation Standards

### README Must Include
- Clear project description
- Installation instructions
- Quick start guide
- Key features
- API overview
- Configuration
- Development setup
- Contributing guide
- License

### API Docs Must Include
- Endpoint descriptions
- Request/response examples
- Parameter documentation
- Status codes
- Error handling
- Authentication requirements
- Rate limiting info

### Code Comments Must Include
- Function purpose
- Parameter descriptions
- Return value description
- Usage examples
- Edge cases
- Related functions

## Integration

Works with:
- `/code-review` - Document identified patterns
- `/test-generator` - Document test coverage
- `/security-audit` - Document security measures

## Configuration

Options:
- `--type=readme|api|guides|all` - Documentation type
- `--format=markdown|html|pdf` - Output format
- `--template=minimal|standard|comprehensive` - Detail level
- `--examples` - Include code examples
- `--badges` - Add status badges to README

## Examples

### Example 1: New Project
```
/documentation-writer --template=comprehensive
```

Creates:
- README.md with full structure
- CONTRIBUTING.md
- LICENSE
- docs/ directory with guides

### Example 2: API Only
```
/documentation-writer --type=api
```

Generates comprehensive API reference from routes.

### Example 3: Update Existing
```
/documentation-writer --type=readme --update
```

Updates README.md while preserving custom sections.

## Notes

- Respects existing documentation (updates, doesn't replace)
- Follows project conventions (detects style from existing docs)
- Includes realistic examples, not placeholders
- SEO-optimized for documentation sites
- Supports multiple output formats
- Integrates with doc generators (TypeDoc, JSDoc, Sphinx)
- Can deploy to GitHub Pages, ReadTheDocs, etc.
