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
