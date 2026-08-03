const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'bstock-monitor',
      script: path.join(__dirname, 'dist/index.js'),
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      kill_timeout: 15000,
      listen_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/error.log'),
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
