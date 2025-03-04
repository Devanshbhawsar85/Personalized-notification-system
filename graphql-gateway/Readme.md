## GraphQL Gateway

This is a GraphQL Gateway service that integrates multiple microservices (User, Notification, and Recommendation) into a single GraphQL API. It also includes Redis caching for improved performance.

# Features

User Management: Fetch user details, register new users, and update user preferences.

Notifications: Retrieve user notifications and mark them as read.
Recommendations: Get personalized recommendations for users.
Caching: Uses Redis to cache frequently accessed data.
Authentication: Supports token-based authentication for secure operations.

# Queries

## User Queries

1. getUser – Retrieve details of a specific user by ID.
2. getUsers – Fetch all registered users.
3. getUserWithAllData – Get user details along with preferences, 4. notifications, recommendations, browsing activity, and purchase history.

## Notification Queries

1. getUserNotifications – Get all notifications for a user (option to filter unread only).
2. getNotification – Retrieve details of a specific notification.
   Recommendation Queries
3. getUserRecommendations – Fetch personalized recommendations for a user.
   User Activity Queries
4. getUserBrowsingActivity – Retrieve a user’s browsing history (products viewed).
5. getUserPurchaseHistory – Fetch a user’s past purchases.

## System Monitoring Queries

1. getDLQStats – Get statistics on messages stuck in the Dead Letter Queue (DLQ).
2. getServiceHealth – Fetch system health status, including services like RabbitMQ.
3. getFailedMessages – Retrieve failed messages along with metadata (reasons, timestamps, headers).
4. getQueueStats – Get statistics about system queues, including queue depth and consumer count.

## Mutations

Authentication & User Management

1. registerUser – Register a new user with email, name, and preferences.
2. login – Authenticate a user and generate a token.
3. updateUserPreferences – Modify a user’s notification and recommendation settings.
4. Notification Mutations
5. markNotificationAsRead – Mark a notification as read.

## User Activity Mutations

1. addPurchase – Add a purchase to a user's history.
2. addBrowsingActivity – Record a product in a user’s browsing history.

## System Administration Mutations

1. processDLQ – Process and retry messages from the Dead Letter Queue.

Quick Setup
Clone the Repository:

#bash

# git clone <repository-url>

cd <repository-folder>
Install Dependencies:

# npm install

Set Up Redis:

# Start the Server:

node server.js

Access the GraphQL Playground:
Open your browser and navigate to http://localhost:4000/graphql.
