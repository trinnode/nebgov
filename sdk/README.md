# @nebgov/sdk

TypeScript SDK for interacting with NebGov governor, timelock, votes, and treasury contracts on Stellar.

API reference lives in [../docs/sdk.md](../docs/sdk.md).

## Install

```bash
pnpm install
pnpm --filter @nebgov/sdk build
```

## Tests

Unit tests:

```bash
pnpm --filter @nebgov/sdk test
```

Read-only testnet integration tests:

```bash
pnpm --filter @nebgov/sdk test:integration
```

The integration suite is skipped automatically when the required environment
variables are not set.

## Integration Test Environment

Set these variables before running `test:integration` locally or in CI:

```bash
export TESTNET_SECRET_KEY="S..."
export GOVERNOR_ADDRESS="C..."
export TIMELOCK_ADDRESS="C..."
export TOKEN_VOTES_ADDRESS="C..."
```

Optional overrides:

```bash
export TESTNET_RPC_URL="https://soroban-testnet.stellar.org"
```

Notes:

- `TESTNET_SECRET_KEY` must belong to a funded Stellar testnet account.
- The suite is read-only: it only performs RPC simulation and ledger reads.
- The secret key's public key is used as the SDK `simulationAccount` so
  read-only contract calls have a valid source account on testnet.
