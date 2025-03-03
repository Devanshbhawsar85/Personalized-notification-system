# Use official Node.js 18 image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first for efficient layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install 

# Copy application source code
COPY . .

# Expose the application port
EXPOSE 3002  
# Start the application
CMD ["node", "server.js"]