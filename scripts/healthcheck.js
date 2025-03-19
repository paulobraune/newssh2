#!/usr/bin/env node

/**
 * SSH Client Healthcheck Script
 * 
 * This script checks the health of the SSH Client application
 * and can be used by monitoring tools or container orchestrators.
 * 
 * Returns:
 * - Exit code 0: Application is healthy
 * - Exit code 1: Application is unhealthy
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configuration
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3011;
const TIMEOUT = 5000; // 5 seconds
const LOG_FILE = path.join(process.cwd(), 'healthcheck.log');

// Get timestamp
const timestamp = new Date().toISOString();

// Log a message to the healthcheck log
function log(message, error = false) {
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logMessage);
  
  if (error) {
    console.error(message);
  } else {
    console.log(message);
  }
}

// Make an HTTP request to the application
const request = http.request({
  host: HOST,
  port: PORT,
  path: '/login',
  method: 'GET',
  timeout: TIMEOUT
}, (response) => {
  if (response.statusCode === 200) {
    log('✅ Healthcheck passed - Application is responding normally');
    process.exit(0); // Healthy
  } else {
    log(`❌ Healthcheck failed - Unexpected status code: ${response.statusCode}`, true);
    process.exit(1); // Unhealthy
  }
});

// Handle request errors
request.on('error', (err) => {
  log(`❌ Healthcheck failed - Error: ${err.message}`, true);
  process.exit(1); // Unhealthy
});

// Handle timeouts
request.on('timeout', () => {
  log(`❌ Healthcheck failed - Request timed out after ${TIMEOUT}ms`, true);
  request.destroy();
  process.exit(1); // Unhealthy
});

// Send the request
request.end();