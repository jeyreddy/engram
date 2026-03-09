// PM2 process file — run both prod and sandbox instances on the same machine.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 stop  engram-prod
//   pm2 logs  engram-sandbox
//
// Fill in ANTHROPIC_API_KEY and ENGRAM_TOKEN before deploying.

module.exports = {
  apps: [
    {
      name:   'engram-prod',
      script: 'src/server/index.js',
      interpreter: 'node',
      // PM2 passes --experimental-vm-modules automatically when "type":"module"
      // is set in package.json.
      env: {
        PORT:              3000,
        NODE_ENV:          'production',
        WORKSPACE_PATH:    'C:\\engram-workspace\\prod',
        ANTHROPIC_API_KEY: '',   // fill in
        ENGRAM_TOKEN:      '',   // fill in
      },
    },
    {
      name:   'engram-sandbox',
      script: 'src/server/index.js',
      interpreter: 'node',
      env: {
        PORT:              3001,
        NODE_ENV:          'sandbox',
        WORKSPACE_PATH:    'C:\\engram-workspace\\sandbox',
        ANTHROPIC_API_KEY: '',   // fill in
        ENGRAM_TOKEN:      '',   // fill in (use a different token from prod)
      },
    },
  ],
};
