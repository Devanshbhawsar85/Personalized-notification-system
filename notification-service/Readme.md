# Notification Service

This service handles notifications for users, consuming messages from RabbitMQ and storing them in MongoDB. It supports retries, dead-letter queues, and monitoring.

#Main Functions

# RabbitMQ Integration

- Consume Messages: Listens to `recommendations`, `order_updates_queue`, and `user-events` exchanges.
- Dead Letter Queue: Handles failed messages and retries.
  -Retry Logic: Implements exponential backoff for failed message processing.

# Notification Handling

-Process Messages**: Handles `NEW_RECOMMENDATION`, `ORDER_STATUS_UPDATE`, `user.created`, and `user.preferences.updated` events.
-Store Notifications**: Saves notifications in MongoDB.

# Monitoring

-Metrics**: Tracks message processing, RabbitMQ connections, and queue depths.
-Health Check**: Provides a `/health` endpoint for monitoring.

# API Endpoints

- PATCH /notifications/read/:id\*\*: Mark a notification as read.
- GET /notifications/unread/:userId\*\*: Fetch unread notifications for a user.
- GET /notifications/:id\*\*: Get a notification by ID.
- GET /users/notifications/:userId\*\*: Get all notifications for a user.
- GET /monitoring/failed-messages\*\*: Fetch dead-letter queue stats.
- GET /monitoring/queues\*\*: Get queue statistics.

# Setup

1. Install dependencies: `npm install`
2. Set environment variables in `.env`:
   - `MONGODB_URI`
   - `RABBITMQ_URL`
3. Start the server: `node server.js`
