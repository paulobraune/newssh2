FROM node:18-alpine

# Install system dependencies
RUN apk add --no-cache zip curl redis

# Set working directory
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create directories for data and logs
RUN mkdir -p /app/data /app/logs /app/backups

# Set permissions
RUN chmod +x scripts/*.js

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3011

# Expose the port
EXPOSE 3011

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node scripts/healthcheck.js

# Command to run the application
CMD ["node", "server.js"]