module.exports = {
  apps: [{
    name: 'image-engine',
    script: 'npx',
    args: 'tsx apps/image-engine/src/main.ts',
    cwd: '/opt/image-engine-app',
    node_args: '--expose-gc',
    max_memory_restart: '1G',
    exp_backoff_restart_delay: 100,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_size: '10M',
    retain: 3,
    compress: true,
  }],
};
