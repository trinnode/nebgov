/**
 * NebGov SDK — core types
 */

export type Network = "mainnet" | "testnet" | "futurenet";

export enum ProposalState {
  Pending = "Pending",
  Active = "Active",
  Defeated = "Defeated",
  Succeeded = "Succeeded",
  Queued = "Queued",
  Executed = "Executed",
  Cancelled = "Cancelled",
  Expired = "Expired",
}

export class UnknownProposalStateError extends Error {
  constructor(variant: string) {
    super(`Unknown proposal state: ${variant}`);
    this.name = "UnknownProposalStateError";
  }
}

export enum VoteSupport {
  Against = 0,
  For = 1,
  Abstain = 2,
}

export enum VoteType {
  Simple = "Simple",
  Extended = "Extended",
  Quadratic = "Quadratic",
}

export interface Proposal {
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

export interface ProposalInput {
  description: string;
  target: string;
  fnName: string;
  calldata: Buffer | Uint8Array;
}

export interface ProposalVotes {
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
}

export interface GovernorConfig {
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
  /** Optional funded classic account used for read-only simulation calls. */
  simulationAccount?: string;
  /** Maximum number of retry attempts for RPC calls (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

export interface TimelockOperation {
  id: string; // hex-encoded operation hash
  target: string;
  readyAt: bigint;
  expiresAt: bigint;
  executed: boolean;
  cancelled: boolean;
}

export interface TreasuryTx {
  id: bigint;
  proposer: string;
  target: string;
  approvals: number;
  executed: boolean;
  cancelled: boolean;
}

export interface ProposalAction {
  target: string;
  function: string;
  args: any[];
}

export interface ProposalSimulationResult {
  success: boolean;
  computeUnits?: number;
  stateChanges?: any[];
  error?: string;
}

export interface GovernorEntry {
  id: bigint;
  governor: string;
  timelock: string;
  token: string;
  deployer: string;
}

export interface FactoryConfig {
  factoryAddress: string;
  network: Network;
  rpcUrl?: string;
  /** Maximum number of retry attempts for RPC calls (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

export interface GuardianActivityEntry {
  proposalId: bigint;
  canceller: string;
  ledger: number;
}

export interface GovernorSettings {
  votingDelay: number;
  votingPeriod: number;
  quorumNumerator: number;
  proposalThreshold: bigint;
  guardian: string;
  voteType: VoteType;
  proposalGracePeriod: number;
  useDynamicQuorum?: boolean;
  reflectorOracle?: string | null;
  minQuorumUsd?: bigint;
  maxCalldataSize?: number;
  proposalCooldown?: number;
  maxProposalsPerPeriod?: number;
  proposalPeriodDuration?: number;
}

export interface GovernorSettingsValidationLimits {
  maxVotingDelay?: number;
  minVotingPeriod?: number;
}

export interface ExecutionGasEstimate {
  proposalId: bigint;
  actionCount: number;
  calldataBytes: number;
  estimatedCpuInsns: bigint;
  estimatedMemBytes: bigint;
  estimatedFeeStroops: bigint;
  rpcCpuInsns?: bigint;
  rpcMemBytes?: bigint;
}

export interface DelegateInfo {
  address: string;
  votes: bigint;
  percentOfSupply: number;
}

// ─── Votes Analytics Types ────────────────────────────────────────────────────

/** A delegate's summary as returned by {@link VotesClient.getTopDelegates}. */
export interface TopDelegate {
  /** Stellar strkey address of the delegate */
  address: string;
  /** Current voting power held by this delegate */
  votingPower: bigint;
  /** Number of accounts currently delegating to this address */
  delegatorCount: number;
}

/** Delegation health statistics as returned by {@link VotesClient.getVotingPowerDistribution}. */
export interface VotingPowerDistribution {
  /** Total voting power currently delegated across all accounts */
  totalDelegated: bigint;
  /** Total token supply from the votes contract */
  totalSupply: bigint;
  /**
   * Fraction of total supply that is actively delegated, expressed as a
   * value between 0 and 1 (e.g. 0.42 means 42% of tokens are delegated).
   */
  delegationRate: number;
  /**
   * Gini coefficient of voting power concentration (0 = perfectly equal,
   * 1 = fully concentrated in one account).
   */
  giniCoefficient: number;
}

/** A single delegator's record as returned by {@link VotesClient.getDelegators}. */
export interface DelegatorInfo {
  /** Stellar strkey address of the delegator */
  delegator: string;
  /** Voting power this delegator contributes to the delegate */
  power: bigint;
}

// ─── Treasury Types ───────────────────────────────────────────────────────────

/** Configuration for {@link TreasuryClient}. */
export interface TreasuryConfig {
  /** Contract address of the treasury */
  treasuryAddress: string;
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public horizon) */
  rpcUrl?: string;
  /** Indexer base URL for off-chain queries (e.g. getBatchTransferHistory) */
  indexerUrl?: string;
}

/** A single recipient in a batch transfer operation. */
export interface BatchTransferRecipient {
  /** Stellar strkey address of the recipient */
  address: string;
  /** Amount of tokens to transfer (in the token's base unit) */
  amount: bigint;
}

/** A treasury batch transfer event as returned by the indexer. */
export interface BatchTransferEvent {
  /** SHA-256 operation hash (hex-encoded) */
  opHash: string;
  /** Strkey address of the token that was transferred */
  token: string;
  /** Number of recipients in the batch */
  recipientCount: number;
  /** Total amount transferred across all recipients */
  totalAmount: bigint;
  /** Ledger sequence number at which the transfer was executed */
  ledger: number;
}
