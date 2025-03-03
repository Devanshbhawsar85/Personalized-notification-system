const cron = require("node-cron");
const axios = require("axios");
const mongoose = require("mongoose");
const amqp = require("amqplib");
const express = require("express");
const promClient = require("prom-client");
const promBundle = require("express-prom-bundle");
require("dotenv").config();

const app = express();
const PORT = 3004; // Assuming port 3004 for scheduler service

// Create metric registry
const register = new promClient.Registry();

// Configure metrics middleware
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  promClient: { register },
  autoregister: false,
});

app.use(metricsMiddleware);
app.use(express.json());

// Create custom metrics
const messagePublishCounter = new promClient.Counter({
  name: "scheduler_service_rabbitmq_messages_published_total",
  help: "Total number of messages published to RabbitMQ",
  labelNames: ["queue", "message_type"],
  registers: [register],
});

const messagePublishDuration = new promClient.Histogram({
  name: "scheduler_service_rabbitmq_publish_duration_seconds",
  help: "Duration of RabbitMQ publish operations in seconds",
  labelNames: ["queue"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

const taskExecutionCounter = new promClient.Counter({
  name: "scheduler_service_task_executions_total",
  help: "Total number of scheduled task executions",
  labelNames: ["task_name", "status"],
  registers: [register],
});

const taskDurationHistogram = new promClient.Histogram({
  name: "scheduler_service_task_duration_seconds",
  help: "Duration of scheduled task execution in seconds",
  labelNames: ["task_name"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

const rabbitmqConnectionCounter = new promClient.Counter({
  name: "scheduler_service_rabbitmq_connection_attempts_total",
  help: "Total number of RabbitMQ connection attempts",
  labelNames: ["status"],
  registers: [register],
});

const graphqlRequestCounter = new promClient.Counter({
  name: "scheduler_service_graphql_requests_total",
  help: "Total number of GraphQL API requests",
  labelNames: ["query_type", "status"],
  registers: [register],
});

// Add queue monitoring metrics
const queueDepthGauge = new promClient.Gauge({
  name: "scheduler_service_rabbitmq_queue_depth",
  help: "Current number of messages in RabbitMQ queues",
  labelNames: ["queue"],
  registers: [register],
});

const dlqMessageCounter = new promClient.Counter({
  name: "scheduler_service_dlq_messages_total",
  help: "Total number of messages sent to Dead Letter Queue",
  labelNames: ["source_queue", "reason"],
  registers: [register],
});

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP" });
});

const MONGODB_URI = process.env.MONGODB_URI;
const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT || "http://localhost:4000/graphql";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost";
const MAX_RETRY_COUNT = 3; // Maximum number of delivery attempts before sending to DLQ

// Connect to order-specific database
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("Connected to Orders Database.");
    // Only start the scheduler after successful DB connection
    setupScheduler();
    startServer();
    // Start queue monitoring
    setupQueueMonitoring();
  })
  .catch((error) => {
    console.error("Error connecting to Orders Database:", error);
    process.exit(1);
  });

// Schema for order
const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId },
  status: String,
});

const Order = mongoose.model("Order", orderSchema);

// Function to fetch user data from GraphQL gateway
const fetchUserByIdFromGraphQL = async (userId) => {
  const query = `
    query {
      getUser(id: "${userId}") {
        id
        name
        email
        preferences {
          order_updates
        }
      }
    }
  `;

  try {
    graphqlRequestCounter.inc({ query_type: "get_user", status: "attempt" });
    const response = await axios.post(GRAPHQL_ENDPOINT, { query });
    if (response.data.errors) {
      graphqlRequestCounter.inc({ query_type: "get_user", status: "error" });
      throw new Error(response.data.errors[0].message);
    }
    graphqlRequestCounter.inc({ query_type: "get_user", status: "success" });
    return response.data.data.getUser;
  } catch (error) {
    graphqlRequestCounter.inc({ query_type: "get_user", status: "error" });
    console.error(`Error fetching user ${userId} from GraphQL:`, error.message);
    return null;
  }
};

// Function to fetch all users who opted in for promotions
const fetchUsersForPromotions = async () => {
  const query = `
    query {
      getUsers {
        id
        name
        email
        preferences {
          promotions
        }
      }
    }
  `;

  try {
    graphqlRequestCounter.inc({ query_type: "get_users", status: "attempt" });
    const response = await axios.post(GRAPHQL_ENDPOINT, { query });
    if (response.data.errors) {
      graphqlRequestCounter.inc({ query_type: "get_users", status: "error" });
      throw new Error(response.data.errors[0].message);
    }

    // Filter users who have opted in for promotions
    const users = response.data.data.getUsers || [];
    const filteredUsers = users.filter(
      (user) => user.preferences?.promotions === true
    );

    graphqlRequestCounter.inc({ query_type: "get_users", status: "success" });
    return filteredUsers;
  } catch (error) {
    graphqlRequestCounter.inc({ query_type: "get_users", status: "error" });
    console.error("Error fetching users for promotions:", error.message);
    return [];
  }
};

// Function to fetch all orders from Orders database
const fetchAllOrders = async () => {
  try {
    // Find all orders regardless of status
    return await Order.find({});
  } catch (error) {
    console.error("Error fetching orders from Orders database:", error);
    return [];
  }
};

// Function to publish message to DLQ with reason
const publishToDLQ = async (sourceQueue, message, reason) => {
  const dlqName = `${sourceQueue}_dlq`;
  let connection;
  let channel;

  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    await channel.assertQueue(dlqName, { durable: true });

    // Add retry count, original queue, timestamp, and failure reason to the message
    const dlqMessage = {
      ...message,
      _meta: {
        originalQueue: sourceQueue,
        failedAt: new Date().toISOString(),
        reason: reason,
      },
    };

    channel.sendToQueue(dlqName, Buffer.from(JSON.stringify(dlqMessage)));

    dlqMessageCounter.inc({
      source_queue: sourceQueue,
      reason: reason,
    });

    console.log(`Message sent to DLQ ${dlqName}:`, {
      originalEvent: message.event,
      reason: reason,
    });
  } catch (error) {
    console.error(`Error publishing to DLQ ${dlqName}:`, error);
  } finally {
    if (channel)
      setTimeout(() => {
        channel.close();
      }, 500);
    if (connection)
      setTimeout(() => {
        connection.close();
      }, 1000);
  }
};

// Function to publish message to RabbitMQ with metrics and DLQ support
const publishToQueue = async (queue, message, retryCount = 0) => {
  let connection;
  let channel;

  const timer = messagePublishDuration.startTimer({ queue });
  rabbitmqConnectionCounter.inc({ status: "attempt" });

  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Set up the main queue
    await channel.assertQueue(queue, {
      durable: true,
    });

    // Add retry count to message headers
    const messageWithRetry = {
      ...message,
      _meta: {
        retryCount: retryCount,
        timestamp: new Date().toISOString(),
      },
    };

    channel.sendToQueue(queue, Buffer.from(JSON.stringify(messageWithRetry)));

    rabbitmqConnectionCounter.inc({ status: "success" });
    messagePublishCounter.inc({
      queue,
      message_type: message.event,
    });

    console.log(`Message published to queue ${queue}:`, message);
    return true;
  } catch (error) {
    rabbitmqConnectionCounter.inc({ status: "failure" });
    console.error("Error publishing to queue:", error);

    // Handle retry or send to DLQ
    if (retryCount < MAX_RETRY_COUNT) {
      console.log(
        `Retrying message publish to ${queue}, attempt ${
          retryCount + 1
        } of ${MAX_RETRY_COUNT}`
      );
      // Wait briefly before retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await publishToQueue(queue, message, retryCount + 1);
    } else {
      // Move to DLQ after max retries
      await publishToDLQ(queue, message, "max_retries_exceeded");
      return false;
    }
  } finally {
    timer(); // End the timer

    if (channel)
      setTimeout(() => {
        channel.close();
      }, 500);
    if (connection)
      setTimeout(() => {
        connection.close();
      }, 1000);
  }
};

// Function to send order status updates
const sendOrderStatusUpdates = async () => {
  const taskTimer = taskDurationHistogram.startTimer({
    task_name: "order_status_updates",
  });
  taskExecutionCounter.inc({
    task_name: "order_status_updates",
    status: "start",
  });

  console.log("Starting order status update process...");
  try {
    const orders = await fetchAllOrders();
    console.log(`Found ${orders.length} orders to process`);

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const order of orders) {
      const userId = order.userId;
      if (!userId) {
        console.log("Order missing userId, skipping");
        skippedCount++;
        continue;
      }

      // Fetch user details from GraphQL gateway (which gets it from user service)
      const user = await fetchUserByIdFromGraphQL(userId);

      if (!user) {
        console.log(`User ${userId} not found, skipping order update`);
        skippedCount++;
        continue;
      }

      if (user.preferences?.order_updates) {
        try {
          const message = {
            event: "ORDER_STATUS_UPDATE",
            data: {
              userId: user.id,
              userEmail: user.email,
              userName: user.name,
              orderId: order._id.toString(),
              status: order.status,
              timestamp: new Date().toISOString(),
            },
          };

          const publishResult = await publishToQueue(
            "order_updates_queue",
            message
          );
          if (publishResult) {
            console.log(`Order update notification queued for user ${userId}`);
            successCount++;
          } else {
            console.log(`Order update sent to DLQ for user ${userId}`);
            errorCount++;
          }
        } catch (error) {
          console.error(
            `Error queuing order update for user ${userId}:`,
            error.message
          );
          errorCount++;
        }
      } else {
        console.log(`User ${userId} has opted out of order updates, skipping`);
        skippedCount++;
      }
    }

    console.log("Order status update process completed");
    console.log(
      `Results: ${successCount} successful, ${errorCount} errors, ${skippedCount} skipped`
    );

    taskExecutionCounter.inc({
      task_name: "order_status_updates",
      status: errorCount > 0 ? "completed_with_errors" : "success",
    });
  } catch (error) {
    console.error("Error in order status updates process:", error);
    taskExecutionCounter.inc({
      task_name: "order_status_updates",
      status: "failed",
    });
  } finally {
    taskTimer(); // End the timer
  }
};

// Function to send promotional notifications
const sendPromotionalNotifications = async () => {
  const taskTimer = taskDurationHistogram.startTimer({
    task_name: "promotional_notifications",
  });
  taskExecutionCounter.inc({
    task_name: "promotional_notifications",
    status: "start",
  });

  console.log("Starting promotional notification process...");

  try {
    const users = await fetchUsersForPromotions();
    console.log(`Found ${users.length} users who opted in for promotions`);

    let successCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        const message = {
          event: "NEW_RECOMMENDATION",
          data: {
            userId: user.id,
            userEmail: user.email,
            userName: user.name,
            content: "Check out our latest promotion!",
            timestamp: new Date().toISOString(),
          },
        };

        const publishResult = await publishToQueue("recommendations", message);
        if (publishResult) {
          console.log(`Promotional notification queued for user ${user.id}`);
          successCount++;
        } else {
          console.log(
            `Promotional notification sent to DLQ for user ${user.id}`
          );
          errorCount++;
        }
      } catch (error) {
        console.error(
          `Error sending promotion to user ${user.id}:`,
          error.message
        );
        errorCount++;
      }
    }

    console.log("Promotional notification process completed");
    console.log(`Results: ${successCount} successful, ${errorCount} errors`);

    taskExecutionCounter.inc({
      task_name: "promotional_notifications",
      status: errorCount > 0 ? "completed_with_errors" : "success",
    });
  } catch (error) {
    console.error("Error in promotional notifications:", error);
    taskExecutionCounter.inc({
      task_name: "promotional_notifications",
      status: "failed",
    });
  } finally {
    taskTimer(); // End the timer
  }
};

// Function to check RabbitMQ queue depths for monitoring
const monitorQueueDepths = async () => {
  let connection;
  let channel;

  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Define the queues to monitor
    const queues = [
      "order_updates_queue",
      "recommendations",
      "order_updates_queue_dlq",
      "recommendations_dlq",
    ];

    for (const queue of queues) {
      try {
        // Assert the queue to make sure it exists
        const queueInfo = await channel.assertQueue(queue, { durable: true });

        // Get message count and update gauge
        queueDepthGauge.set({ queue }, queueInfo.messageCount);

        console.log(`Queue ${queue} depth: ${queueInfo.messageCount} messages`);
      } catch (error) {
        console.error(`Error checking queue ${queue}:`, error);
      }
    }
  } catch (error) {
    console.error("Error connecting to RabbitMQ for monitoring:", error);
  } finally {
    if (channel)
      setTimeout(() => {
        channel.close();
      }, 500);
    if (connection)
      setTimeout(() => {
        connection.close();
      }, 1000);
  }
};

// Set up queue monitoring schedule
const setupQueueMonitoring = () => {
  // Monitor queues every 5 minutes
  cron.schedule("*/5 * * * *", () => {
    console.log("Running queue monitoring check");
    monitorQueueDepths().catch((err) => {
      console.error("Queue monitoring failed:", err);
    });
  });

  // Run initial check
  monitorQueueDepths().catch((err) => {
    console.error("Initial queue monitoring failed:", err);
  });
};

// Schedule tasks
const setupScheduler = () => {
  // Order status updates daily at 9 AM UTC
  cron.schedule(
    "0 9 * * *",
    () => {
      console.log("Running scheduled task: Order status updates");
      sendOrderStatusUpdates().catch((err) => {
        console.error("Scheduled order updates failed:", err);
      });
    },
    { timezone: "UTC" }
  );

  // Promotional notifications every Friday at noon UTC
  cron.schedule(
    "0 12 * * 5",
    () => {
      console.log("Running scheduled task: Promotional notifications");
      sendPromotionalNotifications().catch((err) => {
        console.error("Scheduled promotional notifications failed:", err);
      });
    },
    { timezone: "UTC" }
  );

  console.log("Scheduler started and tasks configured");
};

// Add a new endpoint to manually retry messages from DLQ
app.post("/retry-dlq/:queueName", async (req, res) => {
  const dlqName = req.params.queueName;
  if (!dlqName.endsWith("_dlq")) {
    return res
      .status(400)
      .json({ error: "Invalid DLQ name. Must end with _dlq" });
  }

  const targetQueue = dlqName.replace("_dlq", "");
  let connection;
  let channel;
  let retryCount = 0;
  let errorCount = 0;

  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Set up to get one message at a time
    await channel.prefetch(1);

    const consumeResult = await channel.consume(
      dlqName,
      async (msg) => {
        if (msg) {
          try {
            const message = JSON.parse(msg.content.toString());

            // Publish back to original queue
            const originalQueue = message._meta?.originalQueue || targetQueue;
            delete message._meta; // Remove metadata before republishing

            const publishResult = await publishToQueue(originalQueue, message);
            if (publishResult) {
              retryCount++;
            } else {
              errorCount++;
            }

            // Acknowledge the message from DLQ
            channel.ack(msg);
          } catch (error) {
            console.error("Error processing DLQ message:", error);
            // Reject the message and requeue
            channel.nack(msg, false, true);
            errorCount++;
          }
        }
      },
      { noAck: false }
    );

    // Wait a bit to process messages
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Cancel the consumer
    if (consumeResult) {
      await channel.cancel(consumeResult.consumerTag);
    }

    res.json({
      success: true,
      retried: retryCount,
      errors: errorCount,
      queue: targetQueue,
    });
  } catch (error) {
    console.error("Error retrying DLQ messages:", error);
    res
      .status(500)
      .json({ error: "Failed to retry DLQ messages", details: error.message });
  } finally {
    if (channel)
      setTimeout(() => {
        channel.close();
      }, 500);
    if (connection)
      setTimeout(() => {
        connection.close();
      }, 1000);
  }
});

// Start the Express server
const startServer = () => {
  app.listen(PORT, () => {
    console.log(`Scheduler service running on http://localhost:${PORT}`);
    console.log(`Metrics available at http://localhost:${PORT}/metrics`);
  });
};

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully");
  await mongoose.connection.close();
  console.log("MongoDB connection closed.");
  process.exit(0);
});

// For testing purposes, uncomment these lines
// sendOrderStatusUpdates();
// sendPromotionalNotifications();
