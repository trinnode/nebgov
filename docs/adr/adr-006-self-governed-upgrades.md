# ADR-006: Governor upgrade auth is the contract itself

## Status
Accepted

## Context
Smart contracts on Soroban can be upgraded by calling `env.deployer().update_current_contract_wasm()`. The question is who should have the authority to trigger this upgrade for the governor contract.

## Options Considered
1. **Admin-controlled upgrades**: A designated admin address can upgrade the contract at any time. Fast but centralized.
2. **Multi-sig upgrades**: A set of signers must approve upgrades. Better than single admin but still a trust assumption.
3. **Self-governed upgrades**: The governor contract itself is the only authorized upgrader. Upgrades must pass through the full governance process.

## Decision
The governor's `upgrade()` function requires `env.current_contract_address().require_auth()`. This means the only way to authorize an upgrade is through the governor's own governance process: a proposal must pass, be queued in the timelock, and then executed. The timelock's cross-contract call satisfies the auth requirement.

## Consequences
- No external key or multisig can upgrade the contract
- Upgrades are subject to the full governance process including timelock delay
- Token holders have time to react before an upgrade takes effect
- Upgrades cannot be rolled back once executed, so thorough testing on testnet is critical
- Migration logic must be included in the same proposal if the storage layout changes
