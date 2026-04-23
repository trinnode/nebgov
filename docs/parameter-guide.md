# Governance Parameter Tuning Guide

This guide helps DAO operators choose safe production values for NebGov governance settings.

Poor parameter choices can make governance easy to exploit, especially during low-liquidity periods or when participation is thin.

## Core Parameters

| Parameter | Min Safe | Recommended | Why it matters |
|---|---:|---:|---|
| voting_delay | 1000 ledgers (~90 min) | 17280 ledgers (~24h) | Adds a buffer between proposal creation and voting start |
| voting_period | 17280 ledgers (~24h) | 120960 ledgers (~7d) | Gives delegates and token holders time to review and vote |
| timelock_delay | 17280 ledgers (~24h) | 120960 ledgers (~7d) | Adds an emergency response window before execution |
| quorum_numerator | 1% | 4% | Sets minimum participation required for governance legitimacy |
| proposal_threshold | 0.01% supply | 0.1% supply | Prevents spam and low-effort governance noise |

## Attack Scenarios

### Flash Loan Governance Attack

If `voting_delay` is too short, an attacker can borrow voting power, submit a proposal, and vote before risk teams and delegates react.

Why delay helps:
- Gives monitoring systems time to detect unusual governance activity.
- Gives large delegates time to coordinate a response.
- Raises operational cost of one-block or one-ledger governance attacks.

Practical rule:
- Never run production with near-zero delay.
- Use at least 1000 ledgers for early deployments.
- Prefer 17280 ledgers for mature protocols.

### Low Quorum Exploit

If quorum is too low (or effectively zero), a small minority can pass high-impact proposals during off-hours.

Why quorum matters:
- Enforces broad participation before state-changing actions are accepted.
- Reduces chance of governance capture by thin voting turnout.

Practical rule:
- Do not use 0% quorum.
- 1% is a strict minimum for small communities.
- 4% is a strong default for production DAOs.

### Proposal Spam and Operational Exhaustion

If `proposal_threshold` is too low, attackers can flood governance with junk proposals, increasing review burden and reducing signal quality.

Why threshold matters:
- Requires proposers to hold meaningful stake.
- Reduces spam and governance griefing.
- Keeps delegate attention focused on substantive proposals.

Practical rule:
- Start with 0.1% for production.
- Go as low as 0.01% only if your DAO has strong off-chain filtering and active moderation.

## Tradeoffs by Parameter

### voting_delay
- Too low: vulnerable to fast-borrow and surprise-vote attacks.
- Too high: slows urgent protocol upgrades.

### voting_period
- Too low: excludes global participants and weekend voters.
- Too high: slows iteration and keeps proposals in-flight longer.

### timelock_delay
- Too low: no reaction window after proposal passes.
- Too high: emergency fixes take longer to ship.

### quorum_numerator
- Too low: governance capture risk rises.
- Too high: legitimate changes can become hard to pass.

### proposal_threshold
- Too low: spam and operational burden increase.
- Too high: only whales can propose.

## Preset Configurations

Use these as starting points and tune with observed participation data.

### Conservative (high safety, slower governance)

| Parameter | Value |
|---|---:|
| voting_delay | 24192 ledgers (~33.6h) |
| voting_period | 181440 ledgers (~10.5d) |
| timelock_delay | 120960 ledgers (~7d) |
| quorum_numerator | 6% |
| proposal_threshold | 0.2% supply |

Best for:
- High TVL protocols
- Newly launched DAOs with untested governance dynamics

### Balanced (recommended default)

| Parameter | Value |
|---|---:|
| voting_delay | 17280 ledgers (~24h) |
| voting_period | 120960 ledgers (~7d) |
| timelock_delay | 120960 ledgers (~7d) |
| quorum_numerator | 4% |
| proposal_threshold | 0.1% supply |

Best for:
- Most production DAOs
- Protocols that want safety without stalling operations

### Agile (faster governance, higher operational risk)

| Parameter | Value |
|---|---:|
| voting_delay | 1000 ledgers (~90m) |
| voting_period | 17280 ledgers (~24h) |
| timelock_delay | 17280 ledgers (~24h) |
| quorum_numerator | 2% |
| proposal_threshold | 0.05% supply |

Best for:
- Early-stage protocols with active core contributors
- Low-value environments and staged rollouts

## Ledger to Time Conversion

Approximate conversion used in this guide: 1 ledger is approximately 5 seconds.

| Ledgers | Approx Time |
|---:|---|
| 1000 | 83.3 min (~1h 23m) |
| 17280 | 24 hours |
| 34560 | 48 hours |
| 60480 | 3.5 days |
| 120960 | 7 days |
| 181440 | 10.5 days |

## Rollout Advice

1. Start with the Balanced preset.
2. Measure turnout, execution speed, and proposal quality for at least 4 to 8 weeks.
3. Raise or lower quorum/threshold incrementally, not all at once.
4. Review settings after major token distribution changes.
5. Document parameter rationale in governance proposals so voters can audit decision quality.
