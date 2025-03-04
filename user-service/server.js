const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const amqp = require("amqplib");
const cors = require("cors");
const promClient = require("prom-client");
const promBundle = require("express-prom-bundle");

require("dotenv").config();
const app = express();

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
app.use(bodyParser.json());
app.use(cors());

// Create custom metrics
const messagePublishCounter = new promClient.Counter({
  name: "user_service_rabbitmq_messages_published_total",
  help: "Total number of messages published to RabbitMQ",
  labelNames: ["exchange", "routing_key"],
  registers: [register],
});

const messagePublishDuration = new promClient.Histogram({
  name: "user_service_rabbitmq_publish_duration_seconds",
  help: "Duration of RabbitMQ publish operations in seconds",
  labelNames: ["exchange", "routing_key"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

const rabbitmqConnectionCounter = new promClient.Counter({
  name: "user_service_rabbitmq_connection_attempts_total",
  help: "Total number of RabbitMQ connection attempts",
  labelNames: ["status"],
  registers: [register],
});

const userOperationsCounter = new promClient.Counter({
  name: "user_service_operations_total",
  help: "Count of user operations",
  labelNames: ["operation", "status"],
  registers: [register],
});

// Add DLQ metrics
const dlqMessageCounter = new promClient.Counter({
  name: "user_service_dlq_messages_total",
  help: "Total number of messages sent to the dead letter queue",
  labelNames: ["exchange", "routing_key", "reason"],
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

// Store a single RabbitMQ connection to reuse
let rabbitmqConnection = null;
let rabbitmqChannel = null;

// Function to get or create RabbitMQ connection and channel
const getRabbitMQChannel = async () => {
  try {
    // If connection doesn't exist or is closed, create a new one
    if (!rabbitmqConnection || rabbitmqConnection.connection.closed) {
      rabbitmqConnectionCounter.inc({ status: "attempt" });
      rabbitmqConnection = await amqp.connect(process.env.RABBITMQ_URL);

      // Setup reconnection handling
      rabbitmqConnection.on("error", async (err) => {
        console.error("RabbitMQ connection error:", err);
        rabbitmqConnectionCounter.inc({ status: "error" });
        rabbitmqConnection = null;
        rabbitmqChannel = null;
      });

      rabbitmqConnection.on("close", async () => {
        console.log("RabbitMQ connection closed, will attempt to reconnect");
        rabbitmqConnection = null;
        rabbitmqChannel = null;
      });

      rabbitmqConnectionCounter.inc({ status: "success" });
    }

    // If channel doesn't exist or is closed, create a new one
    if (!rabbitmqChannel || rabbitmqChannel.closed) {
      rabbitmqChannel = await rabbitmqConnection.createChannel();

      // Setup Dead Letter Exchange and Queue
      await rabbitmqChannel.assertExchange("user-events-dlx", "topic", {
        durable: true,
      });

      // Create dead letter queue
      await rabbitmqChannel.assertQueue("user-events-dlq", {
        durable: true,
        arguments: {
          "x-message-ttl": 1000 * 60 * 60 * 24 * 7, // 7 days TTL for dead letter messages
        },
      });

      // Bind DLQ to DLX with wildcard routing key
      await rabbitmqChannel.bindQueue(
        "user-events-dlq",
        "user-events-dlx",
        "#"
      );

      // Setup main exchange for user events
      await rabbitmqChannel.assertExchange("user-events", "topic", {
        durable: true,
      });
    }

    return rabbitmqChannel;
  } catch (error) {
    console.error("Error getting RabbitMQ channel:", error);
    rabbitmqConnectionCounter.inc({ status: "failure" });
    throw error;
  }
};

// Function to publish events to RabbitMQ with metrics and DLQ support
const publishEvent = async (exchange, routingKey, message, retries = 3) => {
  const timer = messagePublishDuration.startTimer({
    exchange,
    routing_key: routingKey,
  });

  try {
    const channel = await getRabbitMQChannel();

    // Add headers for message tracking
    const messageOptions = {
      persistent: true, // Make sure message is persistent
      headers: {
        "x-retry-count": 0,
        "x-original-exchange": exchange,
        "x-original-routing-key": routingKey,
        "x-timestamp": Date.now(),
      },
      // Set DLX for this message if it can't be routed
      expiration: 30000, // 30 seconds TTL
    };

    const published = channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      messageOptions
    );

    // Handle backpressure if channel buffer is full
    if (!published) {
      await new Promise((resolve) => channel.once("drain", resolve));
    }

    console.log(`Published event to ${exchange}:${routingKey}`, message);

    // Increment the publish counter
    messagePublishCounter.inc({
      exchange,
      routing_key: routingKey,
    });

    // End the timer
    timer();
    return { success: true };
  } catch (error) {
    // End the timer even if there's an error
    timer();
    console.error("Error publishing event", error);

    // Retry logic for transient failures
    if (retries > 0) {
      console.log(
        `Retrying publish to ${exchange}:${routingKey}, ${retries} retries left`
      );
      // Wait before retry (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, 1000 * (4 - retries)));
      return publishEvent(exchange, routingKey, message, retries - 1);
    } else {
      // If all retries failed, send to DLQ
      await sendToDLQ(exchange, routingKey, message, "publish_failure");
      return { success: false, error };
    }
  }
};

// Function to send messages to Dead Letter Queue
const sendToDLQ = async (
  originalExchange,
  originalRoutingKey,
  message,
  reason
) => {
  try {
    const channel = await getRabbitMQChannel();

    // Add metadata for debugging
    const dlqMessage = {
      originalMessage: message,
      metadata: {
        originalExchange,
        originalRoutingKey,
        failureReason: reason,
        timestamp: new Date().toISOString(),
      },
    };

    await channel.publish(
      "user-events-dlx",
      originalRoutingKey,
      Buffer.from(JSON.stringify(dlqMessage)),
      {
        persistent: true,
        headers: {
          "x-original-exchange": originalExchange,
          "x-original-routing-key": originalRoutingKey,
          "x-failure-reason": reason,
          "x-timestamp": Date.now(),
        },
      }
    );

    console.log(
      `Sent message to DLQ: ${originalExchange}:${originalRoutingKey}, reason: ${reason}`
    );

    // Increment the DLQ counter
    dlqMessageCounter.inc({
      exchange: originalExchange,
      routing_key: originalRoutingKey,
      reason: reason,
    });

    return true;
  } catch (error) {
    console.error("Failed to send message to DLQ:", error);
    return false;
  }
};

// Setup RabbitMQ when server starts
const setupRabbitMQ = async () => {
  try {
    await getRabbitMQChannel();
    console.log("RabbitMQ setup complete with Dead Letter Queue support");
  } catch (error) {
    console.error("RabbitMQ setup failed:", error);
  }
};

// Add function to process messages from DLQ (for manual replay/recovery)
const processDeadLetterQueue = async (limit = 10) => {
  try {
    const channel = await getRabbitMQChannel();

    // Get messages from DLQ with a limit
    for (let i = 0; i < limit; i++) {
      const message = await channel.get("user-events-dlq", { noAck: false });

      if (!message) {
        console.log("No more messages in DLQ");
        break;
      }

      try {
        const content = JSON.parse(message.content.toString());
        const headers = message.properties.headers;

        console.log("Processing DLQ message:", {
          originalExchange: headers["x-original-exchange"],
          originalRoutingKey: headers["x-original-routing-key"],
          failureReason: headers["x-failure-reason"],
        });

        // Here you can implement recovery logic based on the failure reason
        // For example, retry publishing to the original exchange

        // Acknowledge the message to remove it from the queue
        channel.ack(message);
      } catch (error) {
        console.error("Error processing DLQ message:", error);
        // Reject and requeue the message if it can't be processed
        channel.nack(message, false, true);
      }
    }

    return { success: true, message: "DLQ processing complete" };
  } catch (error) {
    console.error("Failed to process DLQ:", error);
    return { success: false, error };
  }
};

// JWT Configuration
const SECRET_KEY = process.env.SECRET_KEY;
const ALGORITHM = "HS256";

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to Mongodb "))
  .catch((err) => console.error("MongoDB connection failed:", err));

// Mongoose Schema and Model
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  hashed_password: { type: String, required: true },
  preferences: { type: Map, of: Boolean, default: {} },
});

const User = mongoose.model("User", userSchema);

// Helper Functions
const generateToken = (userId) => {
  return jwt.sign(
    { userId, exp: Math.floor(Date.now() / 1000) + 60 * 60 },
    SECRET_KEY
  );
};

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ detail: "Token not provided" });
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ detail: "Invalid token" });
    }
    req.user = user;
    next();
  });
};

app.post("/register", async (req, res) => {
  try {
    const { name, email, password, preferences = {} } = req.body;

    // Check if the email is already registered
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      userOperationsCounter.inc({
        operation: "register",
        status: "duplicate_email",
      });
      return res.status(400).json({ detail: "Email already registered" });
    }

    // Hash the password before saving
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      name,
      email,
      hashed_password: hashedPassword,
      preferences: new Map(Object.entries(preferences)),
    });

    await newUser.save();

    const userResponse = {
      id: newUser._id,
      name: newUser.name,
      email: newUser.email,
      preferences: Object.fromEntries(newUser.preferences),
    };

    // Publish user.created event with DLQ support
    const publishResult = await publishEvent(
      "user-events",
      "user.created",
      userResponse
    );

    if (!publishResult.success) {
      console.warn(
        "User created but event publishing failed, message sent to DLQ"
      );
    }

    userOperationsCounter.inc({ operation: "register", status: "success" });

    res.json(userResponse);
  } catch (error) {
    userOperationsCounter.inc({ operation: "register", status: "error" });
    console.error("Error during registration:", error);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// User Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if user exists and verify password
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.hashed_password))) {
      userOperationsCounter.inc({
        operation: "login",
        status: "invalid_credentials",
      });
      return res.status(401).json({ detail: "Invalid credentials" });
    }

    // Generate JWT Token
    const token = generateToken(user._id);
    userOperationsCounter.inc({ operation: "login", status: "success" });
    res.json({ token, userId: user._id });
  } catch (error) {
    userOperationsCounter.inc({ operation: "login", status: "error" });
    console.error("Error during login:", error);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Get All Users (Public)
app.get("/users", async (req, res) => {
  try {
    const users = await User.find();
    const response = users.map((user) => ({
      id: user._id,
      name: user.name,
      email: user.email,
      preferences: Object.fromEntries(user.preferences),
    }));
    userOperationsCounter.inc({
      operation: "get_all_users",
      status: "success",
    });
    res.json(response);
  } catch (error) {
    userOperationsCounter.inc({ operation: "get_all_users", status: "error" });
    console.error("Error fetching users:", error);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Add endpoint to get user by ID to match GraphQL gateway
app.get("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      userOperationsCounter.inc({
        operation: "get_user_by_id",
        status: "not_found",
      });
      return res.status(404).json({ detail: "User not found" });
    }

    userOperationsCounter.inc({
      operation: "get_user_by_id",
      status: "success",
    });
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      preferences: Object.fromEntries(user.preferences),
    });
  } catch (error) {
    userOperationsCounter.inc({ operation: "get_user_by_id", status: "error" });
    console.error("Error fetching user:", error);
    res.status(500).json({ detail: "Failed to fetch user" });
  }
});

// Update User Preferences (Protected)
app.put("/user/:userId/preferences", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const preferences = req.body; // Get preferences directly from req.body

    console.log("Request body:", req.body);
    console.log("Preferences:", preferences);

    // Validate preferences
    if (!preferences || typeof preferences !== "object") {
      userOperationsCounter.inc({
        operation: "update_preferences",
        status: "invalid_input",
      });
      return res.status(400).json({ detail: "Preferences must be an object" });
    }

    // Authorization Check: Only allow the user to update their own preferences
    if (req.user.userId !== userId) {
      userOperationsCounter.inc({
        operation: "update_preferences",
        status: "unauthorized",
      });
      return res.status(403).json({ detail: "Access denied" });
    }

    const user = await User.findById(userId);
    if (!user) {
      userOperationsCounter.inc({
        operation: "update_preferences",
        status: "not_found",
      });
      return res.status(404).json({ detail: "User not found" });
    }

    // Update preferences as a Map
    user.preferences = new Map(Object.entries(preferences));
    await user.save();

    const userResponse = {
      id: user._id,
      name: user.name,
      email: user.email,
      preferences: Object.fromEntries(user.preferences),
    };

    // Publish user.preferences.updated event with DLQ support
    const publishResult = await publishEvent(
      "user-events",
      "user.preferences.updated",
      {
        userId: user._id.toString(),
        preferences: Object.fromEntries(user.preferences),
      }
    );

    if (!publishResult.success) {
      console.warn(
        "User preferences updated but event publishing failed, message sent to DLQ"
      );
    }

    userOperationsCounter.inc({
      operation: "update_preferences",
      status: "success",
    });
    res.json(userResponse);
  } catch (error) {
    userOperationsCounter.inc({
      operation: "update_preferences",
      status: "error",
    });
    console.error("Error updating preferences:", error);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Add endpoint for DLQ statistics
app.get("/admin/dlq-stats", authenticateToken, async (req, res) => {
  try {
    const channel = await getRabbitMQChannel();

    // Get queue info
    const queueInfo = await channel.assertQueue("user-events-dlq", {
      durable: true,
      passive: true,
    });

    res.json({
      messageCount: queueInfo.messageCount,
      consumerCount: queueInfo.consumerCount,
      lastChecked: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error getting DLQ stats:", error);
    res.status(500).json({ detail: "Failed to get DLQ statistics" });
  }
});

// Add endpoint to manually process DLQ messages (admin only)
app.post("/admin/process-dlq", authenticateToken, async (req, res) => {
  try {
    // Admin check would go here
    const { limit = 10 } = req.body;
    const result = await processDeadLetterQueue(limit);
    res.json(result);
  } catch (error) {
    console.error("Error processing DLQ via API:", error);
    res.status(500).json({ detail: "Failed to process DLQ" });
  }
});

// Add health check endpoint for monitoring
app.get("/health", (req, res) => {
  // Include RabbitMQ connection status in health check
  const rabbitmqStatus =
    rabbitmqConnection && !rabbitmqConnection.connection.closed ? "UP" : "DOWN";
  res.status(200).json({
    status: "UP",
    details: {
      rabbitmq: rabbitmqStatus,
    },
  });
});

// START SERVER
const PORT = 3001;
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Metrics available at http://localhost:${PORT}/metrics`);
  await setupRabbitMQ();
});

const shutdown = async () => {
  console.log("Shutting down gracefully...");

  if (rabbitmqConnection) {
    try {
      await rabbitmqConnection.close();
      console.log("RabbitMQ connection closed");
    } catch (err) {
      console.error("Error closing RabbitMQ connection:", err);
    }
  }

  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
