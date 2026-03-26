# ADR-005: Ed25519 signatures for delegation-by-sig

## Status
Accepted

## Context
Users should be able to delegate their voting power without submitting a transaction themselves. This enables gasless delegation, where a relayer submits the delegation transaction on behalf of the user.

## Options Considered
1. **On-chain delegation only**: Users must submit a `delegate()` transaction themselves. Simple but requires the delegator to pay gas.
2. **EIP-712 style typed signatures**: Use a typed data structure signed off-chain. Common in EVM but not native to Stellar.
3. **Ed25519 signatures**: Use Stellar's native Ed25519 key pairs to sign a delegation message off-chain, then submit via `delegate_by_sig()`.

## Decision
Use Ed25519 signatures, which are native to all Stellar accounts. The delegator signs a message containing (delegatee, nonce, expiry) with their Stellar private key. Anyone can then submit this signature on-chain.

## Consequences
- Enables gasless delegation for users
- Uses Stellar-native cryptography, no additional dependencies
- Nonce prevents replay attacks
- Expiry prevents stale delegations from being submitted later
- Relayer infrastructure can batch multiple delegations into one transaction
