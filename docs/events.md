# Governor Events

This document describes the governor contract events emitted by NebGov. All event payload fields use `snake_case`.

## ProposalCreated

Emitted when a new proposal is created.

| Field | Type | Description |
|---|---|---|
| `proposal_id` | `u64` | Sequential proposal identifier. |
| `proposer` | `Address` | Address that created the proposal. |
| `description` | `String` | Human-readable proposal summary. |
| `targets` | `Vec<Address>` | Contracts targeted by the proposal actions. |
| `fn_names` | `Vec<Symbol>` | Function names paired with `targets`. |
| `calldatas` | `Vec<Bytes>` | Encoded calldata paired with `targets`. |
| `start_ledger` | `u32` | Ledger when voting opens. |
| `end_ledger` | `u32` | Ledger when voting closes. |

## VoteCast

Emitted when a vote is recorded.

| Field | Type | Description |
|---|---|---|
| `proposal_id` | `u64` | Proposal being voted on. |
| `voter` | `Address` | Address that cast the vote. |
| `support` | `u32` | Vote choice: `0 = Against`, `1 = For`, `2 = Abstain`. |
| `weight` | `i128` | Snapshot voting power counted for the vote. |

## ProposalQueued

Emitted when a successful proposal is queued in the timelock.

| Field | Type | Description |
|---|---|---|
| `proposal_id` | `u64` | Proposal moved into the timelock queue. |
| `op_id` | `Bytes` | Timelock operation id for the first queued action. |
| `eta` | `u64` | Earliest execution timestamp reported by the timelock delay. |

## ProposalExecuted

Emitted when a queued proposal is executed.

| Field | Type | Description |
|---|---|---|
| `proposal_id` | `u64` | Proposal that was executed. |
| `caller` | `Address` | Governor contract address that invoked the timelock execution path. |

## ProposalCancelled

Emitted when a proposal is cancelled.

| Field | Type | Description |
|---|---|---|
| `proposal_id` | `u64` | Proposal that was cancelled. |
| `caller` | `Address` | Address that cancelled the proposal. |

## ProposalExpired

Emitted the first time a defeated proposal is evaluated after its voting window has closed.

| Field | Type | Description |
|---|---|---|
| `proposal_id` | `u64` | Proposal whose voting window expired without success. |
| `expired_at_ledger` | `u32` | Proposal `end_ledger`. |

## GovernorUpgraded

Emitted when the governor contract upgrades its WASM.

| Field | Type | Description |
|---|---|---|
| `old_hash` | `BytesN<32>` | Previously stored WASM hash. The initial value is all zeros until the first tracked upgrade. |
| `new_hash` | `BytesN<32>` | New WASM hash applied to the contract. |

## Paused

Emitted when the contract is paused by the authorized pauser role.

| Field | Type | Description |
|---|---|---|
| `pauser` | `Address` | Address that triggered the pause (also appears as the second topic segment). |
| `ledger` | `u32` | Ledger sequence number at which the pause was applied. |

> **Topics:** `["Paused", <pauser address>]`

## Unpaused

Emitted when the contract is unpaused via a governance proposal (contract self-auth).

| Field | Type | Description |
|---|---|---|
| `ledger` | `u32` | Ledger sequence number at which the contract was unpaused. |

> **Topics:** `["Unpaused"]`

## ConfigUpdated

Emitted when governance updates the governor settings.

| Field | Type | Description |
|---|---|---|
| `old_settings` | `GovernorSettings` | Previous configuration values. |
| `new_settings` | `GovernorSettings` | Newly applied configuration values. |

### GovernorSettings fields

| Field | Type | Description |
|---|---|---|
| `voting_delay` | `u32` | Ledgers between proposal creation and voting start. |
| `voting_period` | `u32` | Number of ledgers the vote remains open. |
| `quorum_numerator` | `u32` | Participation threshold numerator, interpreted as a percentage. |
| `proposal_threshold` | `i128` | Minimum voting power required to create proposals. |
