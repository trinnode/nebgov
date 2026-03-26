# ADR-002: No admin/owner role - fully permissionless design

## Status
Accepted

## Context
Many governance systems include an admin or owner role that can bypass the governance process for convenience or emergency actions. This creates a centralization risk and undermines the purpose of on-chain governance.

## Options Considered
1. **Admin with override**: Include an admin key that can execute proposals without voting. Faster for emergencies but creates trust assumptions.
2. **Admin with limited powers**: Admin can cancel proposals but not execute them. Partial trust.
3. **No admin role**: All actions must go through the full governance process. Fully permissionless.

## Decision
NebGov has no admin or owner role. Every state change to the governor, timelock, and treasury must pass through a governance vote with quorum and majority, followed by the timelock delay.

## Consequences
- No single point of failure or trust
- Emergency responses require a fast-tracked proposal (short voting period is still configurable)
- The only way to upgrade contracts is through governance
- Aligns with Stellar ecosystem values of decentralization
