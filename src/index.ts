import express from "express";
import { env } from "./config/env.js";
import healthRouter from "./routes/health.js";
import walletRouter from "./routes/wallet.js";
import walletsRouter from "./routes/wallets.js";
import groupsRouter from "./routes/groups.js";
import testRouter from "./routes/test.js";

const app = express();

app.use(express.json());

app.use("/health", healthRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/wallets", walletsRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/test", testRouter);

app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT}`);
  console.log(`Solana cluster: ${env.SOLANA_CLUSTER}`);
});
