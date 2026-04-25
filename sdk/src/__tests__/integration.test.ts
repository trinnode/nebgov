import { Keypair } from "@stellar/stellar-sdk";
import { GovernorClient } from "../governor";
import { VoteType, ProposalState, type GovernorConfig } from "../types";
import { VotesClient } from "../votes";

const TESTNET_SECRET_KEY = process.env.TESTNET_SECRET_KEY;
const TESTNET_RPC_URL = process.env.TESTNET_RPC_URL;
const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS;
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS;
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS;

const hasEnv = Boolean(
  TESTNET_SECRET_KEY &&
    GOVERNOR_ADDRESS &&
    TIMELOCK_ADDRESS &&
    TOKEN_VOTES_ADDRESS,
);

const describeIfConfigured = hasEnv ? describe : describe.skip;

describeIfConfigured("GovernorClient integration (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);

    const config: GovernorConfig = {
      governorAddress: GOVERNOR_ADDRESS as string,
      timelockAddress: TIMELOCK_ADDRESS as string,
      votesAddress: TOKEN_VOTES_ADDRESS as string,
      network: "testnet",
      rpcUrl: TESTNET_RPC_URL,
      simulationAccount: signer.publicKey(),
    };

    governor = new GovernorClient(config);
  });

  it("proposalCount() returns a number", async () => {
    const count = await governor.proposalCount();
    expect(typeof count).toBe("bigint");
    expect(count >= 0n).toBe(true);
  }, 30_000);

  it("getLatestLedger() returns current ledger", async () => {
    const latestLedger = await governor.getLatestLedger();
    expect(Number.isInteger(latestLedger)).toBe(true);
    expect(latestLedger > 0).toBe(true);
  }, 30_000);

  it("getSettings() returns valid governor settings", async () => {
    const settings = await governor.getSettings(signer.publicKey());
    expect(settings.votingPeriod > 0).toBe(true);
    expect(settings.proposalGracePeriod >= 0).toBe(true);
    expect(settings.quorumNumerator >= 0).toBe(true);
    expect(Object.values(VoteType)).toContain(settings.voteType);
  }, 30_000);

  it("getProposalState(1) returns a valid ProposalState", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) {
      expect(count).toBe(0n);
      return;
    }

    const state = await governor.getProposalState(1n);
    expect(Object.values(ProposalState)).toContain(state);
  }, 30_000);
});

describeIfConfigured("VotesClient integration (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;
  let votes: VotesClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);

    const config: GovernorConfig = {
      governorAddress: GOVERNOR_ADDRESS as string,
      timelockAddress: TIMELOCK_ADDRESS as string,
      votesAddress: TOKEN_VOTES_ADDRESS as string,
      network: "testnet",
      rpcUrl: TESTNET_RPC_URL,
      simulationAccount: signer.publicKey(),
    };

    governor = new GovernorClient(config);
    votes = new VotesClient(config);
  });

  it("getVotes(testAccount) returns bigint", async () => {
    const currentVotes = await votes.getVotes(signer.publicKey());
    expect(typeof currentVotes).toBe("bigint");
    expect(currentVotes >= 0n).toBe(true);
  }, 30_000);

  it("getPastVotes(testAccount, pastLedger) returns bigint", async () => {
    const latestLedger = await governor.getLatestLedger();
    const pastLedger = Math.max(1, latestLedger - 1);
    const pastVotes = await votes.getPastVotes(signer.publicKey(), pastLedger);

    expect(typeof pastVotes).toBe("bigint");
    expect(pastVotes >= 0n).toBe(true);
  }, 30_000);

  it("getDelegatee(testAccount) returns address or null", async () => {
    const delegatee = await votes.getDelegatee(signer.publicKey());
    expect(delegatee === null || typeof delegatee === "string").toBe(true);

    if (delegatee !== null) {
      expect(delegatee.length > 0).toBe(true);
    }
  }, 30_000);
});
