import { GovernorClient } from "./sdk/src/governor.ts";
import { ProposalState } from "./sdk/src/types/index.ts";

const client = new GovernorClient({
  governorAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  timelockAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  votesAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  network: "testnet",
});

console.log("GovernorClient initialized");
console.log("ProposalState enum:", ProposalState);

// We can't actually call getProposalState without a running RPC, but we can check if the methods exist
console.log("getProposalState exists:", typeof client.getProposalState);
// @ts-ignore
console.log("decodeProposalState exists:", typeof client.decodeProposalState);
