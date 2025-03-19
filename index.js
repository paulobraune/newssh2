const { Client } = require('ssh2');
const promptSync = require('prompt-sync')({ sigint: true });

// SSH connection configuration
const sshConfig = {
  host: 'hostname_or_ip',   // Replace with your server hostname or IP
  port: 22,                 // Default SSH port
  username: 'username',     // Replace with your username
  password: 'password'      // Replace with your password
  // If you use key-based authentication, comment out password and use:
  // privateKey: require('fs').readFileSync('/path/to/private/key')
};

// Create a new SSH client
const conn = new Client();

// Handle connection
conn.on('ready', () => {
  console.log('SSH connection established successfully!');
  console.log('Type "exit" to disconnect\n');
  
  // Start interactive shell session
  conn.shell((err, stream) => {
    if (err) {
      console.error('Shell error:', err);
      conn.end();
      return;
    }

    // Handle server responses
    stream.on('data', (data) => {
      process.stdout.write(data);
    });

    stream.on('close', () => {
      console.log('\nSSH connection closed');
      conn.end();
      process.exit(0);
    });

    // Interactive prompt loop
    const promptUser = () => {
      const command = promptSync('> ');
      
      if (command.toLowerCase() === 'exit') {
        stream.end('exit\n');
        return;
      }
      
      stream.write(`${command}\n`);
      
      // Wait briefly for response before showing prompt again
      setTimeout(promptUser, 500);
    };

    promptUser();
  });
});

conn.on('error', (err) => {
  console.error('Connection error:', err);
});

// Connect to the server
console.log('Connecting to SSH server...');
conn.connect(sshConfig);