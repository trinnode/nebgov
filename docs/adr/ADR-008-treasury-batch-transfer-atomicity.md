# ADR-008: Treasury `batch_transfer` atomicity model

## Status
Accepted

## Context

The `treasury` contract holds protocol funds and is used for governance-approved disbursements via `batch_transfer`.

`batch_transfer` moves tokens to multiple recipients in a single call. If the function were to transfer to some recipients and then fail partway through (because a later recipient entry is invalid), the treasury would end up in a partially-executed state:

- some recipients receive funds
- others do not
- the governance intent (“these recipients as a set”) is no longer reflected on-chain

This is especially problematic for protocol funds because partial execution is difficult to reason about and to audit. It also makes it harder for off-chain indexers and dashboards to present a consistent “what happened” story for a proposal-driven payout.

Source: `contracts/treasury/src/lib.rs` (`Treasury::batch_transfer`).

## Decision

Implement **all-or-nothing semantics** for `batch_transfer` using a **two-pass approach**:

1. **Validation pass**: validate *all* `BatchRecipient` entries before executing *any* transfer.
   - recipient list must be non-empty
   - every `amount` must be \(> 0\)
   - recipient address must be well-formed (Soroban `Address` type)
2. **Transfer pass**: after validation succeeds for the entire batch, execute the transfers for all recipients.

If any entry is invalid, the function rejects the entire batch and **no tokens move**.

### Operation hash (`op_hash`) for auditability

`batch_transfer` returns and emits an `op_hash` to uniquely identify the operation for auditing and indexing.

The `op_hash` is a SHA-256 computed over:

- each recipient’s **XDR encoding** (ordered)
- each recipient’s amount encoded as **big-endian bytes** (ordered, paired with recipient)
- the **current ledger sequence** (big-endian bytes)

In other words:

\[
\text{op\_hash} = \text{SHA-256}(\text{recipient}_0\_\text{xdr} \parallel \text{amount}_0 \parallel \dots \parallel \text{recipient}_{n-1}\_\text{xdr} \parallel \text{amount}_{n-1} \parallel \text{ledger\_seq})
\]

Including the ledger sequence ensures the hash is unique across different executions (even with identical recipient lists), while still being deterministic for a single execution. This makes the `op_hash` useful as:

- an **audit handle** that can be correlated with proposal execution
- an **indexing key** for off-chain services that need a stable identifier for a batched payout

## Consequences

- **Strong atomicity guarantee**: either all recipients are paid, or none are.
- **Caller must correct all errors**: there is no “partial recovery” path. If any recipient entry is invalid, the caller must fix the full recipient list and retry.
- **Simpler accounting and auditability**: a proposal-driven disbursement can be treated as a single logical operation, and `op_hash` provides a stable correlation point.
- **Marking failures is explicit**: failures surface immediately as a rejected transaction rather than implicit partial completion.

## Alternatives Considered

1. **Skip invalid recipients and continue**
   - Pros: best-effort payout; one bad entry does not block others.
   - Cons: breaks governance intent (“this batch as a unit”), complicates audit trails, and makes it easy to accidentally ship an incomplete recipient set without noticing.

2. **Single-pass transfer that reverts on first failure (panic-based)**
   - Pros: simpler loop structure.
   - Cons: can still execute transfers before hitting the first failing entry depending on the failure mode; also makes validation logic less explicit and harder to test. The chosen approach makes atomicity an intentional, readable property: validate everything first, then transfer.

## Security Notes

- **Governor-only authorization**: `batch_transfer` requires the caller to be the configured governor address, preventing unauthorized batch calls.
- **Auditability**: `op_hash` is emitted and returned, improving traceability of disbursements.

## Gas / instruction considerations

The two-pass approach iterates over recipients twice and therefore has a higher instruction cost than a single-pass implementation. For treasury disbursements, the correctness and auditability benefits outweigh this overhead, and the design still amortizes overhead compared to many individual transfers/proposals.

## References

- Contract implementation: `contracts/treasury/src/lib.rs` (`Treasury::batch_transfer`)
- Snapshot tests demonstrating the behavior:
  - `contracts/treasury/test_snapshots/tests/test_batch_transfer_all_or_nothing_validation.1.json`
  - `contracts/treasury/test_snapshots/tests/test_batch_transfer_rejects_empty_recipients.1.json`
  - `contracts/treasury/test_snapshots/tests/test_batch_transfer_deterministic_hash.1.json`
  - `contracts/treasury/test_snapshots/tests/test_batch_transfer_requires_governor.1.json`

