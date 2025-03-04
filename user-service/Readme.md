# User Service API

This is a user management service with authentication, RabbitMQ integration, and metrics monitoring.

## API Endpoints

### Authentication

- **POST /register**: Register a new user.

  - Body: `{ name, email, password, preferences }`
  - Response: `{ id, name, email, preferences }`

- **POST /login**: Login and get a JWT token.
  - Body: `{ email, password }`
  - Response: `{ token, userId }`

### User Management

- **GET /users**: Get all users (public).

  - Response: `[{ id, name, email, preferences }]`

- **GET /users/:userId**: Get a specific user by ID.

  - Response: `{ id, name, email, preferences }`

- **PUT /user/:userId/preferences**: Update user preferences (protected).
  - Body: `{ preferences }`
  - Response: `{ id, name, email, preferences }`

### Admin

- **GET /admin/dlq-stats**: Get Dead Letter Queue statistics.

  - Response: `{ messageCount, consumerCount, lastChecked }`

- **POST /admin/process-dlq**: Manually process DLQ messages.
  - Body: `{ limit }`
  - Response: `{ success, message }`

### Monitoring

- **GET /metrics**: Prometheus metrics endpoint.
- **GET /health**: Health check endpoint.
  - Response: `{ status, details: { rabbitmq } }`

## Setup

1. Install dependencies: `npm install`
2. Set environment variables in `.env`:
   - `MONGODB_URI`
   - `RABBITMQ_URL`
   - `SECRET_KEY`
3. Start the server: `node server.js`

## Metrics

- RabbitMQ message publishing metrics.
- User operation counters.
- Dead Letter Queue metrics.

## RabbitMQ

- Dead Letter Queue (DLQ) support for failed messages.
- Automatic reconnection handling.
