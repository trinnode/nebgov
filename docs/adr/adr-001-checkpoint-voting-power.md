# ADR-001: Checkpoint-based voting power

## Status
Accepted

## Context
Governance systems need a way to determine how much voting power each participant had at the time a proposal was created. Using real-time token balances is vulnerable to flash-loan attacks, where an attacker borrows tokens, votes, and returns them in a single transaction.

## Options Considered
1. **Real-time balance**: Read current token balance at vote time. Simple but vulnerable to flash loans and double-voting by transferring tokens between accounts.
2. **Snapshot at proposal creation**: Store a full copy of all balances when a proposal is created. Accurate but extremely expensive in storage.
3. **Checkpoint-based**: Record a checkpoint each time a user's voting power changes (via transfer or delegation). Look up historical voting power using the checkpoint history.

## Decision
Use checkpoint-based voting power. The `token-votes` contract records a checkpoint (ledger sequence, voting power) every time a user's delegated voting power changes. When the governor needs voting power at a past ledger, it queries the checkpoint history.

## Consequences
- Voting power lookups are O(log n) via binary search over checkpoints
- Each delegation or transfer writes one checkpoint entry per affected account
- Storage grows linearly with the number of delegation changes, not with the number of proposals
- Immune to flash-loan attacks since voting power is locked at the proposal creation ledger
