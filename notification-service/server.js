require("dotenv").config();
const express = require("express");
const amqp = require("amqplib");
const mongoose = require("mongoose");
const Notification = require("./dbschema");
const cors = require("cors");
const promClient = require("prom-client");
const promBundle = require("express-prom-bundle");

const app = express();

const register = new promClient.Registry();

// metrics middleware
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  promClient: { register },
  autoregister: false,
});

app.use(metricsMiddleware);
app.use(cors());
app.use(express.json());

// RabbitMQ Config
const RABBITMQ_URL = process.env.RABBITMQ_URL;

const QUEUES = ["recommendations", "order_updates_queue"];
const USER_EXCHANGE = "user-events";
const DEAD_LETTER_EXCHANGE = "dead-letter-exchange";
const DEAD_LETTER_QUEUE = "failed-messages";

const messageProcessCounter = new promClient.Counter({
  name: "notification_service_messages_processed_total",
  help: "Total number of messages processed",
  labelNames: ["queue", "event_type", "status"],
  registers: [register],
});

const messageProcessDuration = new promClient.Histogram({
  name: "notification_service_message_process_duration_seconds",
  help: "Duration of message processing operations in seconds",
  labelNames: ["queue", "event_type"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

const rabbitmqConnectionCounter = new promClient.Counter({
  name: "notification_service_rabbitmq_connection_attempts_total",
  help: "Total number of RabbitMQ connection attempts",
  labelNames: ["status"],
  registers: [register],
});

const notificationOperationsCounter = new promClient.Counter({
  name: "notification_service_operations_total",
  help: "Count of notification operations",
  labelNames: ["operation", "status"],
  registers: [register],
});

const activeConsumersGauge = new promClient.Gauge({
  name: "notification_service_active_consumers",
  help: "Number of active message consumers",
  labelNames: ["queue"],
  registers: [register],
});

//metrics for queue monitoring
const queueDepthGauge = new promClient.Gauge({
  name: "notification_service_queue_depth",
  help: "Number of messages in the queue",
  labelNames: ["queue"],
  registers: [register],
});

const deadLetterQueueCounter = new promClient.Counter({
  name: "notification_service_dead_letter_messages_total",
  help: "Total number of messages sent to dead letter queue",
  labelNames: ["source_queue", "reason"],
  registers: [register],
});

const deliveryRetryCounter = new promClient.Counter({
  name: "notification_service_message_delivery_retries_total",
  help: "Total number of message delivery retry attempts",
  labelNames: ["queue", "event_type"],
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

// MongoDB Connection
async function connectDB() {
  try {
    rabbitmqConnectionCounter.inc({ status: "db_attempt" });
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB");
    rabbitmqConnectionCounter.inc({ status: "db_success" });
  } catch (error) {
    rabbitmqConnectionCounter.inc({ status: "db_failure" });
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

// Message Handlers
async function handleNewRecommendation(data) {
  try {
    await new Notification({
      userId: data.userId || data.id || data._id,
      type: "recommendation",
      content: data.content,
    }).save();

    console.log(`Recommendation notification created for user ${data.userId}`);
    messageProcessCounter.inc({
      queue: "recommendations",
      event_type: "NEW_RECOMMENDATION",
      status: "success",
    });
  } catch (error) {
    console.error("Error handling recommendation:", error);
    messageProcessCounter.inc({
      queue: "recommendations",
      event_type: "NEW_RECOMMENDATION",
      status: "error",
    });
    throw error;
  }
}

async function handleOrderStatusUpdate(data) {
  try {
    const content = `Your order ${data.orderId} status has been updated to ${data.status}.`;
    await new Notification({
      userId: data.userId || data.id || data._id,
      type: "order_update",
      content,
    }).save();

    console.log(`Order update notification created for user ${data.userId}`);
    messageProcessCounter.inc({
      queue: "order_updates_queue",
      event_type: "ORDER_STATUS_UPDATE",
      status: "success",
    });
  } catch (error) {
    console.error("Error handling order update:", error);
    messageProcessCounter.inc({
      queue: "order_updates_queue",
      event_type: "ORDER_STATUS_UPDATE",
      status: "error",
    });
    throw error;
  }
}

async function handleUserCreated(data) {
  try {
    await new Notification({
      userId: data.id || data._id || data.userId,
      type: "welcome",
      content: `Welcome to our platform, ${data.name || "user"}!`,
    }).save();

    console.log(
      `Welcome notification created for new user ${data.id || data._id}`
    );
    messageProcessCounter.inc({
      queue: USER_EXCHANGE,
      event_type: "user.created",
      status: "success",
    });
  } catch (error) {
    console.error("Error handling user created:", error);
    messageProcessCounter.inc({
      queue: USER_EXCHANGE,
      event_type: "user.created",
      status: "error",
    });
    throw error;
  }
}

async function handleUserPreferencesUpdated(data) {
  try {
    await new Notification({
      userId: data.userId || data.id || data._id,
      type: "preferences_update",
      content: "Your preferences have been updated successfully.",
    }).save();

    console.log(
      `Preferences update notification created for user ${
        data.userId || data.id || data._id
      }`
    );
    messageProcessCounter.inc({
      queue: USER_EXCHANGE,
      event_type: "user.preferences.updated",
      status: "success",
    });
  } catch (error) {
    console.error("Error handling preferences update:", error);
    messageProcessCounter.inc({
      queue: USER_EXCHANGE,
      event_type: "user.preferences.updated",
      status: "error",
    });
    throw error;
  }
}

// Process message with retry capability
async function processMessage(msg, routingKey, channel, maxRetries = 3) {
  let queueName;
  let eventType;

  if (routingKey) {
    queueName = USER_EXCHANGE;
    eventType = routingKey;
  } else {
    // For direct queue messages
    queueName = msg.fields.exchange || msg.fields.routingKey || "direct_queue";
    eventType = "unknown";
  }

  //  timer for this message processing
  const timer = messageProcessDuration.startTimer({
    queue: queueName,
    event_type: eventType,
  });

  let retryCount = 0;
  let success = false;

  const headers = msg.properties.headers || {};

  if (headers.retryCount !== undefined) {
    retryCount = headers.retryCount;
  }

  try {
    var content = msg.content.toString();
    console.log("Processing message with routing key:", routingKey || "N/A");

    const message = JSON.parse(content);
    console.log("Parsed message content:", JSON.stringify(message, null, 2));

    if (message.event) {
      eventType = message.event;
    }

    if (message.event === "NEW_RECOMMENDATION") {
      await handleNewRecommendation(message.data);
    } else if (message.event === "ORDER_STATUS_UPDATE") {
      await handleOrderStatusUpdate(message.data);
    } else if (routingKey === "user.created") {
      if (!message.name) {
        message.name = "new user";
      }
      await handleUserCreated(message);
    } else if (routingKey === "user.preferences.updated") {
      await handleUserPreferencesUpdated(message);
    } else {
      console.warn(`Unhandled event: ${routingKey || message.event}`);
      messageProcessCounter.inc({
        queue: queueName,
        event_type: eventType || "unknown",
        status: "unhandled",
      });

      await sendToDeadLetterQueue(
        channel,
        msg,
        message,
        "unhandled_event_type"
      );

      success = true;
    }

    success = true;

    timer();
  } catch (error) {
    timer();
    console.error("Error processing message:", error);
    console.error(
      "Message content that caused the error:",
      msg.content.toString()
    );
    messageProcessCounter.inc({
      queue: queueName,
      event_type: eventType || "unknown",
      status: "error",
    });

    // retry logic
    if (retryCount < maxRetries) {
      deliveryRetryCounter.inc({
        queue: queueName,
        event_type: eventType || "unknown",
      });

      // Schedule retry with exponential backoff
      const delay = Math.pow(2, retryCount) * 1000; // 2^retryCount seconds

      setTimeout(() => {
        try {
          console.log(
            `Retrying message processing (attempt ${retryCount + 1})`
          );

          const updatedHeaders = { ...headers, retryCount: retryCount + 1 };

          channel.publish("", queueName, msg.content, {
            persistent: true,
            headers: updatedHeaders,
          });
        } catch (err) {
          console.error("Failed to schedule retry:", err);
          // If retry scheduling fails, sending to dead letter queue
          sendToDeadLetterQueue(
            channel,
            msg,
            JSON.parse(content),
            "retry_failed"
          );
        }
      }, delay);

      // Acknowledge the original message since we've handled it
      // (by scheduling a retry)
      return true;
    } else {
      // Max retries exceeded, send to dead letter queue
      await sendToDeadLetterQueue(
        channel,
        msg,
        JSON.parse(content),
        "max_retries_exceeded"
      );
      return true; // Signal that we've handled this message by sending to DLQ
    }
  }

  return success;
}

// Function to send messages to dead letter queue
async function sendToDeadLetterQueue(
  channel,
  originalMsg,
  messageContent,
  reason
) {
  try {
    const queueName = originalMsg.fields.routingKey || "unknown_queue";

    const deadLetterMsg = {
      original: messageContent,
      meta: {
        reason: reason,
        timestamp: new Date().toISOString(),
        originalQueue: queueName,
        headers: originalMsg.properties.headers,
      },
    };

    // Incrementing dead letter counter
    deadLetterQueueCounter.inc({
      source_queue: queueName,
      reason: reason,
    });

    // Publishing to dead letter exchange
    await channel.publish(
      DEAD_LETTER_EXCHANGE,
      "failed",
      Buffer.from(JSON.stringify(deadLetterMsg)),
      { persistent: true }
    );

    console.log(`Message sent to dead letter queue. Reason: ${reason}`);
  } catch (error) {
    console.error("Failed to send message to dead letter queue:", error);
  }
}

// Function to check queue stats
async function checkQueueStats(channel) {
  try {
    // Check queue depths
    for (const queue of [...QUEUES, DEAD_LETTER_QUEUE]) {
      const queueInfo = await channel.assertQueue(queue, { durable: true });
      queueDepthGauge.set({ queue }, queueInfo.messageCount);

      console.log(`Queue ${queue}: ${queueInfo.messageCount} messages`);
    }
  } catch (error) {
    console.error("Error checking queue stats:", error);
  }
}

// RabbitMQ Consumer Setup
async function startConsumer() {
  await connectDB();

  try {
    rabbitmqConnectionCounter.inc({ status: "mq_attempt" });
    const conn = await amqp.connect(RABBITMQ_URL);
    const channel = await conn.createChannel();

    rabbitmqConnectionCounter.inc({ status: "mq_success" });

    await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", {
      durable: true,
    });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, "failed");

    for (const queue of QUEUES) {
      await channel.assertQueue(queue, { durable: true });
      channel.consume(queue, async (msg) => {
        if (msg) {
          const processed = await processMessage(msg, null, channel);
          if (processed) {
            channel.ack(msg);
          }
        }
      });

      activeConsumersGauge.inc({ queue });
    }

    console.log(`Consuming from queues: ${QUEUES.join(", ")}`);

    // Setup user events exchange consumer
    await channel.assertExchange(USER_EXCHANGE, "topic", { durable: true });
    const q = await channel.assertQueue("", { exclusive: true });

    // Bind to specific user event routing keys
    await channel.bindQueue(q.queue, USER_EXCHANGE, "user.created");
    await channel.bindQueue(q.queue, USER_EXCHANGE, "user.preferences.updated");

    channel.consume(q.queue, async (msg) => {
      if (msg) {
        const processed = await processMessage(
          msg,
          msg.fields.routingKey,
          channel
        );
        if (processed) {
          channel.ack(msg);
        }
      }
    });

    // active consumer gauge for the exchange
    activeConsumersGauge.inc({ queue: USER_EXCHANGE });

    console.log(`Consuming from exchange: ${USER_EXCHANGE}`);

    conn.on("error", (err) => {
      console.error("RabbitMQ connection error:", err);
      rabbitmqConnectionCounter.inc({ status: "mq_error" });

      QUEUES.forEach((queue) => {
        activeConsumersGauge.dec({ queue });
      });
      activeConsumersGauge.dec({ queue: USER_EXCHANGE });
    });

    channel.on("error", (err) => {
      console.error("RabbitMQ channel error:", err);
    });

    setInterval(() => checkQueueStats(channel), 30000); // Check every 30 seconds

    return { conn, channel };
  } catch (error) {
    rabbitmqConnectionCounter.inc({ status: "mq_failure" });
    console.error("Failed to connect to RabbitMQ:", error);
    process.exit(1);
  }
}

// Dead letter queue monitoring API endpoint
app.get("/monitoring/failed-messages", async (req, res) => {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    // Get queue info
    const queueInfo = await channel.assertQueue(DEAD_LETTER_QUEUE, {
      durable: true,
    });

    // Get a sample of dead letter messages (limited to 10)
    const messages = [];
    for (let i = 0; i < Math.min(10, queueInfo.messageCount); i++) {
      const msg = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
      if (msg) {
        const content = JSON.parse(msg.content.toString());
        messages.push(content);
        // Acknowledge the message so we don't remove it from the queue
        channel.nack(msg, false, true);
      } else {
        break;
      }
    }

    await channel.close();
    await connection.close();

    res.status(200).json({
      queueDepth: queueInfo.messageCount,
      consumerCount: queueInfo.consumerCount,
      sampleMessages: messages,
    });
  } catch (error) {
    console.error("Error fetching failed messages:", error);
    res.status(500).json({ error: error.message });
  }
});

// Queue monitoring endpoint
app.get("/monitoring/queues", async (req, res) => {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    const queueStats = {};

    // Get stats for all queues
    for (const queue of [...QUEUES, DEAD_LETTER_QUEUE]) {
      const queueInfo = await channel.assertQueue(queue, { durable: true });
      queueStats[queue] = {
        messageCount: queueInfo.messageCount,
        consumerCount: queueInfo.consumerCount,
      };
    }

    await channel.close();
    await connection.close();

    res.status(200).json({
      queues: queueStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching queue stats:", error);
    res.status(500).json({ error: error.message });
  }
});

startConsumer().catch((error) => {
  console.error("Failed to start consumer:", error);
  process.exit(1);
});

// API Endpoints
// Mark as read
app.patch("/notifications/read/:id", async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(req.params.id, {
      read: true,
    });
    if (notification) {
      notificationOperationsCounter.inc({
        operation: "mark_read",
        status: "success",
      });
      res.status(200).json({ message: "Notification marked as read" });
    } else {
      notificationOperationsCounter.inc({
        operation: "mark_read",
        status: "not_found",
      });
      res.status(404).json({ message: "Notification not found" });
    }
  } catch (error) {
    notificationOperationsCounter.inc({
      operation: "mark_read",
      status: "error",
    });
    res.status(500).json({ error: error.message });
  }
});

// Fetch unread notifications for a user
app.get("/notifications/unread/:userId", async (req, res) => {
  try {
    const notifications = await Notification.find({
      userId: req.params.userId,
      read: false,
    });
    notificationOperationsCounter.inc({
      operation: "fetch_unread",
      status: "success",
    });
    res.status(200).json(notifications);
  } catch (error) {
    notificationOperationsCounter.inc({
      operation: "fetch_unread",
      status: "error",
    });
    res.status(500).json({ error: error.message });
  }
});

// Get notification by ID
app.get("/notifications/:id", async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (notification) {
      notificationOperationsCounter.inc({
        operation: "get_by_id",
        status: "success",
      });
      res.status(200).json(notification);
    } else {
      notificationOperationsCounter.inc({
        operation: "get_by_id",
        status: "not_found",
      });
      res.status(404).json({ message: "Notification not found" });
    }
  } catch (error) {
    notificationOperationsCounter.inc({
      operation: "get_by_id",
      status: "error",
    });
    res.status(500).json({ error: error.message });
  }
});

// Get all notifications for a user
app.get("/users/notifications/:userId", async (req, res) => {
  try {
    const notifications = await Notification.find({
      userId: req.params.userId,
    }).sort({ createdAt: -1 });
    notificationOperationsCounter.inc({
      operation: "get_all_for_user",
      status: "success",
    });
    res.status(200).json(notifications);
  } catch (error) {
    notificationOperationsCounter.inc({
      operation: "get_all_for_user",
      status: "error",
    });
    res.status(500).json({ error: error.message });
  }
});

// Add health check endpoint for monitoring
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP" });
});

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Metrics available at http://localhost:${PORT}/metrics`);
});
