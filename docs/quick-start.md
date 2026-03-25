# Quick Start — Deploy a Governor in 10 Minutes

This guide walks you through deploying NebGov to Stellar testnet and creating your first proposal.

## Prerequisites

- Rust + `cargo` installed
- `stellar-cli` installed: `cargo install stellar-cli --locked`
- Node.js 18+ and pnpm: `npm i -g pnpm`
- A funded testnet account (get XLM from [friendbot](https://friendbot.stellar.org))

## 1. Clone the repo

```bash
git clone https://github.com/nebgov/nebgov
cd nebgov
```

## 2. Automated deploy (recommended)

The fastest way to get all contracts deployed and initialized:

```bash
cp .env.example .env.testnet   # adjust defaults if desired
./scripts/deploy-testnet.sh
```

The script will:
1. Build all WASM contracts
2. Create and fund a testnet identity (if needed)
3. Deploy contracts in dependency order: token-votes → timelock → governor → treasury → factory
4. Initialize each contract with sensible defaults
5. Write the deployed addresses to `.env.testnet`

Re-run the script at any time — it skips already-deployed contracts.

> **Tip:** Override defaults by editing `.env.testnet` before running the
> script, or pass `ENV_FILE=path/to/file ./scripts/deploy-testnet.sh`.

## 3. Manual deploy

If you prefer to deploy step by step, follow the sections below.

### 3a. Build contracts

```bash
cargo build --release --target wasm32-unknown-unknown
```

Compiled WASM files will be in `target/wasm32-unknown-unknown/release/`.

### 3b. Set up your identity

```bash
stellar keys generate --global deployer --network testnet
stellar keys fund deployer --network testnet
```

### 3c. Deploy the token-votes contract

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/sorogov_token_votes.wasm \
  --source deployer \
  --network testnet \
  -- \
  --admin $(stellar keys address deployer) \
  --token <YOUR_SEP41_TOKEN_ADDRESS>
```

Save the output address as `VOTES_ADDRESS`.

### 3d. Deploy the timelock contract

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/sorogov_timelock.wasm \
  --source deployer \
  --network testnet \
  -- \
  --admin $(stellar keys address deployer) \
  --governor PLACEHOLDER \
  --min_delay 3600
```

Save the output address as `TIMELOCK_ADDRESS`.

### 3e. Deploy the governor contract

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/sorogov_governor.wasm \
  --source deployer \
  --network testnet \
  -- \
  --admin $(stellar keys address deployer) \
  --votes_token $VOTES_ADDRESS \
  --timelock $TIMELOCK_ADDRESS \
  --voting_delay 100 \
  --voting_period 1000 \
  --quorum_numerator 4 \
  --proposal_threshold 100000000
```

Save the output address as `GOVERNOR_ADDRESS`.

## 4. Create your first proposal (SDK)

```typescript
import { GovernorClient, VoteSupport } from "@nebgov/sdk";
import { Keypair } from "@stellar/stellar-sdk";

const signer = Keypair.fromSecret("S...");

const client = new GovernorClient({
  governorAddress: process.env.GOVERNOR_ADDRESS!,
  timelockAddress: process.env.TIMELOCK_ADDRESS!,
  votesAddress: process.env.VOTES_ADDRESS!,
  network: "testnet",
});

// Activate voting power by self-delegating
const { VotesClient } = await import("@nebgov/sdk");
const votesClient = new VotesClient({ ... });
await votesClient.delegate(signer, signer.publicKey());

// Create proposal
const proposalId = await client.propose(signer, "My first proposal");
console.log("Created proposal:", proposalId);
```

## 5. Run the frontend

```bash
pnpm install
cp app/.env.example app/.env.local
# Edit app/.env.local with your contract addresses
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Next Steps

- Read the [Architecture Overview](./architecture.md) to understand the full contract flow
- See the [SDK API Reference](./sdk.md) for all available methods
- Open an issue or PR to contribute — see [CONTRIBUTING.md](../CONTRIBUTING.md)
