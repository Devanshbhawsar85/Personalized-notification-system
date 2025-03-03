const express = require("express");
const mongoose = require("mongoose");
const amqp = require("amqplib");
const promClient = require("prom-client");
const promBundle = require("express-prom-bundle");
require("dotenv").config();

const app = express();
const PORT = 3003;

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
  name: "recommendation_service_rabbitmq_messages_published_total",
  help: "Total number of messages published to RabbitMQ",
  labelNames: ["queue"],
  registers: [register],
});

const messageConsumeCounter = new promClient.Counter({
  name: "recommendation_service_rabbitmq_messages_consumed_total",
  help: "Total number of messages consumed from RabbitMQ",
  labelNames: ["exchange", "routing_key"],
  registers: [register],
});

const messageProcessDuration = new promClient.Histogram({
  name: "recommendation_service_message_process_duration_seconds",
  help: "Duration of message processing operations in seconds",
  labelNames: ["message_type"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

const rabbitmqConnectionCounter = new promClient.Counter({
  name: "recommendation_service_rabbitmq_connection_attempts_total",
  help: "Total number of RabbitMQ connection attempts",
  labelNames: ["status"],
  registers: [register],
});

const operationsCounter = new promClient.Counter({
  name: "recommendation_service_operations_total",
  help: "Count of recommendation service operations",
  labelNames: ["operation", "status"],
  registers: [register],
});

// New metrics for queue monitoring
const queueDepthGauge = new promClient.Gauge({
  name: "recommendation_service_rabbitmq_queue_depth",
  help: "Current number of messages in RabbitMQ queues",
  labelNames: ["queue"],
  registers: [register],
});

const messageErrorCounter = new promClient.Counter({
  name: "recommendation_service_message_errors_total",
  help: "Total number of errors in message processing",
  labelNames: ["error_type", "queue"],
  registers: [register],
});

const messageRetryCounter = new promClient.Counter({
  name: "recommendation_service_message_retries_total",
  help: "Total number of message retry attempts",
  labelNames: ["queue"],
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
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
};

// RabbitMQ Connection and Channel
let rabbitChannel;
let rabbitConnection;
const connectRabbitMQ = async () => {
  try {
    rabbitmqConnectionCounter.inc({ status: "attempt" });
    rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await rabbitConnection.createChannel();

    // Set up connection error handling
    rabbitConnection.on("error", handleRabbitMQError);
    channel.on("error", handleChannelError);

    // Set up the recommendation queue
    const RECOMMEND_QUEUE = "recommendations";
    await channel.assertQueue(RECOMMEND_QUEUE, { durable: true });

    // Set up to listen for user events
    const USER_EXCHANGE = "user-events";
    await channel.assertExchange(USER_EXCHANGE, "topic", { durable: true });
    const q = await channel.assertQueue("", { exclusive: true });

    // Bind to user events
    await channel.bindQueue(q.queue, USER_EXCHANGE, "user.created");
    await channel.bindQueue(q.queue, USER_EXCHANGE, "user.preferences.updated");

    // Process user events
    channel.consume(q.queue, async (msg) => {
      if (msg) {
        try {
          const routingKey = msg.fields.routingKey;
          const message = JSON.parse(msg.content.toString());

          // Track message consumption
          messageConsumeCounter.inc({
            exchange: USER_EXCHANGE,
            routing_key: routingKey,
          });

          const timer = messageProcessDuration.startTimer({
            message_type: routingKey,
          });

          if (routingKey === "user.created") {
            await handleNewUser(message);
          } else if (routingKey === "user.preferences.updated") {
            await handlePreferencesUpdate(message);
          }

          timer(); // End the timer
          channel.ack(msg);
        } catch (error) {
          console.error("Error processing user event:", error);
          messageErrorCounter.inc({
            error_type: "processing",
            queue: q.queue,
          });

          // Add delivery failure handling - reject with requeue for retry
          // but only if it hasn't been retried too many times
          const retryCount = msg.properties.headers?.retryCount || 0;

          if (retryCount < 3) {
            // Simple retry mechanism with max 3 retries
            // Increment retry counter in headers
            const headers = msg.properties.headers || {};
            headers.retryCount = retryCount + 1;

            // Publish the message back to the queue with updated headers
            channel.publish(
              msg.fields.exchange,
              msg.fields.routingKey,
              msg.content,
              { headers }
            );

            messageRetryCounter.inc({ queue: q.queue });
            console.log(`Message requeued for retry ${retryCount + 1}/3`);
          }

          // Always ack the original message
          channel.ack(msg);
        }
      }
    });

    // Set up queue monitoring
    setupQueueMonitoring(channel);

    console.log("Connected to RabbitMQ");
    rabbitmqConnectionCounter.inc({ status: "success" });
    return channel;
  } catch (err) {
    console.error("RabbitMQ connection error:", err);
    rabbitmqConnectionCounter.inc({ status: "failure" });

    // Try to reconnect after a delay
    setTimeout(async () => {
      console.log("Attempting to reconnect to RabbitMQ...");
      rabbitChannel = await connectRabbitMQ();
    }, 5000);

    return null;
  }
};

// Handle RabbitMQ connection errors
const handleRabbitMQError = async (error) => {
  console.error("RabbitMQ connection error:", error);
  messageErrorCounter.inc({ error_type: "connection", queue: "all" });

  // Try to reconnect after a delay
  setTimeout(async () => {
    console.log("Attempting to reconnect to RabbitMQ...");
    rabbitChannel = await connectRabbitMQ();
  }, 5000);
};

// Handle channel errors
const handleChannelError = async (error) => {
  console.error("RabbitMQ channel error:", error);
  messageErrorCounter.inc({ error_type: "channel", queue: "all" });

  // Try to recreate the channel
  try {
    rabbitChannel = await rabbitConnection.createChannel();
  } catch (err) {
    console.error("Failed to recreate channel:", err);
  }
};

// Set up periodic queue monitoring
const setupQueueMonitoring = (channel) => {
  const queues = ["recommendations"];

  // Check queue depths every 30 seconds
  setInterval(async () => {
    for (const queue of queues) {
      try {
        const queueInfo = await channel.assertQueue(queue, { durable: true });
        queueDepthGauge.set({ queue }, queueInfo.messageCount);
      } catch (error) {
        console.error(`Error checking queue ${queue}:`, error);
      }
    }
  }, 30000);
};

// User Schema
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  purchaseHistory: [{ productId: String, timestamp: Date }],
  browsingActivity: [{ productId: String, timestamp: Date }],
});
const User = mongoose.model("User", userSchema);

// Handle New User Event
const handleNewUser = async (user) => {
  try {
    // Create a new user in the recommendation database
    const newUser = new User({
      userId: user.id,
      purchaseHistory: [],
      browsingActivity: [],
    });
    await newUser.save();
    operationsCounter.inc({ operation: "new_user_created", status: "success" });
    console.log(`New user created in recommendation service: ${user.id}`);
  } catch (error) {
    operationsCounter.inc({ operation: "new_user_created", status: "error" });
    console.error("Error handling new user event:", error);
  }
};

// Handle Preferences Update Event
const handlePreferencesUpdate = async (data) => {
  try {
    const { userId, preferences } = data;

    // Generate recommendations based on updated preferences
    const recommendations = await generateRecommendations(userId);

    // Send recommendations to the notification service via RabbitMQ
    if (recommendations.length > 0 && rabbitChannel) {
      const queue = "recommendations";

      // Use the existing channel and make sure durable is true to match consumer
      for (const message of recommendations) {
        try {
          const result = rabbitChannel.sendToQueue(
            queue,
            Buffer.from(
              JSON.stringify({
                event: "NEW_RECOMMENDATION",
                data: {
                  userId,
                  content: message,
                },
              })
            ),
            { persistent: true } // Make messages persistent
          );

          // Check if message was published successfully
          if (result) {
            messagePublishCounter.inc({ queue });
          } else {
            // Handle send failure
            messageErrorCounter.inc({
              error_type: "publish_failed",
              queue,
            });
            console.error(`Failed to publish message to ${queue}`);
          }
        } catch (publishError) {
          messageErrorCounter.inc({
            error_type: "publish_exception",
            queue,
          });
          console.error("Error publishing message:", publishError);
        }
      }

      operationsCounter.inc({
        operation: "recommendations_sent",
        status: "success",
      });
      console.log(`Recommendations sent for user ${userId}`);
    }
  } catch (error) {
    operationsCounter.inc({
      operation: "recommendations_sent",
      status: "error",
    });
    console.error("Error handling preferences update event:", error);
  }
};

// Generate Recommendations
const generateRecommendations = async (userId) => {
  try {
    const timer = messageProcessDuration.startTimer({
      message_type: "generate_recommendations",
    });
    const user = await User.findOne({ userId });
    if (!user) {
      timer();
      operationsCounter.inc({
        operation: "generate_recommendations",
        status: "user_not_found",
      });
      throw new Error("User not found");
    }

    const recommendations = new Set();

    // Based on purchase history
    user.purchaseHistory.forEach((item) => {
      recommendations.add(`You might like this product: ${item.productId}`);
    });

    // Based on browsing activity
    user.browsingActivity.forEach((item) => {
      recommendations.add(`You recently viewed: ${item.productId}`);
    });

    timer();
    operationsCounter.inc({
      operation: "generate_recommendations",
      status: "success",
    });
    return Array.from(recommendations);
  } catch (err) {
    operationsCounter.inc({
      operation: "generate_recommendations",
      status: "error",
    });
    console.error("Error generating recommendations:", err);
    return [];
  }
};

// API Endpoint: Get Browsing Activity for a User
app.get("/users/:userId/browsing", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findOne({ userId });
    if (!user) {
      operationsCounter.inc({
        operation: "get_browsing",
        status: "user_not_found",
      });
      return res.status(404).json({ error: "User not found" });
    }
    operationsCounter.inc({ operation: "get_browsing", status: "success" });
    res.status(200).json({
      browsingActivity: user.browsingActivity.map((item) => ({
        productId: item.productId,
        timestamp: item.timestamp,
      })),
    });
  } catch (error) {
    operationsCounter.inc({ operation: "get_browsing", status: "error" });
    console.error("Error fetching browsing activity:", error);
    res.status(500).json({ error: "Failed to fetch browsing activity" });
  }
});

// API Endpoint: Get Purchase History for a User
app.get("/users/:userId/purchases", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findOne({ userId });
    if (!user) {
      operationsCounter.inc({
        operation: "get_purchases",
        status: "user_not_found",
      });
      return res.status(404).json({ error: "User not found" });
    }
    operationsCounter.inc({ operation: "get_purchases", status: "success" });
    res.status(200).json({
      purchaseHistory: user.purchaseHistory.map((item) => ({
        productId: item.productId,
        timestamp: item.timestamp,
      })),
    });
  } catch (error) {
    operationsCounter.inc({ operation: "get_purchases", status: "error" });
    console.error("Error fetching purchase history:", error);
    res.status(500).json({ error: "Failed to fetch purchase history" });
  }
});

// API Endpoint: Get Recommendations for a User
app.get("/recommendations/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const recommendations = await generateRecommendations(userId);
    operationsCounter.inc({
      operation: "get_recommendations",
      status: "success",
    });
    res.status(200).json({ userId, recommendations });
  } catch (error) {
    operationsCounter.inc({
      operation: "get_recommendations",
      status: "error",
    });
    console.error("Error fetching recommendations:", error);
    res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

// API Endpoint: Add Purchase History for a User
app.post("/users/:userId/purchase", async (req, res) => {
  try {
    const { userId } = req.params;
    const { productId } = req.body;

    const user = await User.findOne({ userId });
    if (!user) {
      operationsCounter.inc({
        operation: "add_purchase",
        status: "user_not_found",
      });
      return res.status(404).json({ error: "User not found" });
    }

    user.purchaseHistory.push({ productId, timestamp: new Date() });
    await user.save();

    operationsCounter.inc({ operation: "add_purchase", status: "success" });
    res.status(200).json({ message: "Purchase history updated", user });
  } catch (error) {
    operationsCounter.inc({ operation: "add_purchase", status: "error" });
    console.error("Error updating purchase history:", error);
    res.status(500).json({ error: "Failed to update purchase history" });
  }
});

// API Endpoint: Add Browsing Activity for a User
app.post("/users/:userId/browse", async (req, res) => {
  try {
    const { userId } = req.params;
    const { productId } = req.body;

    const user = await User.findOne({ userId });
    if (!user) {
      operationsCounter.inc({
        operation: "add_browsing",
        status: "user_not_found",
      });
      return res.status(404).json({ error: "User not found" });
    }

    user.browsingActivity.push({ productId, timestamp: new Date() });
    await user.save();

    operationsCounter.inc({ operation: "add_browsing", status: "success" });
    res.status(200).json({ message: "Browsing activity updated", user });
  } catch (error) {
    operationsCounter.inc({ operation: "add_browsing", status: "error" });
    console.error("Error updating browsing activity:", error);
    res.status(500).json({ error: "Failed to update browsing activity" });
  }
});

// Health check endpoint with RabbitMQ status
app.get("/health", async (req, res) => {
  const rabbitStatus = rabbitChannel ? "UP" : "DOWN";

  // Simple check of queue status
  let queueStatus = "UNKNOWN";
  if (rabbitChannel) {
    try {
      await rabbitChannel.checkQueue("recommendations");
      queueStatus = "UP";
    } catch (err) {
      queueStatus = "DOWN";
    }
  }

  res.status(200).json({
    status: "UP",
    rabbit: rabbitStatus,
    queue: queueStatus,
  });
});

// Start Server
connectDB().then(async () => {
  rabbitChannel = await connectRabbitMQ();
  app.listen(PORT, () => {
    console.log(`Recommendation service running on port ${PORT}`);
    console.log(`Metrics available at http://localhost:${PORT}/metrics`);
  });
});
