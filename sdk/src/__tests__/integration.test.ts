/**
 * SDK integration tests against Stellar testnet.
 *
 * These tests run against real deployed contracts on the Stellar testnet.
 * They require the following environment variables:
 *
 *   TESTNET_SECRET_KEY      — funded Stellar testnet secret key
 *   GOVERNOR_ADDRESS        — deployed governor contract address
 *   TIMELOCK_ADDRESS        — deployed timelock contract address
 *   TOKEN_VOTES_ADDRESS     — deployed token-votes contract address
 *
 * In CI these are set by the deploy step (see .github/workflows/sdk.yml).
 * Locally, source your .env.testnet or export them manually.
 *
 * If the env vars are missing the entire suite is skipped gracefully.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { GovernorClient } from "../governor";
import { VotesClient } from "../votes";
import { GovernorConfig, ProposalState } from "../types";

const SECRET_KEY = process.env.TESTNET_SECRET_KEY;
const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS;
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS;
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS;

const hasEnv =
  SECRET_KEY && GOVERNOR_ADDRESS && TIMELOCK_ADDRESS && TOKEN_VOTES_ADDRESS;

const describeIfTestnet = hasEnv ? describe : describe.skip;

describeIfTestnet("SDK integration tests (testnet)", () => {
  let signer: Keypair;
  let config: GovernorConfig;
  let governor: GovernorClient;
  let votes: VotesClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(SECRET_KEY as string);
    config = {
      governorAddress: GOVERNOR_ADDRESS as string,
      timelockAddress: TIMELOCK_ADDRESS as string,
      votesAddress: TOKEN_VOTES_ADDRESS as string,
      network: "testnet",
    };
    governor = new GovernorClient(config);
    votes = new VotesClient(config);
  });

  // ------------------------------------------------------------------
  // GovernorClient.propose()
  // ------------------------------------------------------------------

  let proposalId: bigint;

  it(
    "propose() returns a proposalId > 0",
    async () => {
      proposalId = await governor.propose(
        signer,
        "Integration test proposal",
        [config.timelockAddress],
        ["noop"],
        [Buffer.from("integration-test")],
      );

      expect(proposalId).toBeGreaterThan(BigInt(0));
    },
    60_000 // testnet transactions can be slow
  );

  // ------------------------------------------------------------------
  // GovernorClient.getProposalState()
  // ------------------------------------------------------------------

  it(
    "getProposalState() returns Pending immediately after creation",
    async () => {
      // proposalId was set by the previous test
      expect(proposalId).toBeDefined();

      const state = await governor.getProposalState(proposalId);
      expect(state).toBe(ProposalState.Pending);
    },
    30_000
  );

  // ------------------------------------------------------------------
  // VotesClient.delegate()
  // ------------------------------------------------------------------

  it(
    "delegate() stores the delegatee",
    async () => {
      const delegatee = signer.publicKey();

      // Self-delegate so the signer's balance counts as voting power.
      await votes.delegate(signer, delegatee);

      // Allow a moment for the ledger to close.
      await new Promise((r) => setTimeout(r, 3_000));

      const stored = await votes.getDelegatee(signer.publicKey());
      expect(stored).toBe(delegatee);
    },
    60_000
  );

  // ------------------------------------------------------------------
  // VotesClient.getVotes()
  // ------------------------------------------------------------------

  it(
    "getVotes() returns non-zero after delegation",
    async () => {
      const power = await votes.getVotes(signer.publicKey());
      expect(power).toBeGreaterThan(BigInt(0));
    },
    30_000
  );
});
