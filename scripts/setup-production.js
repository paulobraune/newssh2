#!/usr/bin/env node

/**
 * Production Setup Script
 * 
 * This script helps set up the SSH Client application for production by:
 * 1. Validating required environment variables
 * 2. Setting up strong security configurations
 * 3. Testing the Redis connection if configured
 * 4. Checking API key validity
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');
const dotenv = require('dotenv');
const crypto = require('crypto');

// Load environment variables
dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
    });
  });
}

async function generateSecurePassword(length = 16) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

async function runChecks() {
  console.log('\n=== SSH Client Production Setup ===\n');
  
  // Check if .env file exists
  if (!fs.existsSync(path.join(process.cwd(), '.env'))) {
    console.log('❌ .env file not found. Creating from .env.example...');
    try {
      fs.copyFileSync(
        path.join(process.cwd(), '.env.example'),
        path.join(process.cwd(), '.env')
      );
      console.log('✅ .env file created. Please update with your configuration.');
    } catch (error) {
      console.error('Failed to create .env file:', error);
      process.exit(1);
    }
  } else {
    console.log('✅ .env file found');
  }
  
  // Check required environment variables
  const requiredVars = [
    'PORT',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    'SESSION_SECRET'
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.log(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
    
    // Ask if user wants to configure these variables now
    const configure = await askQuestion('Would you like to configure these variables now? (y/n): ');
    
    if (configure.toLowerCase() === 'y') {
      console.log('\nSetting up missing environment variables:');
      const envUpdates = [];
      
      // Read current .env file
      const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
      const envLines = envContent.split('\n');
      
      for (const varName of missingVars) {
        let value;
        
        if (varName === 'SESSION_SECRET') {
          value = crypto.randomBytes(64).toString('hex');
          console.log(`✅ Generated secure SESSION_SECRET automatically`);
        } else if (varName === 'ADMIN_PASSWORD' && !process.env.ADMIN_PASSWORD) {
          const securePassword = await generateSecurePassword();
          value = await askQuestion(`Enter ${varName} (suggested secure password: ${securePassword}): `);
          if (!value) value = securePassword;
        } else {
          value = await askQuestion(`Enter ${varName}: `);
        }
        
        process.env[varName] = value;
        
        // Update or add to .env file
        const envVarRegex = new RegExp(`^${varName}=.*`, 'm');
        const newEntry = `${varName}=${value}`;
        
        if (envContent.match(envVarRegex)) {
          envUpdates.push({ regex: envVarRegex, value: newEntry });
        } else {
          envUpdates.push({ append: true, value: newEntry });
        }
      }
      
      // Apply updates to .env file
      let updatedEnvContent = envContent;
      for (const update of envUpdates) {
        if (update.append) {
          updatedEnvContent += `\n${update.value}`;
        } else {
          updatedEnvContent = updatedEnvContent.replace(update.regex, update.value);
        }
      }
      
      fs.writeFileSync(path.join(process.cwd(), '.env'), updatedEnvContent);
      console.log('✅ Updated .env file with new values');
    } else {
      console.log('❌ Please update the .env file manually before proceeding.');
      process.exit(1);
    }
  } else {
    console.log('✅ All required environment variables are set');
  }
  
  // Check password strength
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD === 'admin123') {
    console.log('⚠️  WARNING: Default admin password detected. This is a security risk!');
    const changePassword = await askQuestion('Would you like to set a more secure password now? (y/n): ');
    
    if (changePassword.toLowerCase() === 'y') {
      const securePassword = await generateSecurePassword();
      const newPassword = await askQuestion(`Enter new admin password (suggested: ${securePassword}): `);
      
      const password = newPassword || securePassword;
      
      // Update .env file
      const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
      const updatedEnvContent = envContent.replace(
        /ADMIN_PASSWORD=.*/,
        `ADMIN_PASSWORD=${password}`
      );
      
      fs.writeFileSync(path.join(process.cwd(), '.env'), updatedEnvContent);
      process.env.ADMIN_PASSWORD = password;
      
      console.log('✅ Admin password updated successfully');
    } else {
      console.log('⚠️  Keeping default password. PLEASE CHANGE IT BEFORE DEPLOYING TO PRODUCTION!');
    }
  }
  
  // Check Node.js environment
  if (!process.env.NODE_ENV) {
    console.log('⚠️  NODE_ENV not set. For production use, set NODE_ENV=production');
    
    const setProduction = await askQuestion('Would you like to set NODE_ENV to production now? (y/n): ');
    
    if (setProduction.toLowerCase() === 'y') {
      // Update .env file
      const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
      const nodeEnvRegex = /NODE_ENV=.*/;
      
      let updatedEnvContent;
      if (envContent.match(nodeEnvRegex)) {
        updatedEnvContent = envContent.replace(nodeEnvRegex, 'NODE_ENV=production');
      } else {
        updatedEnvContent = envContent + '\nNODE_ENV=production';
      }
      
      fs.writeFileSync(path.join(process.cwd(), '.env'), updatedEnvContent);
      process.env.NODE_ENV = 'production';
      
      console.log('✅ NODE_ENV set to production');
    }
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(`⚠️  NODE_ENV is set to "${process.env.NODE_ENV}". For production use, set NODE_ENV=production`);
  } else {
    console.log('✅ NODE_ENV correctly set to production');
  }
  
  // Check Redis configuration (if available)
  if (process.env.REDIS_URL || (process.env.REDIS_HOST && process.env.REDIS_PORT)) {
    console.log('\nTesting Redis connection...');
    
    try {
      // Check if redis-cli is available
      const redisCliExists = await new Promise((resolve) => {
        try {
          execSync('which redis-cli', { stdio: 'ignore' });
          resolve(true);
        } catch (error) {
          resolve(false);
        }
      });
      
      if (redisCliExists) {
        // Try connecting to Redis
        const redisHost = process.env.REDIS_HOST || 'localhost';
        const redisPort = process.env.REDIS_PORT || 6379;
        
        try {
          if (process.env.REDIS_PASSWORD) {
            execSync(`redis-cli -h ${redisHost} -p ${redisPort} -a ${process.env.REDIS_PASSWORD} ping`, { stdio: 'ignore' });
          } else {
            execSync(`redis-cli -h ${redisHost} -p ${redisPort} ping`, { stdio: 'ignore' });
          }
          console.log('✅ Redis connection successful');
        } catch (error) {
          console.log('❌ Redis connection failed. Session will fall back to in-memory storage.');
          console.log('   This is not recommended for production. Please check your Redis configuration.');
        }
      } else {
        console.log('⚠️  redis-cli not found. Unable to test Redis connection.');
        console.log('   Redis will be tested when the application starts.');
      }
    } catch (error) {
      console.log('❌ Error testing Redis:', error.message);
    }
  } else {
    console.log('\n⚠️  Redis configuration not found. Session will use in-memory storage.');
    console.log('   This is not recommended for production. Configure Redis for better session management.');
  }
  
  // Check API keys
  console.log('\nChecking AI API keys...');
  
  const apiProviders = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'];
  const configuredApis = apiProviders.filter(provider => process.env[provider]);
  
  if (configuredApis.length === 0) {
    console.log('⚠️  No AI API keys configured in environment variables.');
    console.log('   AI features will rely on the keys stored in data/api_keys.json.');
  } else {
    console.log(`✅ Found ${configuredApis.length} API keys configured in environment variables.`);
    configuredApis.forEach(provider => {
      const key = process.env[provider];
      const maskedKey = key.substring(0, 5) + '...' + key.substring(key.length - 5);
      console.log(`   - ${provider}: ${maskedKey}`);
    });
  }
  
  // Final recommendations
  console.log('\n=== Production Recommendations ===');
  console.log('1. Use a process manager like PM2 to keep the application running');
  console.log('   Example: pm2 start server.js --name ssh-client');
  console.log('2. Set up a reverse proxy like Nginx for SSL termination');
  console.log('3. Configure firewall rules to limit access to your server');
  console.log('4. Set up regular backups of the data directory');
  console.log('5. Monitor the application logs for any issues');
  
  console.log('\n=== Setup Complete ===');
  console.log('You can now start the application in production mode with:');
  console.log('   NODE_ENV=production node server.js');
  console.log('Or using the script:');
  console.log('   npm run start:prod');
  
  rl.close();
}

runChecks().catch(error => {
  console.error('Error during setup:', error);
  process.exit(1);
});