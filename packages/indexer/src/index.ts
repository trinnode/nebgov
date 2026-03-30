import { SorobanRpc } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { initDb, pool } from "./db";
import { processEvents, getLastIndexedLedger, updateLastIndexedLedger } from "./events";
import { createApp } from "./api";

dotenv.config();

const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS ?? "";
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 3001);

async function runIndexer(): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

  const config = {
    rpcUrl: RPC_URL,
    governorAddress: GOVERNOR_ADDRESS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };

  let lastLedger = await getLastIndexedLedger();

  console.log(`Starting indexer from ledger ${lastLedger}`);

  while (true) {
    const latestLedger = await processEvents(server, config, lastLedger + 1);
    if (latestLedger > lastLedger) {
      await updateLastIndexedLedger(latestLedger);
      lastLedger = latestLedger;
      console.log(`Indexed up to ledger ${lastLedger}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  await initDb();
  console.log("Database initialized");

  // Start REST API server
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`NebGov indexer API running on port ${PORT}`);
  });

  // Start indexer loop
  runIndexer().catch((err) => {
    console.error("Indexer fatal error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
