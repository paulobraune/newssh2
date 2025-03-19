#!/usr/bin/env node

/**
 * Script to generate a production-ready .env file
 * This script will create a new .env.production file with secure defaults
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Generate a secure random string for SESSION_SECRET
function generateRandomString(length = 64) {
  return crypto.randomBytes(length).toString('hex');
}

// Generate a secure password
function generateSecurePassword(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';
  let password = '';
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    const randomIndex = randomBytes[i] % chars.length;
    password += chars.charAt(randomIndex);
  }
  
  return password;
}

// Create production .env file
function createProductionEnv() {
  console.log('Creating production .env file...');
  
  const sessionSecret = generateRandomString(64);
  const adminPassword = generateSecurePassword(16);
  const redisPassword = generateSecurePassword(20);
  
  const productionEnv = `# Server Configuration
PORT=3011
NODE_ENV=production
HOST=0.0.0.0

# Authentication
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${adminPassword}

# Session
SESSION_SECRET=${sessionSecret}

# Redis Configuration (strongly recommended for production)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=${redisPassword}
REDIS_URL=redis://:${redisPassword}@localhost:6379

# Rate Limiting (more conservative for production)
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=50

# API Keys
OPENAI_API_KEY=your_openai_key_here
DEEPSEEK_API_KEY=your_deepseek_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here

# Logging
LOG_LEVEL=info
ACCESS_LOG=logs/access.log
ERROR_LOG=logs/error.log

# Security Settings
COOKIE_SECURE=true
COOKIE_HTTP_ONLY=true
COOKIE_MAX_AGE=86400000

# Optional: SSL Configuration (if not using reverse proxy)
# SSL_ENABLED=true
# SSL_KEY=/path/to/private/key.pem
# SSL_CERT=/path/to/certificate.pem

# Optional: Proxy Settings
# TRUST_PROXY=true
`;

  // Write to .env.production file
  fs.writeFileSync(path.join(process.cwd(), '.env.production'), productionEnv);
  
  console.log('✅ Production environment file created: .env.production');
  console.log('\nImportant security credentials generated:');
  console.log(`Admin Password: ${adminPassword}`);
  console.log(`Redis Password: ${redisPassword}`);
  console.log('\nMake sure to save these credentials securely!');
  console.log('\nTo use this file in production:');
  console.log('1. Rename it to .env: mv .env.production .env');
  console.log('2. Update any API keys or specific settings for your environment');
  console.log('3. Start the application with: npm run start:prod');
}

// Run the function
createProductionEnv();