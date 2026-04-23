# Security Notes

This document summarizes key security protections in NebGov contracts and highlights tradeoffs for production deployments.

## Treasury Reentrancy Analysis

The treasury executes cross-contract calls after reaching multisig approval threshold. Without protections, a malicious target can attempt to re-enter treasury methods during execution.

### Reentrancy Threat Model

Example attack sequence:
1. Attacker deploys malicious contract `M`.
2. Owners approve treasury transaction `T1` targeting `M.attack()`.
3. `M.attack()` re-enters treasury and calls `approve()` on another pending transaction `T2`.
4. `T2` reaches threshold unexpectedly and executes in the same call tree.

Possible impact:
- Unauthorized chaining of approvals.
- Draining treasury through nested execution.
- Inconsistent transaction lifecycle state.

### Implemented Protections

#### 1) State-first execution

Treasury marks `tx.executed = true` before external invocation.

Why this helps:
- Prevents the same transaction from being executed twice in the same flow.
- Preserves a clear execution intent before crossing trust boundaries.

#### 2) Execution lock (`IsExecuting`)

Treasury sets an execution lock before external call and rejects mutable entrypoints while locked.

Protected methods:
- `approve()`
- `submit()`
- `cancel()`

Reentrant calls now revert with `reentrant execution blocked`.

#### 3) Bounded approvals (pending transaction expiry)

Pending transactions expire after a configurable number of ledgers (`pending_expiry_ledgers`).

Why this helps:
- Limits long-lived approval artifacts that can be abused later.
- Forces fresh consensus for stale operations.

Governance control:
- Governor can update expiry via `update_pending_expiry`.
- Expired transactions cannot receive new approvals.

### Testing Strategy

Treasury tests include:
- Mock malicious contract that attempts reentrant `approve()` call during execution.
- Expiry test that advances ledger beyond configured TTL and verifies approval fails.

These tests validate behavior under adversarial control flow and delayed-execution edge cases.

## Operational Recommendations

1. Keep multisig threshold aligned to treasury risk level.
2. Monitor and prune stale pending transactions.
3. Pair treasury operations with a timelock for high-impact actions.
4. Use governance parameter guidance in [parameter-guide.md](./parameter-guide.md) when setting protocol defaults.
