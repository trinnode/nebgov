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
}

export interface TimelockOperation {
  id: string; // hex-encoded operation hash
  target: string;
  readyAt: bigint;
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
