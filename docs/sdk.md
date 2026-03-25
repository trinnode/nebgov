# @nebgov/sdk API Reference

The NebGov SDK provides TypeScript clients for interacting with the NebGov on-chain governance framework on Stellar. This document covers all exported classes, methods, types, and provides complete usage examples.

## Table of Contents

- [Installation](#installation)
- [Core Classes](#core-classes)
  - [GovernorClient](#governorclient)
  - [VotesClient](#votesclient)
  - [TimelockClient](#timelockclient)
- [Event System](#event-system)
- [TypeScript Types](#typescript-types)
- [Error Handling](#error-handling)
- [Complete Example](#complete-example)

## Installation

```bash
npm install @nebgov/sdk
# or
pnpm add @nebgov/sdk
```

## Core Classes

### GovernorClient

Interact with a deployed NebGov governor contract for proposal management and voting.

#### Constructor

```typescript
constructor(config: GovernorConfig)
```

**Parameters:**
- `config: GovernorConfig` - Configuration object containing contract addresses and network settings

**Example:**
```typescript
import { GovernorClient } from "@nebgov/sdk";

const client = new GovernorClient({
  governorAddress: "CABC...",
  timelockAddress: "CDEF...",
  votesAddress: "CGHI...",
  network: "testnet",
  rpcUrl: "https://custom-rpc.example.com" // optional
});
```

#### Methods

##### propose()

Create a new governance proposal.

```typescript
async propose(signer: Keypair, description: string): Promise<bigint>
```

**Parameters:**
- `signer: Keypair` - Stellar keypair authorized to create proposals
- `description: string` - Human-readable description of the proposal

**Returns:** `Promise<bigint>` - The ID of the created proposal

**Example:**
```typescript
const proposalId = await client.propose(keypair, "Upgrade protocol fee to 0.3%");
console.log(`Proposal created with ID: ${proposalId}`);
```

##### castVote()

Cast a vote on an active proposal.

```typescript
async castVote(signer: Keypair, proposalId: bigint, support: VoteSupport): Promise<void>
```

**Parameters:**
- `signer: Keypair` - Stellar keypair of the voter
- `proposalId: bigint` - ID of the proposal to vote on
- `support: VoteSupport` - Vote direction (For, Against, or Abstain)

**Returns:** `Promise<void>`

**Example:**
```typescript
import { VoteSupport } from "@nebgov/sdk";

await client.castVote(keypair, 1n, VoteSupport.For);
```

##### getProposalState()

Get the current state of a proposal.

```typescript
async getProposalState(proposalId: bigint): Promise<ProposalState>
```

**Parameters:**
- `proposalId: bigint` - ID of the proposal to query

**Returns:** `Promise<ProposalState>` - Current state of the proposal

**Example:**
```typescript
const state = await client.getProposalState(1n);
console.log(`Proposal state: ${state}`);
```

##### getProposalVotes()

Get vote breakdown for a proposal.

```typescript
async getProposalVotes(proposalId: bigint): Promise<ProposalVotes>
```

**Parameters:**
- `proposalId: bigint` - ID of the proposal to query

**Returns:** `Promise<ProposalVotes>` - Vote counts for/against/abstain

**Example:**
```typescript
const votes = await client.getProposalVotes(1n);
console.log(`For: ${votes.votesFor}, Against: ${votes.votesAgainst}, Abstain: ${votes.votesAbstain}`);
```

##### proposalCount()

Get total number of proposals.

```typescript
async proposalCount(): Promise<bigint>
```

**Returns:** `Promise<bigint>` - Total number of proposals created

**Example:**
```typescript
const count = await client.proposalCount();
console.log(`Total proposals: ${count}`);
```

### VotesClient

Interact with the token-votes contract for delegation and voting power queries.

#### Constructor

```typescript
constructor(config: GovernorConfig)
```

**Parameters:**
- `config: GovernorConfig` - Configuration object (same as GovernorClient)

**Example:**
```typescript
import { VotesClient } from "@nebgov/sdk";

const votesClient = new VotesClient({
  governorAddress: "CABC...",
  timelockAddress: "CDEF...",
  votesAddress: "CGHI...",
  network: "testnet"
});
```

#### Methods

##### delegate()

Delegate voting power to another address.

```typescript
async delegate(signer: Keypair, delegatee: string): Promise<void>
```

**Parameters:**
- `signer: Keypair` - Stellar keypair of the delegator
- `delegatee: string` - Stellar address to delegate voting power to

**Returns:** `Promise<void>`

**Example:**
```typescript
await votesClient.delegate(keypair, "GDEF...");
```

##### getVotes()

Get current voting power of an address.

```typescript
async getVotes(account: string): Promise<bigint>
```

**Parameters:**
- `account: string` - Stellar address to query

**Returns:** `Promise<bigint>` - Current voting power

**Example:**
```typescript
const votingPower = await votesClient.getVotes("GDEF...");
console.log(`Voting power: ${votingPower}`);
```

##### getPastVotes()

Get voting power at a past ledger sequence.

```typescript
async getPastVotes(account: string, ledger: number): Promise<bigint>
```

**Parameters:**
- `account: string` - Stellar address to query
- `ledger: number` - Past ledger sequence number

**Returns:** `Promise<bigint>` - Voting power at the specified ledger

**Example:**
```typescript
const pastPower = await votesClient.getPastVotes("GDEF...", 500000);
console.log(`Voting power at ledger 500000: ${pastPower}`);
```

##### getDelegatee()

Get current delegatee of an account.

```typescript
async getDelegatee(account: string): Promise<string | null>
```

**Parameters:**
- `account: string` - Stellar address to query

**Returns:** `Promise<string | null>` - Address of the current delegatee, or null if self-delegated

**Example:**
```typescript
const delegatee = await votesClient.getDelegatee("GDEF...");
if (delegatee) {
  console.log(`Delegated to: ${delegatee}`);
} else {
  console.log("Self-delegated");
}
```

### TimelockClient

Interact with a deployed NebGov timelock contract for delayed execution of governance actions.

#### Constructor

```typescript
constructor(config: GovernorConfig)
```

**Parameters:**
- `config: GovernorConfig` - Configuration object (same as GovernorClient)

**Example:**
```typescript
import { TimelockClient } from "@nebgov/sdk";

const timelockClient = new TimelockClient({
  governorAddress: "CABC...",
  timelockAddress: "CDEF...",
  votesAddress: "CGHI...",
  network: "testnet"
});
```

#### Methods

##### schedule()

Schedule a timelock operation.

```typescript
async schedule(signer: Keypair, target: string, data: Buffer, delay: bigint): Promise<string>
```

**Parameters:**
- `signer: Keypair` - Keypair authorising the call (must be the governor signer)
- `target: string` - Strkey address of the contract to invoke on execution
- `data: Buffer` - Encoded calldata for the target invocation
- `delay: bigint` - Delay in seconds; must be >= the contract's `minDelay`

**Returns:** `Promise<string>` - Hex-encoded operation ID (SHA-256 of `data`)

**Example:**
```typescript
const calldata = Buffer.from("encoded_function_call", "utf8");
const opId = await timelockClient.schedule(keypair, "TARGET...", calldata, 86400n);
console.log(`Operation scheduled with ID: ${opId}`);
```

##### execute()

Execute a ready timelock operation.

```typescript
async execute(signer: Keypair, opId: string): Promise<void>
```

**Parameters:**
- `signer: Keypair` - Keypair authorising the call (must be the governor signer)
- `opId: string` - Hex-encoded operation ID returned by `schedule()`

**Returns:** `Promise<void>`

**Example:**
```typescript
await timelockClient.execute(keypair, "abc123...");
```

##### cancel()

Cancel a pending timelock operation.

```typescript
async cancel(signer: Keypair, opId: string): Promise<void>
```

**Parameters:**
- `signer: Keypair` - Keypair authorising the call (admin or governor signer)
- `opId: string` - Hex-encoded operation ID returned by `schedule()`

**Returns:** `Promise<void>`

**Example:**
```typescript
await timelockClient.cancel(keypair, "abc123...");
```

##### isReady()

Check whether an operation is ready for execution.

```typescript
async isReady(opId: string): Promise<boolean>
```

**Parameters:**
- `opId: string` - Hex-encoded operation ID

**Returns:** `Promise<boolean>` - True if operation is ready to execute

**Example:**
```typescript
const ready = await timelockClient.isReady("abc123...");
if (ready) {
  console.log("Operation is ready for execution");
}
```

##### isPending()

Check whether an operation is pending.

```typescript
async isPending(opId: string): Promise<boolean>
```

**Parameters:**
- `opId: string` - Hex-encoded operation ID

**Returns:** `Promise<boolean>` - True if operation is pending (delay not yet elapsed)

**Example:**
```typescript
const pending = await timelockClient.isPending("abc123...");
if (pending) {
  console.log("Operation is still pending");
}
```

##### minDelay()

Get the minimum enforced delay for new operations.

```typescript
async minDelay(): Promise<bigint>
```

**Returns:** `Promise<bigint>` - Minimum delay in seconds

**Example:**
```typescript
const minDelay = await timelockClient.minDelay();
console.log(`Minimum delay: ${minDelay} seconds`);
```

## Event System

The SDK provides utilities for subscribing to governance events.

### subscribeToProposals()

Subscribe to new `propose` events emitted by a NebGov governor contract.

```typescript
function subscribeToProposals(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void
```

**Parameters:**
- `governorAddress: string` - Strkey contract address of the governor
- `callback: (event: SorobanEvent) => void` - Invoked with each decoded proposal event
- `opts: SubscriptionOptions` - Network, optional RPC URL, and polling interval

**Returns:** `() => void` - Unsubscribe function to stop polling

**Example:**
```typescript
const unsub = subscribeToProposals(
  "CABC...",
  (event) => console.log("New proposal!", event),
  { network: "testnet" }
);

// Later...
unsub(); // Stop listening
```

### subscribeToVotes()

Subscribe to `vote` events on a specific proposal.

```typescript
function subscribeToVotes(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void
```

**Parameters:**
- `governorAddress: string` - Strkey contract address of the governor
- `proposalId: bigint` - The proposal to watch for votes
- `callback: (event: SorobanEvent) => void` - Invoked with each decoded vote event
- `opts: SubscriptionOptions` - Network, optional RPC URL, and polling interval

**Returns:** `() => void` - Unsubscribe function to stop polling

**Example:**
```typescript
const unsub = subscribeToVotes(
  "CABC...",
  1n,
  (event) => console.log("Vote cast!", event),
  { network: "testnet" }
);

// Later...
unsub(); // Stop listening
```

### getProposalEvents()

Fetch historical `propose` events from a governor contract.

```typescript
async function getProposalEvents(
  governorAddress: string,
  fromLedger: number,
  opts: SubscriptionOptions
): Promise<SorobanEvent[]>
```

**Parameters:**
- `governorAddress: string` - Strkey contract address of the governor
- `fromLedger: number` - Ledger sequence to start scanning from
- `opts: SubscriptionOptions` - Network and optional RPC URL

**Returns:** `Promise<SorobanEvent[]>` - Array of decoded proposal events

**Example:**
```typescript
const events = await getProposalEvents("CABC...", 500_000, {
  network: "testnet"
});
console.log(`Found ${events.length} historical proposals`);
```

## TypeScript Types

### Core Types

#### Network

```typescript
type Network = "mainnet" | "testnet" | "futurenet";
```

#### ProposalState

```typescript
enum ProposalState {
  Pending = "Pending",
  Active = "Active",
  Defeated = "Defeated",
  Succeeded = "Succeeded",
  Queued = "Queued",
  Executed = "Executed",
  Cancelled = "Cancelled",
}
```

#### VoteSupport

```typescript
enum VoteSupport {
  Against = 0,
  For = 1,
  Abstain = 2,
}
```

### Interface Types

#### GovernorConfig

```typescript
interface GovernorConfig {
  /** Contract address of the governor */
  governorAddress: string;
  /** Contract address of the timelock */
  timelockAddress: string;
  /** Contract address of the token-votes contract */
  votesAddress: string;
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public horizon) */
  rpcUrl?: string;
}
```

#### Proposal

```typescript
interface Proposal {
  id: bigint;
  proposer: string;
  description: string;
  startLedger: number;
  endLedger: number;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
  executed: boolean;
  cancelled: boolean;
}
```

#### ProposalVotes

```typescript
interface ProposalVotes {
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
}
```

#### TimelockOperation

```typescript
interface TimelockOperation {
  id: string; // hex-encoded operation hash
  target: string;
  readyAt: bigint;
  executed: boolean;
  cancelled: boolean;
}
```

#### TreasuryTx

```typescript
interface TreasuryTx {
  id: bigint;
  proposer: string;
  target: string;
  approvals: number;
  executed: boolean;
  cancelled: boolean;
}
```

#### SorobanEvent

```typescript
interface SorobanEvent {
  /** Ledger sequence the event was emitted in */
  ledger: number;
  /** Contract that emitted the event */
  contractId: string;
  /** Decoded topic segments (symbol strings) */
  topic: string[];
  /** Decoded event body value */
  value: unknown;
}
```

#### SubscriptionOptions

```typescript
interface SubscriptionOptions {
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public endpoint) */
  rpcUrl?: string;
  /**
   * Polling interval in milliseconds.
   * @default 10_000
   */
  intervalMs?: number;
}
```

## Error Handling

### UnknownProposalStateError

Thrown when an unknown proposal state variant is encountered.

```typescript
class UnknownProposalStateError extends Error {
  constructor(variant: string)
}
```

**When thrown:** When decoding a proposal state from the contract returns an unrecognized variant.

**Example:**
```typescript
try {
  const state = await client.getProposalState(proposalId);
} catch (error) {
  if (error instanceof UnknownProposalStateError) {
    console.error(`Unknown proposal state: ${error.message}`);
  }
}
```

### Transaction Errors

All client methods that submit transactions may throw errors for:

- Network connectivity issues
- Transaction failures (insufficient balance, invalid signatures, etc.)
- Simulation errors (contract reverts, invalid parameters)
- Transaction confirmation timeouts

**Example:**
```typescript
try {
  await client.propose(keypair, "My proposal");
} catch (error) {
  console.error("Proposal failed:", error.message);
  // Handle different error types appropriately
}
```

## Complete Example

This example demonstrates a complete governance workflow: deploy → propose → vote → execute.

```typescript
import { 
  GovernorClient, 
  VotesClient, 
  TimelockClient,
  VoteSupport,
  ProposalState,
  GovernorConfig,
  Keypair
} from "@nebgov/sdk";
import { Networks, BASE_FEE } from "@stellar/stellar-sdk";

// Configuration
const config: GovernorConfig = {
  governorAddress: "CABC123...", // Replace with actual governor contract
  timelockAddress: "CDEF456...", // Replace with actual timelock contract
  votesAddress: "CGHI789...",   // Replace with actual votes contract
  network: "testnet"
};

// Initialize clients
const governorClient = new GovernorClient(config);
const votesClient = new VotesClient(config);
const timelockClient = new TimelockClient(config);

// Key pairs (replace with actual key pairs)
const proposer = Keypair.fromSecret("S...");
const voter1 = Keypair.fromSecret("S...");
const voter2 = Keypair.fromSecret("S...");

async function completeGovernanceFlow() {
  try {
    console.log("=== NebGov Complete Governance Flow ===\n");

    // 1. Check current voting power
    console.log("1. Checking voting power...");
    const proposerPower = await votesClient.getVotes(proposer.publicKey());
    const voter1Power = await votesClient.getVotes(voter1.publicKey());
    const voter2Power = await votesClient.getVotes(voter2.publicKey());
    
    console.log(`Proposer voting power: ${proposerPower}`);
    console.log(`Voter 1 voting power: ${voter1Power}`);
    console.log(`Voter 2 voting power: ${voter2Power}\n`);

    // 2. Create a proposal
    console.log("2. Creating proposal...");
    const proposalDescription = "Upgrade protocol parameter to improve efficiency";
    const proposalId = await governorClient.propose(proposer, proposalDescription);
    console.log(`Proposal created with ID: ${proposalId}\n`);

    // 3. Check proposal state
    console.log("3. Checking proposal state...");
    let state = await governorClient.getProposalState(proposalId);
    console.log(`Initial state: ${state}`);
    
    // Wait for proposal to become active (if needed)
    if (state === ProposalState.Pending) {
      console.log("Proposal is pending, waiting for activation...");
      // In a real scenario, you'd poll or wait for the voting period to start
    }

    // 4. Cast votes
    console.log("\n4. Casting votes...");
    await governorClient.castVote(voter1, proposalId, VoteSupport.For);
    console.log("Voter 1 voted FOR");
    
    await governorClient.castVote(voter2, proposalId, VoteSupport.For);
    console.log("Voter 2 voted FOR");

    // 5. Check vote results
    console.log("\n5. Checking vote results...");
    const votes = await governorClient.getProposalVotes(proposalId);
    console.log(`Votes FOR: ${votes.votesFor}`);
    console.log(`Votes AGAINST: ${votes.votesAgainst}`);
    console.log(`Votes ABSTAIN: ${votes.votesAbstain}`);

    // 6. Check final proposal state
    console.log("\n6. Checking final proposal state...");
    state = await governorClient.getProposalState(proposalId);
    console.log(`Final state: ${state}`);

    // 7. If proposal succeeded, schedule timelock operation
    if (state === ProposalState.Succeeded) {
      console.log("\n7. Scheduling timelock operation...");
      
      // Example calldata (replace with actual encoded function call)
      const targetContract = "TARGET123...";
      const calldata = Buffer.from("example_calldata", "utf8");
      const delay = 86400n; // 24 hours in seconds
      
      const operationId = await timelockClient.schedule(
        proposer, 
        targetContract, 
        calldata, 
        delay
      );
      console.log(`Timelock operation scheduled with ID: ${operationId}`);

      // 8. Wait for delay and execute
      console.log("\n8. Waiting for timelock delay...");
      
      // In a real scenario, you'd wait for the delay period
      // For this example, we'll check if it's ready
      const isReady = await timelockClient.isReady(operationId);
      
      if (isReady) {
        console.log("Operation is ready, executing...");
        await timelockClient.execute(proposer, operationId);
        console.log("Timelock operation executed successfully!");
        
        // 9. Check final proposal state (should be Executed)
        const finalState = await governorClient.getProposalState(proposalId);
        console.log(`\n9. Final proposal state: ${finalState}`);
      } else {
        console.log("Operation is not ready yet (delay period not elapsed)");
      }
    }

    console.log("\n=== Governance Flow Complete ===");

  } catch (error) {
    console.error("Error in governance flow:", error);
    throw error;
  }
}

// Event subscription example
function setupEventMonitoring() {
  console.log("\n=== Setting up Event Monitoring ===");
  
  // Subscribe to new proposals
  const proposalUnsub = subscribeToProposals(
    config.governorAddress,
    (event) => {
      console.log(`📋 New proposal: ${JSON.stringify(event.value)}`);
    },
    { network: config.network }
  );

  // Subscribe to votes on our proposal
  const voteUnsub = subscribeToVotes(
    config.governorAddress,
    1n, // proposal ID
    (event) => {
      console.log(`🗳️ New vote: ${JSON.stringify(event.value)}`);
    },
    { network: config.network }
  );

  // Return cleanup function
  return () => {
    proposalUnsub();
    voteUnsub();
  };
}

// Run the complete example
async function main() {
  const cleanup = setupEventMonitoring();
  
  try {
    await completeGovernanceFlow();
  } finally {
    cleanup(); // Clean up event subscriptions
  }
}

// Execute if this file is run directly
if (require.main === module) {
  main().catch(console.error);
}

export { completeGovernanceFlow, setupEventMonitoring };
```

### Expected Output

```
=== NebGov Complete Governance Flow ===

1. Checking voting power...
Proposer voting power: 1000000
Voter 1 voting power: 500000
Voter 2 voting power: 750000

2. Creating proposal...
Proposal created with ID: 1

3. Checking proposal state...
Initial state: Active

4. Casting votes...
Voter 1 voted FOR
Voter 2 voted FOR

5. Checking vote results...
Votes FOR: 1250000
Votes AGAINST: 0
Votes ABSTAIN: 0

6. Checking final proposal state...
Final state: Succeeded

7. Scheduling timelock operation...
Timelock operation scheduled with ID: abc123def456...

8. Waiting for timelock delay...
Operation is ready, executing...
Timelock operation executed successfully!

9. Final proposal state: Executed

=== Governance Flow Complete ===
```

This example demonstrates the complete lifecycle of a governance proposal from creation through execution, including voting power delegation, proposal submission, voting, and timelock-protected execution.
