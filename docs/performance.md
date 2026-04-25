# Binary Search Performance Analysis

## Overview

`token-votes` resolves historical voting power with `binary_search()` over ordered checkpoints. This document tracks measured CPU instruction cost for realistic checkpoint counts used in governance hot paths (`get_past_votes`, quorum checks, vote casting).

It also tracks the optimized contract WASM sizes that CI enforces during
release builds. The Rust workflow warns when a contract exceeds 80 KiB and
fails when it exceeds 100 KiB.

## Contract WASM Sizes

Measured from:

```bash
cargo build --target wasm32v1-none --release \
  -p sorogov-governor \
  -p sorogov-timelock \
  -p sorogov-token-votes \
  -p sorogov-governor-factory \
  -p sorogov-treasury \
  -p sorogov-liquidity
```

| Contract | Size (bytes) | Size (KiB) | Status |
| -------- | -----------: | ---------: | ------ |
| `sorogov_governor.wasm` | 81,580 | 79.7 | OK |
| `sorogov_governor_factory.wasm` | 17,236 | 16.8 | OK |
| `sorogov_liquidity.wasm` | 18,640 | 18.2 | OK |
| `sorogov_timelock.wasm` | 24,300 | 23.7 | OK |
| `sorogov_token_votes.wasm` | 27,634 | 27.0 | OK |
| `sorogov_treasury.wasm` | 30,351 | 29.6 | OK |

The governor contract is currently the largest artifact and sits just below the
80 KiB warning threshold, so size-sensitive changes there should be watched
closely.

## Load Tests

Implemented in `contracts/token-votes/src/load_tests.rs`:

- `test_cast_vote_with_1000_checkpoints_within_budget`
  - runs query cost checks for 100, 500, and 1000 checkpoints
  - logs max CPU instructions per scale bucket
- `test_binary_search_edge_cases`
  - exact checkpoint ledger
  - before first checkpoint
  - after last checkpoint
  - single-checkpoint history

Each test captures budget cost and asserts `< 100_000_000` CPU instructions (Soroban transaction limit).

## Current Results

| Checkpoints | Max CPU Instructions | % of 100M Limit | Status |
| ----------- | -------------------- | --------------- | ------ |
| 100         | << 100M              | << 1%           | Pass   |
| 500         | << 100M              | << 1%           | Pass   |
| 1000        | << 100M              | << 1%           | Pass   |

Edge cases (before first, exact match, after last, single checkpoint) also stay well below budget.

## Scaling Notes

- Binary search remains O(log n) in comparisons
- Vec access and host metering still grow with larger histories, so we track measured budget, not only asymptotic complexity
- At present, 1000 checkpoints is confirmed safe with wide margin

## Safe Operating Limit

Based on current CI load tests, **1000 checkpoints per account is a verified safe floor** for proposal-time historical lookups.

If future changes push the 1000-checkpoint case near Soroban limits, update this document with:
1. the first failing checkpoint bucket
2. the largest passing bucket
3. mitigation strategy (checkpoint retention/pruning policy)

## Run Locally

```bash
cargo test --package sorogov-token-votes load_tests::
```

## References

- [ADR-001: Checkpoint-based voting power](./adr/adr-001-checkpoint-voting-power.md)
- [ADR-004: Binary search for voting power lookups](./adr/adr-004-binary-search-voting.md)
- [Soroban Resource Limits](https://soroban.stellar.org/docs/fundamentals-and-concepts/resource-limits-fees)
