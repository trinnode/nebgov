# ADR-004: Binary search for historical voting power

## Status
Accepted

## Context
The checkpoint-based voting system (ADR-001) stores a list of (ledger, voting_power) entries for each account. When the governor needs to look up voting power at a specific past ledger, it needs an efficient search algorithm.

## Options Considered
1. **Linear scan**: Iterate from the most recent checkpoint backward. O(n) per lookup, simple to implement.
2. **Binary search**: Search the sorted checkpoint array. O(log n) per lookup, more complex but scales better.
3. **Mapping by ledger**: Store voting power indexed by ledger number. O(1) lookup but requires writing at every ledger, not just on changes.

## Decision
Use binary search over the checkpoint array. Checkpoints are naturally sorted by ledger sequence, so binary search works without additional indexing.

## Consequences
- Voting power lookups are O(log n) where n is the number of checkpoints for that account
- No wasted storage for ledgers where nothing changed
- Implementation complexity is modest since the array is always sorted
- Scales well even for accounts with thousands of delegation changes
