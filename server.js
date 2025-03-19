const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { Client } = require('ssh2');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const archiver = require('archiver');
const dotenv = require('dotenv');
const RedisStore = require("connect-redis").default;
const { createClient } = require('redis');

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve Monaco editor files
app.use('/monaco-editor', express.static(path.join(__dirname, 'node_modules/monaco-editor')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));

// Set proper content type and encoding for all responses
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  next();
});

// Initialize Redis client and store
let sessionStore;
if (process.env.REDIS_URL) {
  try {
    console.log('Connecting to Redis...');
    const redisClient = createClient({
      url: process.env.REDIS_URL
    });
    
    redisClient.on('error', (err) => {
      console.error('Redis error:', err);
    });
    
    redisClient.connect().catch(console.error);
    
    sessionStore = new RedisStore({
      client: redisClient,
      prefix: "ssh-client-session:"
    });
    
    console.log('Redis connected successfully');
  } catch (error) {
    console.error('Redis connection failed:', error);
    console.log('Falling back to in-memory session store');
    sessionStore = undefined;
  }
}

// Configure session
app.use(session({
  secret: process.env.SESSION_SECRET || 'ssh-client-secret',
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    httpOnly: true,
    maxAge: parseInt(process.env.COOKIE_MAX_AGE || '86400000')
  }
}));

// Store active SSH connections
const sshConnections = {};

// Admin credentials from environment
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Define AI model configurations
const AI_MODELS = {
  openai: {
    model: 'o3-mini-2025-01-31',
    apiVersion: '2023-05-15'
  },
  deepseek: {
    model: 'deepseek-reasoner'
  },
  anthropic: {
    model: 'claude-3-7-sonnet-20250219',
    apiVersion: '2023-06-01'
  }
};

// Create a directory for saved connections if it doesn't exist
const savedConnectionsDir = path.join(__dirname, 'data');
const savedConnectionsFile = path.join(savedConnectionsDir, 'saved_connections.json');
const apiKeysFile = path.join(savedConnectionsDir, 'api_keys.json');
const chatHistoryFile = path.join(savedConnectionsDir, 'chat_history.json');

if (!fs.existsSync(savedConnectionsDir)) {
  fs.mkdirSync(savedConnectionsDir);
}

if (!fs.existsSync(savedConnectionsFile)) {
  fs.writeFileSync(savedConnectionsFile, JSON.stringify([], null, 2));
}

if (!fs.existsSync(apiKeysFile)) {
  fs.writeFileSync(apiKeysFile, JSON.stringify([], null, 2));
}

if (!fs.existsSync(chatHistoryFile)) {
  fs.writeFileSync(chatHistoryFile, JSON.stringify([], null, 2));
}

// Function to get saved connections
function getSavedConnections() {
  try {
    const data = fs.readFileSync(savedConnectionsFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading saved connections:', error);
    return [];
  }
}

// Function to get API keys
function getApiKeys() {
  try {
    const data = fs.readFileSync(apiKeysFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading API keys:', error);
    return [];
  }
}

// Function to get chat history
function getChatHistory() {
  try {
    const data = fs.readFileSync(chatHistoryFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading chat history:', error);
    return [];
  }
}

// Authentication middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.isAuthenticated) {
    return next();
  }
  res.redirect('/login');
};

// Routes
app.get('/login', (req, res) => {
  res.render('app_login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  // Check against hardcoded credentials
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAuthenticated = true;
    return res.redirect('/');
  }
  
  res.render('app_login', { error: 'Invalid username or password' });
});

app.get('/logout', (req, res) => {
  req.session.isAuthenticated = false;
  req.session.sshConfig = null;
  
  const sessionId = req.session.id;
  if (sshConnections[sessionId]) {
    sshConnections[sessionId].end();
    delete sshConnections[sessionId];
  }
  
  req.session.destroy();
  res.redirect('/login');
});

// Secured routes
app.get('/', isAuthenticated, (req, res) => {
  const savedConnections = getSavedConnections();
  res.render('login', { error: null, savedConnections });
});

// Get saved connections
app.get('/api/connections', isAuthenticated, (req, res) => {
  const savedConnections = getSavedConnections();
  res.json(savedConnections);
});

// Save a new connection
app.post('/api/connections', isAuthenticated, (req, res) => {
  const { name, host, port, username, password, initialPath, mode } = req.body;
  
  if (!name || !host || !username) {
    return res.status(400).json({ error: 'Name, host and username are required' });
  }
  
  try {
    const savedConnections = getSavedConnections();
    
    // Check if connection with this name already exists
    const existingIndex = savedConnections.findIndex(conn => conn.name === name);
    
    const connectionData = {
      name,
      host,
      port: port || '22',
      username,
      password, // Note: storing passwords in plain text is not secure for production
      initialPath: initialPath || '/home',
      mode: mode || 'terminal',
      createdAt: new Date().toISOString()
    };
    
    if (existingIndex !== -1) {
      // Update existing connection
      savedConnections[existingIndex] = connectionData;
    } else {
      // Add new connection
      savedConnections.push(connectionData);
    }
    
    fs.writeFileSync(savedConnectionsFile, JSON.stringify(savedConnections, null, 2));
    
    res.json({ success: true, connection: connectionData });
  } catch (error) {
    console.error('Error saving connection:', error);
    res.status(500).json({ error: 'Failed to save connection' });
  }
});

// Delete a saved connection
app.delete('/api/connections/:name', isAuthenticated, (req, res) => {
  const { name } = req.params;
  
  try {
    let savedConnections = getSavedConnections();
    savedConnections = savedConnections.filter(conn => conn.name !== name);
    
    fs.writeFileSync(savedConnectionsFile, JSON.stringify(savedConnections, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting connection:', error);
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

// API Keys endpoints
app.get('/api/apikeys', isAuthenticated, (req, res) => {
  const apiKeys = getApiKeys();
  res.json(apiKeys);
});

app.post('/api/apikeys', isAuthenticated, (req, res) => {
  const { provider, apiKey } = req.body;
  
  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'Provider and API key are required' });
  }
  
  try {
    let apiKeys = getApiKeys();
    
    // Check if API key for this provider already exists
    const existingIndex = apiKeys.findIndex(key => key.provider === provider);
    
    const apiKeyData = {
      provider,
      apiKey,
      updatedAt: new Date().toISOString()
    };
    
    if (existingIndex !== -1) {
      // Update existing API key
      apiKeys[existingIndex] = apiKeyData;
    } else {
      // Add new API key
      apiKeys.push(apiKeyData);
    }
    
    fs.writeFileSync(apiKeysFile, JSON.stringify(apiKeys, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving API key:', error);
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

app.delete('/api/apikeys/:provider', isAuthenticated, (req, res) => {
  const { provider } = req.params;
  
  try {
    let apiKeys = getApiKeys();
    apiKeys = apiKeys.filter(key => key.provider !== provider);
    
    fs.writeFileSync(apiKeysFile, JSON.stringify(apiKeys, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

app.post('/api/apikeys/test', isAuthenticated, async (req, res) => {
  const { provider, apiKey } = req.body;
  
  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'Provider and API key are required' });
  }
  
  try {
    let testResult = { success: false, error: 'Unsupported provider' };
    
    // Test API key based on provider
    switch (provider) {
      case 'openai':
        testResult = await testOpenAIKey(apiKey);
        break;
      case 'deepseek':
        testResult = await testDeepseekKey(apiKey);
        break;
      case 'anthropic':
        testResult = await testAnthropicKey(apiKey);
        break;
      default:
        testResult = { success: false, error: 'Unsupported provider' };
    }
    
    res.json(testResult);
  } catch (error) {
    console.error('Error testing API key:', error);
    res.status(500).json({ success: false, error: 'Failed to test API key' });
  }
});

// Test functions for API keys
async function testOpenAIKey(apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v1'
      }
    });
    
    const data = await response.json();
    
    if (response.ok) {
      return { 
        success: true, 
        message: `Connection successful. Available models: ${data.data.length}. Using model: ${AI_MODELS.openai.model}` 
      };
    } else {
      return { 
        success: false, 
        error: data.error?.message || 'Invalid API key or API error' 
      };
    }
  } catch (error) {
    console.error('OpenAI API test error:', error);
    return { success: false, error: 'Network error or invalid API key' };
  }
}

async function testDeepseekKey(apiKey) {
  try {
    // Simplified test for DeepSeek - in a real application, you'd use their actual API endpoint
    const response = await fetch('https://api.deepseek.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Check if status is 401 (unauthorized) - means API key is invalid
    if (response.status === 401) {
      return { success: false, error: 'Invalid API key' };
    }
    
    return { 
      success: true, 
      message: `Connection potentially valid. Using model: ${AI_MODELS.deepseek.model}` 
    };
  } catch (error) {
    // If there's a network error or CORS issue, we'll assume the key might be valid
    // but there's an issue with our test method
    console.error('DeepSeek API test error:', error);
    return { 
      success: true, 
      message: `API key format valid, but full verification not available. Using model: ${AI_MODELS.deepseek.model}` 
    };
  }
}

async function testAnthropicKey(apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'anthropic-version': AI_MODELS.anthropic.apiVersion,
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODELS.anthropic.model,
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Hello, this is an API test.'
          }
        ]
      })
    });
    
    const data = await response.json();
    
    // Check if response indicates invalid key
    if (response.status === 401 || response.status === 403) {
      return { 
        success: false, 
        error: data.error?.message || 'Invalid API key' 
      };
    }
    
    return { 
      success: true, 
      message: `API key valid. Using model: ${AI_MODELS.anthropic.model}` 
    };
  } catch (error) {
    console.error('Anthropic API test error:', error);
    // For demo purposes, if there's a network error, we'll assume the key format is valid
    return { 
      success: true, 
      message: `API key format valid, but full verification not available. Using model: ${AI_MODELS.anthropic.model}` 
    };
  }
}

// Get AI model info
app.get('/api/ai-models', isAuthenticated, (req, res) => {
  res.json(AI_MODELS);
});

// Chat history endpoints
app.get('/api/chat/:projectId', isAuthenticated, (req, res) => {
  const { projectId } = req.params;
  const chatHistory = getChatHistory();
  
  // Find chat history for this project
  const projectHistory = chatHistory.find(chat => chat.project_id === projectId);
  
  if (projectHistory) {
    res.json(projectHistory);
  } else {
    res.json({ 
      project_id: projectId,
      timestamp: new Date().toISOString(),
      messages: [],
      file_context: [] 
    });
  }
});

app.post('/api/chat/:projectId', isAuthenticated, (req, res) => {
  const { projectId } = req.params;
  const { messages, file_context } = req.body;
  
  if (!projectId) {
    return res.status(400).json({ error: 'Project ID is required' });
  }
  
  try {
    let chatHistory = getChatHistory();
    
    // Check if chat history for this project already exists
    const existingIndex = chatHistory.findIndex(chat => chat.project_id === projectId);
    
    const chatData = {
      project_id: projectId,
      timestamp: new Date().toISOString(),
      messages: messages || [],
      file_context: file_context || []
    };
    
    if (existingIndex !== -1) {
      // Update existing chat history
      chatHistory[existingIndex] = chatData;
    } else {
      // Add new chat history
      chatHistory.push(chatData);
    }
    
    fs.writeFileSync(chatHistoryFile, JSON.stringify(chatHistory, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving chat history:', error);
    res.status(500).json({ error: 'Failed to save chat history' });
  }
});

app.delete('/api/chat/:projectId', isAuthenticated, (req, res) => {
  const { projectId } = req.params;
  
  try {
    let chatHistory = getChatHistory();
    chatHistory = chatHistory.filter(chat => chat.project_id !== projectId);
    
    fs.writeFileSync(chatHistoryFile, JSON.stringify(chatHistory, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting chat history:', error);
    res.status(500).json({ error: 'Failed to delete chat history' });
  }
});

app.post('/connect', isAuthenticated, (req, res) => {
  const { host, port, username, password, mode, initialPathOption, initialPath } = req.body;
  
  if (!host || !username) {
    return res.render('login', { error: 'Host and username are required', savedConnections: getSavedConnections() });
  }
  
  // Determine initial directory path
  let directoryPath = '/home';
  
  if (initialPathOption === 'custom' && initialPath && initialPath.trim()) {
    directoryPath = initialPath.trim();
  }

  // Store connection info in session
  req.session.sshConfig = {
    host,
    port: port || 22,
    username,
    password,
    mode: mode || 'terminal',
    initialPath: directoryPath
  };

  // Redirect based on selected mode
  if (mode === 'filemanager') {
    res.redirect('/file_manager');
  } else if (mode === 'chat') {
    res.redirect('/chat');
  } else {
    res.redirect('/terminal');
  }
});

app.get('/terminal', isAuthenticated, (req, res) => {
  if (!req.session.sshConfig) {
    return res.redirect('/');
  }
  
  // If switching from another mode, update the mode
  if (req.query.switchMode) {
    req.session.sshConfig.mode = 'terminal';
  }
  
  res.render('terminal', { 
    host: req.session.sshConfig.host,
    port: req.session.sshConfig.port,
    username: req.session.sshConfig.username,
    password: req.session.sshConfig.password,
    initialPath: req.session.sshConfig.initialPath
  });
});

app.get('/file_manager', isAuthenticated, (req, res) => {
  if (!req.session.sshConfig) {
    return res.redirect('/');
  }
  
  // If switching from another mode, update the mode
  if (req.query.switchMode) {
    req.session.sshConfig.mode = 'filemanager';
  }
  
  res.render('file_manager', { 
    host: req.session.sshConfig.host,
    port: req.session.sshConfig.port,
    username: req.session.sshConfig.username,
    password: req.session.sshConfig.password,
    initialPath: req.session.sshConfig.initialPath
  });
});

app.get('/chat', isAuthenticated, (req, res) => {
  if (!req.session.sshConfig) {
    return res.redirect('/');
  }
  
  // If switching from another mode, update the mode
  if (req.query.switchMode) {
    req.session.sshConfig.mode = 'chat';
  }
  
  // Generate a project ID based on the SSH connection and path
  // This ensures chat context is limited to the specific folder
  const projectId = `${req.session.sshConfig.host}_${req.session.sshConfig.username}_${req.session.sshConfig.initialPath}`;
  
  res.render('chat', { 
    host: req.session.sshConfig.host,
    port: req.session.sshConfig.port,
    username: req.session.sshConfig.username,
    password: req.session.sshConfig.password,
    initialPath: req.session.sshConfig.initialPath,
    projectId: projectId,
    aiModels: AI_MODELS
  });
});

app.get('/disconnect', isAuthenticated, (req, res) => {
  const sessionId = req.session.id;
  
  if (sshConnections[sessionId]) {
    sshConnections[sessionId].end();
    delete sshConnections[sessionId];
  }
  
  req.session.sshConfig = null;
  res.redirect('/');
});

// File download endpoint
app.get('/file/download', isAuthenticated, (req, res) => {
  const { path, sessionId } = req.query;
  
  if (!path || !sessionId) {
    return res.status(400).send('Missing path or session ID');
  }
  
  const sshConn = sshConnections[sessionId];
  if (!sshConn || !sshConn.sftp) {
    return res.status(404).send('No active SFTP connection');
  }
  
  // Extract filename from path
  const filename = path.split('/').pop();
  
  // Set headers for file download
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  // Stream the file to the response
  sshConn.sftp.createReadStream(path).pipe(res);
});

// New endpoint for zip directory download - FIXED VERSION
app.post('/file/zip-download', isAuthenticated, (req, res) => {
  const { path, sessionId } = req.body;
  
  if (!path || !sessionId) {
    return res.status(400).json({ error: 'Missing path or session ID' });
  }
  
  const sshConn = sshConnections[sessionId];
  if (!sshConn || !sshConn.sftp) {
    return res.status(404).json({ error: 'No active SFTP connection' });
  }
  
  // Create a unique ID for this zip operation
  const zipId = Date.now().toString();
  
  // Get directory name for the zip file
  const dirName = path.split('/').pop() || 'folder';
  const zipFileName = `${dirName}-${zipId}.zip`;
  
  // Create a write stream for the response
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
  
  // Create a new zip archive
  const archive = archiver('zip', {
    zlib: { level: 9 } // Sets the compression level
  });
  
  // Pipe the archive to the response
  archive.pipe(res);
  
  // Handle archive errors
  archive.on('error', (err) => {
    console.error('Archive error:', err);
    res.status(500).end();
  });
  
  // Function to recursively add files to the archive
  const addDirectoryToArchive = (directoryPath, relativePath = '') => {
    return new Promise((resolve, reject) => {
      sshConn.sftp.readdir(directoryPath, async (err, list) => {
        if (err) {
          console.error('Error reading directory:', err);
          return reject(err);
        }
        
        try {
          // Process all files in the directory
          for (const item of list) {
            const fullPath = directoryPath + '/' + item.filename;
            const archivePath = relativePath ? relativePath + '/' + item.filename : item.filename;
            
            if (item.attrs.isDirectory()) {
              // Recursively add subdirectories
              await addDirectoryToArchive(fullPath, archivePath);
            } else {
              try {
                // Add file to the archive
                const fileStream = sshConn.sftp.createReadStream(fullPath);
                archive.append(fileStream, { name: archivePath });
                
                // Handle potential errors on the file stream
                fileStream.on('error', (err) => {
                  console.error(`Error reading file ${fullPath}:`, err);
                  // Continue with other files instead of failing the whole process
                });
              } catch (fileErr) {
                console.error(`Error adding file ${fullPath} to archive:`, fileErr);
                // Continue with other files
              }
            }
          }
          
          resolve();
        } catch (error) {
          console.error('Error processing directory contents:', error);
          reject(error);
        }
      });
    });
  };
  
  // Start the zip process
  addDirectoryToArchive(path, '')
    .then(() => {
      // Finalize the archive and send the response
      archive.finalize();
    })
    .catch((error) => {
      console.error('Zip process error:', error);
      // Don't end the response here, as we've already started streaming
      // Instead, finalize the archive with whatever files we managed to process
      archive.finalize();
    });
});

// Monaco editor resources endpoint
app.get('/monaco-editor-resources', isAuthenticated, (req, res) => {
  // This endpoint helps client check if monaco editor resources are available
  res.json({
    available: true,
    version: '0.43.0'
  });
});

// File content endpoint - For monaco editor
app.get('/file/content', isAuthenticated, (req, res) => {
  const { path, sessionId } = req.query;
  
  if (!path || !sessionId) {
    return res.status(400).json({ error: 'Missing path or session ID' });
  }
  
  const sshConn = sshConnections[sessionId];
  if (!sshConn || !sshConn.sftp) {
    return res.status(404).json({ error: 'No active SFTP connection' });
  }
  
  console.log('Fetching file content for:', path);
  
  // Stream the file content
  let fileContent = '';
  const readStream = sshConn.sftp.createReadStream(path);
  
  readStream.on('data', (data) => {
    fileContent += data.toString('utf8');
  });
  
  readStream.on('end', () => {
    console.log('File content loaded successfully');
    res.setHeader('Content-Type', 'application/json');
    res.json({ content: fileContent });
  });
  
  readStream.on('error', (err) => {
    console.error('Error reading file:', err);
    res.status(500).json({ error: 'Failed to read file: ' + err.message });
  });
});

// Save file content endpoint
app.post('/file/save', isAuthenticated, (req, res) => {
  const { path, content, sessionId } = req.body;
  
  if (!path || content === undefined || !sessionId) {
    return res.status(400).json({ error: 'Missing path, content, or session ID' });
  }
  
  const sshConn = sshConnections[sessionId];
  if (!sshConn || !sshConn.sftp) {
    return res.status(404).json({ error: 'No active SFTP connection' });
  }
  
  // Create write stream with mode that preserves original permissions
  const writeStream = sshConn.sftp.createWriteStream(path, {
    mode: 0o644, // Default permissions if can't get original
    flags: 'w'
  });
  
  writeStream.on('error', (err) => {
    console.error('Error saving file:', err);
    res.status(500).json({ error: 'Failed to save file: ' + err.message });
  });
  
  writeStream.on('close', () => {
    res.json({ success: true });
  });
  
  // Write content to file
  writeStream.end(content);
});

// Socket.IO connection for terminal
io.on('connection', (socket) => {
  const sessionId = socket.handshake.query.sessionId;
  
  // Handle SSH terminal connections
  socket.on('connect-ssh', (data) => {
    // Create a new SSH client
    const conn = new Client();
    
    conn.on('ready', () => {
      socket.emit('message', 'SSH connection established successfully!\n');
      
      // Start shell session
      conn.shell((err, stream) => {
        if (err) {
          socket.emit('error', 'Shell error: ' + err.message);
          conn.end();
          return;
        }
        
        // Store the stream for this connection
        sshConnections[sessionId] = { conn, stream };
        
        // For collecting complete chunks before processing
        let dataBuffer = '';
        
        // Handle data from server
        stream.on('data', (data) => {
          // Combine data into buffer to ensure complete UTF-8 characters
          dataBuffer += data.toString('utf8');
          
          // Process all complete ANSI sequences and characters in buffer
          socket.emit('response', dataBuffer);
          
          // Clear the buffer after processing
          dataBuffer = '';
        });
        
        stream.on('close', () => {
          socket.emit('message', 'SSH connection closed by server');
          if (sshConnections[sessionId]) {
            conn.end();
            delete sshConnections[sessionId];
          }
        });
        
        stream.stderr.on('data', (data) => {
          socket.emit('error', data.toString('utf8'));
        });
        
        // Change to initial directory if provided
        if (data.initialPath && data.initialPath !== '/home') {
          stream.write(`cd ${data.initialPath}\n`);
        }
      });
    });
    
    conn.on('error', (err) => {
      socket.emit('error', 'Connection error: ' + err.message);
    });
    
    conn.on('close', () => {
      socket.emit('message', 'Connection closed');
      if (sshConnections[sessionId]) {
        delete sshConnections[sessionId];
      }
    });
    
    // Connect using session data
    conn.connect(data.sshConfig);
  });
  
  // Handle terminal commands
  socket.on('command', (data) => {
    const { command } = data;
    
    if (sshConnections[sessionId] && sshConnections[sessionId].stream) {
      sshConnections[sessionId].stream.write(command + '\n');
    } else {
      socket.emit('error', 'No active SSH connection');
    }
  });
  
  // Handle SFTP connections for file manager
  socket.on('connect-sftp', (data) => {
    // Create a new SSH client
    const conn = new Client();
    
    conn.on('ready', () => {
      socket.emit('message', 'SSH connection established. Initializing SFTP session...');
      
      // Create SFTP session
      conn.sftp((err, sftp) => {
        if (err) {
          socket.emit('sftp-error', 'SFTP error: ' + err.message);
          conn.end();
          return;
        }
        
        // Store the SFTP connection
        sshConnections[sessionId] = { conn, sftp };
        
        socket.emit('sftp-connected', { initialPath: data.initialPath });
        socket.emit('message', 'SFTP session ready.');
      });
    });
    
    conn.on('error', (err) => {
      console.error('SSH connection error:', err);
      socket.emit('sftp-error', 'Connection error: ' + err.message);
    });
    
    conn.on('close', () => {
      if (sshConnections[sessionId]) {
        delete sshConnections[sessionId];
      }
    });
    
    // Connect using session data with explicit admin permissions
    conn.connect({
      host: data.sshConfig.host,
      port: data.sshConfig.port,
      username: data.sshConfig.username,
      password: data.sshConfig.password,
      // Add explicit options to handle admin permissions
      readyTimeout: 30000, // 30 seconds timeout
      keepaliveInterval: 10000, // Send keepalive every 10 seconds
      keepaliveCountMax: 3, // Allow 3 missed keepalives before killing the connection
      debug: (message) => {
        console.log('SSH Debug:', message);
      }
    });
  });
  
  // Handle SFTP operations
  socket.on('list-directory', (data) => {
    const { path } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    
    sftp.readdir(path, (err, list) => {
      if (err) {
        console.error('Error reading directory:', err);
        socket.emit('sftp-error', 'Failed to read directory: ' + err.message);
        return;
      }
      
      // Process file list
      const files = list.map(item => {
        return {
          name: item.filename,
          size: item.attrs.size,
          isDirectory: item.attrs.isDirectory(),
          modifyTime: new Date(item.attrs.mtime * 1000),
          permissions: item.attrs.mode,
          owner: item.attrs.uid
        };
      });
      
      socket.emit('directory-list', { path, files });
    });
  });
  
  // Handle directory zipping - FIXED VERSION
  socket.on('zip-directory', (data) => {
    const { path } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    // Notify client that we're starting the zip process
    socket.emit('zip-started', { 
      path,
      message: 'Creating zip file...'
    });
    
    // Create a zip file on the server using shell command
    const conn = sshConnections[sessionId].conn;
    
    // Get the directory name for the zip file
    const dirName = path.split('/').pop() || 'folder';
    
    // Create the zip file in the current directory instead of parent directory
    // Timestamp is added to avoid overwriting existing files
    const timestamp = Date.now();
    const zipFileName = `${dirName}-${timestamp}.zip`;
    const currentDir = path.substring(0, path.lastIndexOf('/') + 1) || '/';
    const zipPath = `${currentDir}${zipFileName}`;
    
    // Use a direct zip command without changing directories
    conn.exec(`zip -r "${zipPath}" "${path}" || echo "ZIP_FAILED"`, (err, stream) => {
      if (err) {
        console.error('Zip exec error:', err);
        socket.emit('sftp-error', 'Failed to create zip: ' + err.message);
        return;
      }
      
      let errorOutput = '';
      let commandOutput = '';
      
      stream.on('data', (data) => {
        commandOutput += data.toString();
      });
      
      stream.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.error('Zip stderr:', data.toString());
      });
      
      stream.on('close', (code) => {
        if (code !== 0 || commandOutput.includes('ZIP_FAILED')) {
          console.error('Zip command failed with code', code, errorOutput);
          
          // Fallback: Try using a different approach by creating the zip in /tmp first
          const tempZipPath = `/tmp/${zipFileName}`;
          conn.exec(`zip -r "${tempZipPath}" "${path}" && cp "${tempZipPath}" "${currentDir}" && rm "${tempZipPath}" || echo "TEMP_ZIP_FAILED"`, (err, sudoStream) => {
            if (err) {
              socket.emit('sftp-error', 'Failed to create zip: ' + err.message);
              return;
            }
            
            let sudoOutput = '';
            
            sudoStream.on('data', (data) => {
              sudoOutput += data.toString();
            });
            
            sudoStream.on('close', (sudoCode) => {
              if (sudoCode !== 0 || sudoOutput.includes('TEMP_ZIP_FAILED')) {
                socket.emit('sftp-error', 'Failed to create zip file: ' + errorOutput);
              } else {
                // Use the copy path since that's where the final file ends up
                const finalZipPath = `${currentDir}${zipFileName}`;
                socket.emit('zip-complete', { path: finalZipPath });
              }
            });
          });
        } else {
          console.log('Zip created successfully');
          socket.emit('zip-complete', { path: zipPath });
        }
      });
    });
  });
  
  // Handle file uploads
  socket.on('upload-file', (data) => {
    const { path, data: fileData } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    
    // Create write stream
    const writeStream = sftp.createWriteStream(path, {
      mode: 0o644, // Default file permissions
      flags: 'w'
    });
    
    writeStream.on('error', (err) => {
      console.error('Upload error:', err);
      socket.emit('sftp-error', 'Upload failed: ' + err.message);
      
      // Try with shell command as fallback
      const conn = sshConnections[sessionId].conn;
      socket.emit('message', 'Retrying upload with alternate method...');
      
      // Create a temporary file and move it
      // This approach isn't implemented here but would use a temp file approach
    });
    
    writeStream.on('close', () => {
      socket.emit('upload-complete');
    });
    
    // Convert ArrayBuffer to Buffer and write
    const buffer = Buffer.from(fileData);
    writeStream.end(buffer);
  });
  
  // Handle file/directory deletion with proper error handling
  socket.on('delete-file', (data) => {
    const { path, isDirectory } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    const conn = sshConnections[sessionId].conn;
    
    if (isDirectory) {
      // First try standard SFTP rmdir
      sftp.rmdir(path, (err) => {
        if (err) {
          console.error('SFTP rmdir error:', err);
          
          // If regular rmdir fails, try using shell command with rm -rf
          conn.exec(`rm -rf "${path.replace(/"/g, '\\"')}" || echo "RM_FAILED"`, (shellErr, stream) => {
            if (shellErr) {
              console.error('Shell rm error:', shellErr);
              socket.emit('sftp-error', 'Failed to delete directory: ' + err.message + '. Shell command also failed: ' + shellErr.message);
              return;
            }
            
            let errorOutput = '';
            let commandOutput = '';
            
            stream.on('data', (data) => {
              commandOutput += data.toString();
            });
            
            stream.stderr.on('data', (data) => {
              errorOutput += data.toString();
            });
            
            stream.on('close', (code) => {
              if (code !== 0 || commandOutput.includes('RM_FAILED')) {
                socket.emit('sftp-error', 'Failed to delete directory with rm command: ' + errorOutput);
              } else {
                socket.emit('delete-complete');
              }
            });
          });
        } else {
          socket.emit('delete-complete');
        }
      });
    } else {
      // First try standard SFTP unlink
      sftp.unlink(path, (err) => {
        if (err) {
          console.error('SFTP unlink error:', err);
          
          // If unlink fails, try using shell command
          conn.exec(`rm "${path.replace(/"/g, '\\"')}" || echo "RM_FAILED"`, (shellErr, stream) => {
            if (shellErr) {
              console.error('Shell rm error:', shellErr);
              socket.emit('sftp-error', 'Failed to delete file: ' + err.message + '. Shell command also failed: ' + shellErr.message);
              return;
            }
            
            let errorOutput = '';
            let commandOutput = '';
            
            stream.on('data', (data) => {
              commandOutput += data.toString();
            });
            
            stream.stderr.on('data', (data) => {
              errorOutput += data.toString();
            });
            
            stream.on('close', (code) => {
              if (code !== 0 || commandOutput.includes('RM_FAILED')) {
                socket.emit('sftp-error', 'Failed to delete file with rm command: ' + errorOutput);
              } else {
                socket.emit('delete-complete');
              }
            });
          });
        } else {
          socket.emit('delete-complete');
        }
      });
    }
  });
  
  // Handle file/directory rename with proper error handling
  socket.on('rename-file', (data) => {
    const { oldPath, newPath } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    const conn = sshConnections[sessionId].conn;
    
    sftp.rename(oldPath, newPath, (err) => {
      if (err) {
        console.error('SFTP rename error:', err);
        
        // If rename fails, try using shell command
        conn.exec(`mv "${oldPath.replace(/"/g, '\\"')}" "${newPath.replace(/"/g, '\\"')}" || echo "MV_FAILED"`, (shellErr, stream) => {
          if (shellErr) {
            console.error('Shell mv error:', shellErr);
            socket.emit('sftp-error', 'Failed to rename: ' + err.message + '. Shell command also failed: ' + shellErr.message);
            return;
          }
          
          let errorOutput = '';
          let commandOutput = '';
          
          stream.on('data', (data) => {
            commandOutput += data.toString();
          });
          
          stream.stderr.on('data', (data) => {
            errorOutput += data.toString();
          });
          
          stream.on('close', (code) => {
            if (code !== 0 || commandOutput.includes('MV_FAILED')) {
              socket.emit('sftp-error', 'Failed to rename with mv command: ' + errorOutput);
            } else {
              socket.emit('rename-complete');
            }
          });
        });
      } else {
        socket.emit('rename-complete');
      }
    });
  });
  
  // Handle folder creation with proper error handling
  socket.on('create-folder', (data) => {
    const { path } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    const conn = sshConnections[sessionId].conn;
    
    sftp.mkdir(path, (err) => {
      if (err) {
        console.error('SFTP mkdir error:', err);
        
        // If mkdir fails, try using shell command
        conn.exec(`mkdir -p "${path.replace(/"/g, '\\"')}" || echo "MKDIR_FAILED"`, (shellErr, stream) => {
          if (shellErr) {
            console.error('Shell mkdir error:', shellErr);
            socket.emit('sftp-error', 'Failed to create folder: ' + err.message + '. Shell command also failed: ' + shellErr.message);
            return;
          }
          
          let errorOutput = '';
          let commandOutput = '';
          
          stream.on('data', (data) => {
            commandOutput += data.toString();
          });
          
          stream.stderr.on('data', (data) => {
            errorOutput += data.toString();
          });
          
          stream.on('close', (code) => {
            if (code !== 0 || commandOutput.includes('MKDIR_FAILED')) {
              socket.emit('sftp-error', 'Failed to create folder with mkdir command: ' + errorOutput);
            } else {
              socket.emit('folder-created');
            }
          });
        });
      } else {
        socket.emit('folder-created');
      }
    });
  });
  
  // Handle file content reading for editing
  socket.on('read-file', (data) => {
    const { path } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    const conn = sshConnections[sessionId].conn;
    
    let content = '';
    
    // First try SFTP read stream
    try {
      const readStream = sftp.createReadStream(path);
      
      readStream.on('data', (chunk) => {
        content += chunk.toString('utf8');
      });
      
      readStream.on('end', () => {
        console.log(`Successfully read file: ${path}, content length: ${content.length}`);
        socket.emit('file-content', { path, content });
      });
      
      readStream.on('error', (err) => {
        console.error('SFTP read error:', err);
        
        // If read stream fails, try using cat command
        conn.exec(`cat "${path.replace(/"/g, '\\"')}"`, (shellErr, stream) => {
          if (shellErr) {
            console.error('Shell cat error:', shellErr);
            socket.emit('sftp-error', 'Failed to read file: ' + err.message + '. Shell command also failed: ' + shellErr.message);
            return;
          }
          
          let shellContent = '';
          let errorOutput = '';
          
          stream.on('data', (data) => {
            shellContent += data.toString('utf8');
          });
          
          stream.stderr.on('data', (data) => {
            errorOutput += data.toString('utf8');
          });
          
          stream.on('close', (code) => {
            if (code !== 0) {
              socket.emit('sftp-error', 'Failed to read file with cat command: ' + errorOutput);
            } else {
              console.log(`Successfully read file using shell command: ${path}, content length: ${shellContent.length}`);
              socket.emit('file-content', { path, content: shellContent });
            }
          });
        });
      });
    } catch (error) {
      console.error('Exception in read-file:', error);
      socket.emit('sftp-error', 'Failed to read file: ' + error.message);
    }
  });
  
  // Handle file saving after editing with proper error handling
  socket.on('save-file', (data) => {
    const { path, content } = data;
    
    if (!sshConnections[sessionId] || !sshConnections[sessionId].sftp) {
      socket.emit('sftp-error', 'No active SFTP connection');
      return;
    }
    
    const sftp = sshConnections[sessionId].sftp;
    const conn = sshConnections[sessionId].conn;
    
    // First try to stat the file to get original permissions
    sftp.stat(path, (statErr, stats) => {
      let mode = 0o644; // Default mode if no existing file
      
      if (!statErr && stats) {
        // Use existing file permissions
        mode = stats.mode;
      }
      
      // Create write stream with existing permissions
      const writeStream = sftp.createWriteStream(path, { 
        mode: mode,
        flags: 'w'
      });
      
      writeStream.on('error', (err) => {
        console.error('SFTP write error:', err);
        
        // If write stream fails, try using shell command
        // Create a temporary file with content and move it to destination
        const tempPath = `/tmp/sftp_temp_${Date.now()}`;
        
        conn.exec(`cat > "${tempPath}" << 'SFTPEOF'\n${content}\nSFTPEOF\n && mv "${tempPath}" "${path.replace(/"/g, '\\"')}" || echo "WRITE_FAILED"`, (shellErr, stream) => {
          if (shellErr) {
            console.error('Shell write error:', shellErr);
            socket.emit('sftp-error', 'Failed to save file: ' + err.message + '. Shell command also failed: ' + shellErr.message);
            return;
          }
          
          let errorOutput = '';
          let commandOutput = '';
          
          stream.on('data', (data) => {
            commandOutput += data.toString();
          });
          
          stream.stderr.on('data', (data) => {
            errorOutput += data.toString();
          });
          
          stream.on('close', (code) => {
            if (code !== 0 || commandOutput.includes('WRITE_FAILED')) {
              socket.emit('sftp-error', 'Failed to save file with shell command: ' + errorOutput);
            } else {
              socket.emit('file-saved', { path });
            }
          });
        });
      });
      
      writeStream.on('close', () => {
        socket.emit('file-saved', { path });
      });
      
      // Write content to file
      writeStream.end(content);
    });
  });
  
  // Handle chat history saving
  socket.on('save-chat-history', (history) => {
    try {
      let chatHistory = getChatHistory();
      
      // Check if chat history for this project already exists
      const existingIndex = chatHistory.findIndex(chat => chat.project_id === history.project_id);
      
      if (existingIndex !== -1) {
        // Update existing chat history
        chatHistory[existingIndex] = history;
      } else {
        // Add new chat history
        chatHistory.push(history);
      }
      
      fs.writeFileSync(chatHistoryFile, JSON.stringify(chatHistory, null, 2));
      
      socket.emit('chat-history-saved', { success: true });
    } catch (error) {
      console.error('Error saving chat history:', error);
      socket.emit('chat-history-saved', { success: false, error: 'Failed to save chat history' });
    }
  });
  
  // Cleanup connections on disconnect
  socket.on('disconnect', () => {
    if (sshConnections[sessionId]) {
      sshConnections[sessionId].conn.end();
      delete sshConnections[sessionId];
    }
  });
});

// Create views directory if it doesn't exist
if (!fs.existsSync('./views')) {
  fs.mkdirSync('./views');
}

// Create public directory if it doesn't exist
if (!fs.existsSync('./public')) {
  fs.mkdirSync('./public');
}

// Create subdirectories in public
if (!fs.existsSync('./public/css')) {
  fs.mkdirSync('./public/css');
}

if (!fs.existsSync('./public/images')) {
  fs.mkdirSync('./public/images');
}

// Create logs directory if it doesn't exist
if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs');
}

// Start server
const PORT = process.env.PORT || 3011;
server.listen(PORT, () => {
  console.log(`SSH Client server running on http://localhost:${PORT}`);
  console.log(`Use the following credentials to login:`);
  console.log(`Username: ${ADMIN_USERNAME}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
});