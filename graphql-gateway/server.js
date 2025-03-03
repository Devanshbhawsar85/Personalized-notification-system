const express = require("express");
const { ApolloServer } = require("apollo-server-express");
const { makeExecutableSchema } = require("@graphql-tools/schema");
const cors = require("cors");
const fetch = require("cross-fetch");
const redis = require("redis");

const app = express();
app.use(cors());

// const USER_SERVICE_URL = "http://localhost:3001";
// const NOTIFICATION_SERVICE_URL = "http://localhost:3002";
// const RECOMMENDATION_SERVICE_URL = "http://localhost:3003";
const USER_SERVICE_URL = "http://user-service:3001";
const NOTIFICATION_SERVICE_URL = "http://notification-service:3002";
const RECOMMENDATION_SERVICE_URL = "http://recommendation-service:3003";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = redis.createClient({
  url: REDIS_URL,
});

// Redis connection setup
(async () => {
  redisClient.on("error", (error) => console.error(`Redis Error: ${error}`));
  redisClient.on("connect", () => console.log("Redis connection success"));
  await redisClient.connect();
})();

const CACHE_TTL = 60 * 5; // Cache for 5 min

async function authenticatedFetch(url, options = {}, token) {
  if (!token) {
    throw new Error("Authentication token required");
  }

  // Clone option to avoid modifying the original
  const fetchOptions = {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      `Request failed: ${response.statusText}${
        errorData ? ` - ${errorData.detail}` : ""
      }`
    );
  }

  return response.json();
}

const typeDefs = `
  type User {
    id: ID!
    name: String!
    email: String!
    preferences: Preferences
    notifications: [Notification]
    recommendations: [String]
    browsingActivity: [BrowsingActivity]
    purchaseHistory: [PurchaseHistory]
  }

  type BrowsingActivity {
    productId: String!
    timestamp: String!
  }

  type PurchaseHistory {
    productId: String!
    timestamp: String!
  }

  type Preferences {
    promotions: Boolean
    order_updates: Boolean
    recommendations: Boolean
  }

  type Notification {
    id: ID!
    userId: ID!
    type: String!
    content: String!
    sentAt: String!
    read: Boolean!
  }

  type RecommendationResponse {
    userId: ID!
    recommendations: [String]
  }
  
  type AuthPayload {
    token: String!
    userId: ID!
  }
  
  # DLQ Statistics type
  type DLQStats {
    messageCount: Int!
    consumerCount: Int!
    lastChecked: String!
  }

  # DLQ Processing Result type
  type DLQProcessingResult {
    success: Boolean!
    message: String
    error: String
  }

  # Service Health Check type
  type HealthCheck {
    status: String!
    details: HealthDetails
  }

  type HealthDetails {
    rabbitmq: String
  }
   type FailedMessage {
    original: JSON
    meta: FailedMessageMeta
  }

  type FailedMessageMeta {
    reason: String
    timestamp: String
    originalQueue: String
    headers: JSON
  }

  type FailedMessagesResponse {
    queueDepth: Int!
    consumerCount: Int!
    sampleMessages: [FailedMessage]
  }

  type QueueStats {
    messageCount: Int!
    consumerCount: Int!
  }

  type QueueMonitoringResponse {
    queues: JSON!
    timestamp: String!
  }
  
  scalar JSON
  type Query {
    getUser(id: ID!): User
    getUsers: [User]
    getUserNotifications(userId: ID!, unreadOnly: Boolean): [Notification]
    getUserRecommendations(userId: ID!): RecommendationResponse
    getUserBrowsingActivity(userId: ID!): [BrowsingActivity]
    getUserPurchaseHistory(userId: ID!): [PurchaseHistory]
    getNotification(id: ID!): Notification
    getFailedMessages: FailedMessagesResponse
    getQueueStats: QueueMonitoringResponse
    
    # DLQ Management queries
    getDLQStats: DLQStats
    
    # Health check query
    getServiceHealth: HealthCheck
  }

  type Mutation {
    registerUser(name: String!, email: String!, password: String!, preferences: PreferencesInput): User
    updateUserPreferences(userId: ID!, preferences: PreferencesInput!): User
    markNotificationAsRead(notificationId: ID!): Notification
    login(email: String!, password: String!): AuthPayload
    addPurchase(userId: ID!, productId: String!): User
    addBrowsingActivity(userId: ID!, productId: String!): User
    
    # DLQ Management mutation
    processDLQ(limit: Int): DLQProcessingResult
  }

  input PreferencesInput {
    promotions: Boolean
    order_updates: Boolean
    recommendations: Boolean
  }
`;

//resolvers
const resolvers = {
  Query: {
    getUser: async (_, { id }) => {
      try {
        const response = await fetch(`${USER_SERVICE_URL}/users/${id}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch user: ${response.statusText}`);
        }
        return response.json();
      } catch (error) {
        console.error("Error fetching user:", error);
        throw new Error(`Failed to fetch user: ${error.message}`);
      }
    },
    getUsers: async () => {
      try {
        // Cache key for users list
        const cacheKey = "all_users";

        //getting data from cache first
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          console.log("Cache hit");
          return JSON.parse(cachedData);
        }

        console.log("Cache miss");
        const response = await fetch(`${USER_SERVICE_URL}/users`);
        if (!response.ok) {
          throw new Error(`Failed to fetch users: ${response.statusText}`);
        }

        const users = await response.json();

        // Storing in cache
        await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(users));
        console.log("Stored users in Redis cache");

        return users;
      } catch (error) {
        console.error("Error fetching users:", error);
        throw new Error(`Failed to fetch users: ${error.message}`);
      }
    },
    getUserNotifications: async (_, { userId, unreadOnly }) => {
      try {
        const url = unreadOnly
          ? `${NOTIFICATION_SERVICE_URL}/notifications/unread/${userId}`
          : `${NOTIFICATION_SERVICE_URL}/users/notifications/${userId}`;

        console.log("Fetching URL:", url);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch notifications: ${response.statusText}`
          );
        }

        const data = await response.json();
        console.log("Fetched notifications:", data);

        const mappedData = Array.isArray(data)
          ? data.map((notification) => ({
              id: notification._id,
              userId: notification.userId,
              type: notification.type,
              content: notification.content,
              sentAt:
                notification.createdAt ||
                notification.sentAt ||
                new Date().toISOString(),
              read: notification.read || false,
            }))
          : [];

        return mappedData;
      } catch (error) {
        console.error("Error fetching notifications:", error);
        throw new Error(`Failed to fetch notifications: ${error.message}`);
      }
    },
    getUserRecommendations: async (_, { userId }) => {
      try {
        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/recommendations/${userId}`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch recommendations: ${response.statusText}`
          );
        }
        const data = await response.json();
        console.log("Fetched recommendations:", data);

        return data;
      } catch (error) {
        console.error("Error fetching recommendations:", error);
        throw new Error(`Failed to fetch recommendations: ${error.message}`);
      }
    },
    getUserBrowsingActivity: async (_, { userId }) => {
      try {
        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/users/${userId}/browsing`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch browsing activity: ${response.statusText}`
          );
        }
        const data = await response.json();
        return data.browsingActivity || [];
      } catch (error) {
        console.error("Error fetching browsing activity:", error);
        throw new Error(`Failed to fetch browsing activity: ${error.message}`);
      }
    },
    getUserPurchaseHistory: async (_, { userId }) => {
      try {
        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/users/${userId}/purchases`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch purchase history: ${response.statusText}`
          );
        }
        const data = await response.json();
        return data.purchaseHistory || [];
      } catch (error) {
        console.error("Error fetching purchase history:", error);
        throw new Error(`Failed to fetch purchase history: ${error.message}`);
      }
    },
    // New DLQ Stats query resolver
    getDLQStats: async (_, __, context) => {
      try {
        const token = context.token;
        if (!token) {
          throw new Error("Authentication required for DLQ operations");
        }

        // Correct endpoint to notification service
        const response = await authenticatedFetch(
          `${NOTIFICATION_SERVICE_URL}/monitoring/failed-messages`,
          {},
          token
        );

        // Map response to DLQStats type
        return {
          messageCount: response.queueDepth,
          consumerCount: response.consumerCount,
          lastChecked: new Date().toISOString(),
        };
      } catch (error) {
        console.error("Error fetching DLQ stats:", error);
        throw new Error(`Failed to fetch DLQ statistics: ${error.message}`);
      }
    },
    // New Health Check query resolver
    getServiceHealth: async () => {
      try {
        const response = await fetch(`${USER_SERVICE_URL}/health`);
        if (!response.ok) {
          throw new Error(`Health check failed: ${response.statusText}`);
        }
        return response.json();
      } catch (error) {
        console.error("Error performing health check:", error);
        throw new Error(`Health check failed: ${error.message}`);
      }
    },
    getNotification: async (_, { id }, context) => {
      try {
        const token = context.token;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};

        const response = await fetch(
          `${NOTIFICATION_SERVICE_URL}/notifications/${id}`,
          {
            headers,
          }
        );

        if (!response.ok) {
          throw new Error(
            `Failed to fetch notification: ${response.statusText}`
          );
        }

        const notification = await response.json();

        return {
          id: notification._id || id,
          userId: notification.userId,
          type: notification.type,
          content: notification.content,
          sentAt:
            notification.createdAt ||
            notification.sentAt ||
            new Date().toISOString(),
          read: notification.read || false,
        };
      } catch (error) {
        console.error("Error fetching notification:", error);
        throw new Error(`Failed to fetch notification: ${error.message}`);
      }
    },

    // Get failed messages from dead letter queue
    getFailedMessages: async (_, __, context) => {
      try {
        const token = context.token;
        if (!token) {
          throw new Error("Authentication required for monitoring operations");
        }

        const response = await authenticatedFetch(
          `${NOTIFICATION_SERVICE_URL}/monitoring/failed-messages`,
          {},
          token
        );

        return response;
      } catch (error) {
        console.error("Error fetching failed messages:", error);
        throw new Error(`Failed to fetch failed messages: ${error.message}`);
      }
    },

    // Get queue statistics
    getQueueStats: async (_, __, context) => {
      try {
        const token = context.token;
        if (!token) {
          throw new Error("Authentication required for monitoring operations");
        }

        const response = await authenticatedFetch(
          `${NOTIFICATION_SERVICE_URL}/monitoring/queues`,
          {},
          token
        );

        return response;
      } catch (error) {
        console.error("Error fetching queue statistics:", error);
        throw new Error(`Failed to fetch queue statistics: ${error.message}`);
      }
    },
  },

  // Need to add JSON scalar resolver
  JSON: {
    // A simple resolver that passes the JSON object through
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: (ast) => {
      if (ast.kind === Kind.STRING) {
        return JSON.parse(ast.value);
      }
      return null;
    },
  },
  Mutation: {
    registerUser: async (_, { name, email, password, preferences }) => {
      try {
        const response = await fetch(`${USER_SERVICE_URL}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password, preferences }),
        });
        if (!response.ok) {
          throw new Error(`Failed to register user: ${response.statusText}`);
        }
        return response.json();
      } catch (error) {
        console.error("Error registering user:", error);
        throw new Error(`Failed to register user: ${error.message}`);
      }
    },

    login: async (_, { email, password }) => {
      try {
        const response = await fetch(`${USER_SERVICE_URL}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          throw new Error(`Login failed: ${response.statusText}`);
        }

        const data = await response.json();
        return {
          token: data.token,
          userId: data.userId,
        };
      } catch (error) {
        console.error("Error during login:", error);
        throw new Error(`Failed to login: ${error.message}`);
      }
    },

    updateUserPreferences: async (_, { userId, preferences }, context) => {
      try {
        const token = context.token;

        if (!token) {
          throw new Error("Authentication required");
        }

        return await authenticatedFetch(
          `${USER_SERVICE_URL}/user/${userId}/preferences`,
          {
            method: "PUT",
            body: JSON.stringify(preferences),
          },
          token
        );
      } catch (error) {
        console.error("Error updating preferences:", error);
        throw new Error(error.message || "Failed to update preferences");
      }
    },
    markNotificationAsRead: async (_, { notificationId }) => {
      try {
        const response = await fetch(
          `${NOTIFICATION_SERVICE_URL}/notifications/read/${notificationId}`,
          {
            method: "PATCH",
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to mark notification as read: ${response.statusText} - ${errorText}`
          );
        }

        const data = await response.json();

        return {
          id: data._id || notificationId,
          userId: data.userId || "",
          type: data.type || "",
          content: data.content || data.message || "",
          sentAt: data.createdAt || data.sentAt || new Date().toISOString(),
          read: true,
        };
      } catch (error) {
        console.error("Error marking notification as read:", error);
        throw new Error(
          `Failed to mark notification as read: ${error.message}`
        );
      }
    },
    addPurchase: async (_, { userId, productId }, context) => {
      try {
        const token = context.token;

        if (!token) {
          throw new Error("Authentication required");
        }

        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/users/${userId}/purchase`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ productId }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to add purchase: ${response.statusText} - ${errorText}`
          );
        }

        await redisClient.del(`all_users`);
        await redisClient.del(`user:${userId}`);

        const userResponse = await fetch(
          `${USER_SERVICE_URL}/users/${userId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!userResponse.ok) {
          throw new Error(
            `Failed to fetch updated user: ${userResponse.statusText}`
          );
        }

        return userResponse.json();
      } catch (error) {
        console.error("Error adding purchase:", error);
        throw new Error(`Failed to add purchase: ${error.message}`);
      }
    },

    addBrowsingActivity: async (_, { userId, productId }, context) => {
      try {
        const token = context.token;

        if (!token) {
          throw new Error("Authentication required");
        }

        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/users/${userId}/browse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ productId }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to add browsing activity: ${response.statusText} - ${errorText}`
          );
        }

        await redisClient.del(`all_users`);
        await redisClient.del(`user:${userId}`);

        const userResponse = await fetch(
          `${USER_SERVICE_URL}/users/${userId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!userResponse.ok) {
          throw new Error(
            `Failed to fetch updated user: ${userResponse.statusText}`
          );
        }

        return userResponse.json();
      } catch (error) {
        console.error("Error adding browsing data ", error);
        throw new Error(`Failed to add browsing activity: ${error.message}`);
      }
    },
    // New DLQ Processing mutation resolver
    processDLQ: async (_, { limit = 10 }, context) => {
      try {
        const token = context.token;
        if (!token) {
          throw new Error("Authentication required for DLQ operations");
        }

        const response = await authenticatedFetch(
          `${NOTIFICATION_SERVICE_URL}/admin/process-dlq`,
          {
            method: "POST",
            body: JSON.stringify({ limit }),
          },
          token
        );

        return response;
      } catch (error) {
        console.error("Error processing DLQ:", error);
        throw new Error(`Failed to process DLQ: ${error.message}`);
      }
    },
  },
  User: {
    notifications: async (parent) => {
      try {
        const response = await fetch(
          `${NOTIFICATION_SERVICE_URL}/users/notifications/${parent.id}`
        );

        if (!response.ok) {
          throw new Error(
            `Failed to fetch user notifications: ${response.statusText}`
          );
        }

        const data = await response.json();

        const mappedData = Array.isArray(data)
          ? data.map((notification) => ({
              id: notification._id,
              userId: notification.userId,
              type: notification.type,
              content: notification.content,
              sentAt:
                notification.createdAt ||
                notification.sentAt ||
                new Date().toISOString(),
              read: notification.read || false,
            }))
          : [];

        return mappedData;
      } catch (error) {
        console.error("Error fetching user notifications:", error);
        return [];
      }
    },
    recommendations: async (parent) => {
      try {
        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/recommendations/${parent.id}`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch user recommendations: ${response.statusText}`
          );
        }
        const data = await response.json();

        return data.recommendations || [];
      } catch (error) {
        console.error("Error fetching user recommendations:", error);
        return [];
      }
    },
    browsingActivity: async (parent) => {
      try {
        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/users/${parent.id}/browsing`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch browsing activity: ${response.statusText}`
          );
        }
        const data = await response.json();
        return data.browsingActivity || [];
      } catch (error) {
        console.error("Error fetching browsing activity:", error);
        return [];
      }
    },
    purchaseHistory: async (parent) => {
      try {
        const response = await fetch(
          `${RECOMMENDATION_SERVICE_URL}/users/${parent.id}/purchases`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch purchase history: ${response.statusText}`
          );
        }
        const data = await response.json();
        return data.purchaseHistory || [];
      } catch (error) {
        console.error("Error fetching purchase history:", error);
        return [];
      }
    },
  },
};

async function startServer() {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });

  // Apollo Server with context for authentication
  const server = new ApolloServer({
    schema,
    context: ({ req }) => {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      return { token };
    },
  });

  await server.start();
  server.applyMiddleware({ app });

  const PORT = 4000;
  app.listen(PORT, () => {
    console.log(`GraphQL Gateway running at http://localhost:${PORT}/graphql`);
  });
}

startServer();
