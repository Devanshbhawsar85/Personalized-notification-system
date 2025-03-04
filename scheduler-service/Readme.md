# Scheduler Service

This service handles scheduled tasks like order updates and promotional notifications, integrating with RabbitMQ, MongoDB, and GraphQL.

## Main Functions

### Scheduled Tasks

- **Order Status Updates**: Daily at 9 AM UTC.
  - Fetches orders from MongoDB.
  - Sends updates to users who opted in via RabbitMQ.
- **Promotional Notifications**: Every Friday at noon UTC.
  - Fetches users who opted in for promotions via GraphQL.
  - Sends promotional messages via RabbitMQ.

### RabbitMQ Integration

- **Publish Messages**: Retries failed messages and sends to DLQ after max retries.
- **DLQ Handling**: Manually retry messages from DLQ via API.

### Monitoring

- **Queue Depth**: Monitors RabbitMQ queue depths every 5 minutes.
- **Metrics**: Exposes Prometheus metrics for task execution, RabbitMQ, and GraphQL requests.

### API Endpoints

- **POST /retry-dlq/:queueName**: Retry messages from DLQ.
- **GET /metrics**: Prometheus metrics.
- **GET /health**: Health check.
