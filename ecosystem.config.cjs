// PM2 ecosystem config for wallet-checker.
// Run a build first (see README), then `pm2 start ecosystem.config.cjs`.
module.exports = {
  apps: [
    {
      name: "wallet-checker-backend",
      script: "npm",
      args: "run start",
      cwd: "./",
      env: {
        PORT: "3002",
      },
    },
    {
      name: "wallet-checker-web",
      script: "npm",
      args: "run start",
      cwd: "./web",
      env: {
        PORT: "3003",
      },
    },
  ],
};
