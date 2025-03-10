# Microservices Architecture

A scalable microservices application with user management, notifications, scheduling, recommendations, and GraphQL API gateway.

## Architecture Overview

This project implements a modern microservices architecture with the following components:

- **User Service**: Handles user authentication, profiles, and management
- **Notification Service**: Manages user notifications across multiple channels
- **Scheduler Service**: Handles scheduled tasks and recurring jobs
- **Recommendation Service**: Provides personalized recommendations
- **GraphQL Gateway**: Unified API gateway for client applications

Supporting infrastructure:

- MongoDB for persistent data storage
- RabbitMQ for service communication
- Redis for caching and session management
- Prometheus & Grafana for monitoring

## Prerequisites

- Docker and Docker Compose
- Git
- Node.js (for local development)

## Getting Started

### Clone the Repository

```bash
git clone https://github.com/Devanshbhawsar85/Personalized-notification-system
cd Personalized-notification-system
```

### Starting the Services

Deploy all services with a single command:

```bash
docker-compose up -d
```

To check the status of all services:

```bash
docker-compose ps
```

## Service Endpoints

| Service                    | URL                           | Description                 |
| -------------------------- | ----------------------------- | --------------------------- |
| **GraphQL Gateway**        | http://localhost:5000/graphql | GraphQL API endpoint        |
| **User Service**           | http://localhost:4001         | User management API         |
| **Notification Service**   | http://localhost:4002         | Notification management API |
| **Recommendation Service** | http://localhost:4003         | Recommendation API          |
| **MongoDB**                | localhost:27017               | Database                    |
| **RabbitMQ Management**    | http://localhost:15672        | Message broker management   |
| **RabbitMQ Metrics**       | http://localhost:15692        | RabbitMQ Prometheus metrics |
| **Redis**                  | localhost:6379                | Cache server                |
| **Prometheus**             | http://localhost:9090         | Metrics collection          |
| **Grafana**                | http://localhost:3000         | Monitoring dashboards       |

## Development

### Service Structure

Each service follows a similar structure.

---

## Building Individual Services

To rebuild a specific service:

```bash
docker-compose build service-name
docker-compose up -d service-name
```

---

## Viewing Logs

View logs for all services:

```bash
docker-compose logs -f
```

Or for a specific service:

```bash
docker-compose logs -f service-name
```

---

## Monitoring

### Prometheus

Access Prometheus at [http://localhost:9090](http://localhost:9090) to view metrics.

### Grafana

1. Access Grafana at [http://localhost:3000](http://localhost:3000)
2. Log in with the credentials specified in your `.env` file
3. Add Prometheus as a data source (URL: `http://prometheus:9090`)
4. Import dashboards for RabbitMQ and application metrics

---

## Common Operations

### Scaling Services

To scale a service:

```bash
docker-compose up -d --scale service-name=3
```

### Restarting Services

```bash
docker-compose restart service-name
```

### Stopping the Application

```bash
docker-compose down
```

To also remove volumes (this will delete all data):

```bash
docker-compose down -v
```

## In order to test scheduler service i have set cron for 10 seconds for recommedation and promotions services so after each 10 seconds you will see new notifications due to these crons
