# SSH Client with Web Interface

This is a Node.js web application that provides an SSH client with a browser-based terminal interface.

## Features

- Connect to SSH servers from a web browser
- Interactive terminal interface
- Real-time command execution and response display
- Session management

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Start the application:
   ```
   npm start
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## How It Works

This application uses:
- Express.js for the web server
- EJS for templating
- Socket.IO for real-time communication
- SSH2 for SSH connections

## Usage

1. Enter your SSH connection details on the login page:
   - Host (IP address or hostname)
   - Port (default is 22)
   - Username
   - Password

2. After connecting, you'll see a terminal interface where you can:
   - Type commands and press Enter to execute them on the remote server
   - View the server's responses in real-time
   - Disconnect when finished

## Security Notes

This application is meant for development and personal use. In a production environment, consider these security enhancements:

- Use HTTPS
- Implement stronger session security
- Add authentication for the web interface
- Consider adding support for SSH key-based authentication