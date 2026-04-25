# Liquidity Contract

The liquidity contract manages protocol-owned or community-provided liquidity
for pairs of governance-related outcome assets. It exposes a simple
constant-product AMM surface:

- liquidity providers add liquidity and receive LP shares
- liquidity providers remove liquidity proportionally
- traders swap one outcome asset for the other
- governance can update pool fees through a timelocked proposal

## Design Goals

- Provide a small, auditable pool primitive for NebGov-managed markets
- Keep ordinary user flows self-authorized and easy to reason about
- Restrict protocol-level configuration changes to governance execution

## Public Functions

| Function | Purpose | Authorization |
| --- | --- | --- |
| `initialize(governor)` | Stores the governor address used for privileged actions | `governor.require_auth()` |
| `governor()` | Returns the configured governor address | Read-only |
| `add_liquidity(provider, outcome_a, outcome_b, amount_a, amount_b)` | Adds reserves and mints LP shares | `provider.require_auth()` |
| `remove_liquidity(provider, outcome_a, outcome_b, lp_tokens)` | Burns LP shares and returns reserves | `provider.require_auth()` |
| `swap(trader, outcome_in, outcome_out, amount_in, min_amount_out)` | Executes a constant-product swap | `trader.require_auth()` |
| `update_pool_fee(caller, outcome_a, outcome_b, fee_bps)` | Updates the pool trading fee | `caller.require_auth()` and `caller == governor` |
| `get_pool(outcome_a, outcome_b)` | Returns reserves, LP supply, and fee | Read-only |
| `get_lp_position(provider, outcome_a, outcome_b)` | Returns LP token balance | Read-only |
| `get_price(outcome_a, outcome_b)` | Returns `reserve_b / reserve_a * 10_000` | Read-only |

## Governance Integration

Privileged liquidity updates are intended to run through the standard NebGov
execution path:

`Governor proposal -> Timelock queue -> Timelock execute -> Liquidity contract`

For `update_pool_fee`, encode the call arguments as an XDR `ScVec` and use the
liquidity contract as the proposal target:

```ts
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

const calldata = xdr.ScVal.scvVec([
  nativeToScVal(governorAddress, { type: "address" }),
  nativeToScVal(0, { type: "u32" }),
  nativeToScVal(1, { type: "u32" }),
  nativeToScVal(75, { type: "u32" }),
]).toXDR();

await governorClient.propose(
  signer,
  "Update pool fee",
  descriptionHash,
  "ipfs://proposal-metadata",
  [liquidityAddress],
  ["update_pool_fee"],
  [calldata],
);
```

That calldata layout matches the timelock execution model: the timelock reads
the stored XDR bytes, decodes them into Soroban values, and forwards those
arguments to the target function during proposal execution.

## Security Considerations

- Only the configured governor can change pool fees.
- Pool fee updates are capped at `1000` basis points (10%) to avoid accidental
  or malicious extreme settings.
- `add_liquidity` rejects zero and sub-minimum deposits.
- `remove_liquidity` rejects overdrafts of LP shares.
- `swap` enforces `min_amount_out` so callers can protect themselves against
  slippage.
- Governance-controlled changes should still rely on a meaningful timelock
  delay so token holders have time to react before fee changes take effect.
