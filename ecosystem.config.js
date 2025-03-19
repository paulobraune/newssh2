module.exports = {
  apps: [{
    name: 'ssh-client',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3011
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    combine_logs: true,
    error_file: 'logs/error.log',
    out_file: 'logs/access.log',
    time: true
  }]
};