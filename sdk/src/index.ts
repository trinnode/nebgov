/**
 * @nebgov/sdk — TypeScript SDK for the NebGov governance framework on Stellar.
 *
 * @example
 * import { GovernorClient, VotesClient, ProposalState, VoteSupport } from "@nebgov/sdk";
 *
 * const client = new GovernorClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 * });
 */

export { GovernorClient } from "./governor";
export { VotesClient } from "./votes";
export { TimelockClient } from "./timelock";
export {
  subscribeToProposals,
  subscribeToVotes,
  getProposalEvents,
  subscribeToProposalQueued,
  subscribeToProposalExecuted,
} from "./events";
export type {
  SorobanEvent,
  SubscriptionOptions,
  ProposalCreatedEventData,
} from "./events";
export {
  parseProposalCreatedEvent,
  parseProposalQueuedEvent,
  parseProposalExecutedEvent,
} from "./events";
export * from "./types";
