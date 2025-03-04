# Recommendation Service

This service generates recommendations for users based on their browsing and purchase history, integrating with RabbitMQ and MongoDB.

# Main Functions

# RabbitMQ Integration

-Consume User Events**: Listens for `user.created` and `user.preferences.updated` events.
-Publish Recommendations**: Sends recommendations to the `recommendations` queue.

# Recommendation Logic

- Generate Recommendations\*: Based on user's browsing activity and purchase history.
- Handle New Users\*: Creates user profiles in MongoDB.
- Handle Preferences Updates\*: Generates and sends updated recommendations.

# API Endpoints

- GET /recommendations/:userId\*: Get recommendations for a user.
- GET /users/:userId/browsing\*: Get browsing activity for a user.
- GET /users/:userId/purchases\*: Get purchase history for a user.
- POST /users/:userId/purchase\*: Add a purchase to user's history.
- POST /users/:userId/browse\*: Add browsing activity for a user.

# Monitoring

- Metrics: Exposes Prometheus metrics for RabbitMQ, operations, and message processing.
- Health Check: Includes RabbitMQ and queue status.
