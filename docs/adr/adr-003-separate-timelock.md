# ADR-003: Timelock as a separate contract

## Status
Accepted

## Context
After a proposal passes, there should be a mandatory delay before execution so token holders can react (e.g., exit positions or sell tokens if they disagree). This timelock logic can either be embedded in the governor or deployed as a standalone contract.

## Options Considered
1. **Embedded in governor**: Timelock logic is part of the governor contract. Simpler deployment but larger contract size and tighter coupling.
2. **Separate contract**: Timelock is an independent contract that the governor schedules operations on. More modular but requires cross-contract calls.

## Decision
Deploy the timelock as a separate contract. The governor queues operations by calling `timelock.schedule()`, and anyone can trigger execution after the delay by calling `timelock.execute()`.

## Consequences
- Governor and timelock can be upgraded independently
- Other contracts or DAOs can reuse the same timelock
- Cross-contract call overhead is minimal on Soroban
- Clearer separation of concerns: the governor handles voting, the timelock handles delayed execution
