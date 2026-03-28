// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();

import { GovernorClient } from "../governor";
import { ProposalState, VoteSupport, UnknownProposalStateError } from "../types";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: mockScValToNative,
    nativeToScVal: mockNativeToScVal,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
        GetTransactionStatus: {
          SUCCESS: "SUCCESS",
          FAILED: "FAILED",
          NOT_FOUND: "NOT_FOUND",
        },
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("GovernorClient", () => {
  let client: GovernorClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    
    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("getProposalState()", () => {
    const variants = [
      { name: "Pending", expected: ProposalState.Pending },
      { name: "Active", expected: ProposalState.Active },
      { name: "Defeated", expected: ProposalState.Defeated },
      { name: "Succeeded", expected: ProposalState.Succeeded },
      { name: "Queued", expected: ProposalState.Queued },
      { name: "Executed", expected: ProposalState.Executed },
      { name: "Cancelled", expected: ProposalState.Cancelled },
    ];

    test.each(variants)("returns $expected for variant '$name'", async ({ name, expected }) => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue([name]);

      const state = await client.getProposalState(1n);
      
      expect(state).toBe(expected);
      expect(mockScValToNative).toHaveBeenCalledWith(scv);
    });

    it("throws UnknownProposalStateError for unrecognized variants", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(["MysteryState"]);

      await expect(client.getProposalState(1n)).rejects.toThrow(UnknownProposalStateError);
      await expect(client.getProposalState(1n)).rejects.toThrow("Unknown proposal state: MysteryState");
    });

    it("throws error for invalid ScVal format", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(123);

      await expect(client.getProposalState(1n)).rejects.toThrow("Invalid ScVal format for ProposalState enum");
    });

    it("throws error when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Contract not found",
      });

      await expect(client.getProposalState(1n)).rejects.toThrow("Simulation error: Contract not found");
    });

    it("throws error when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      await expect(client.getProposalState(1n)).rejects.toThrow("No return value");
    });
  });

  describe("propose()", () => {
    const mockTxHash = "abc123";
    const mockProposalId = 42n;

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
    });

    it("returns proposal ID on successful proposal", async () => {
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
      mockScValToNative.mockReturnValue(mockProposalId);

      const id = await client.propose(
        mockKeypair,
        "Test proposal",
        validCAddr,
        "upgrade",
        Buffer.from([1, 2, 3])
      );

      expect(id).toBe(mockProposalId);
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws error when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Insufficient voting power",
      });

      await expect(
        client.propose(
          mockKeypair,
          "Test proposal",
          validCAddr,
          "upgrade",
          Buffer.from([1, 2, 3])
        )
      ).rejects.toThrow("Transaction failed");
    });

    it("throws error when transaction confirmation fails", async () => {
      mockGetTransaction.mockResolvedValue({
        status: "FAILED",
      });

      await expect(
        client.propose(
          mockKeypair,
          "Test proposal",
          validCAddr,
          "upgrade",
          Buffer.from([1, 2, 3])
        )
      ).rejects.toThrow("Transaction failed");
    });

    it("throws error when transaction times out", async () => {
      jest.useFakeTimers();
      
      mockGetTransaction.mockResolvedValue({
        status: "NOT_FOUND",
      });

      const promise = client.propose(
        mockKeypair,
        "Test proposal",
        validCAddr,
        "upgrade",
        Buffer.from([1, 2, 3])
      ).catch(err => err);

      // Advance timers to trigger all retries
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(2000);
      }

      const error = await promise;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Transaction not confirmed after 10 retries");
      
      jest.useRealTimers();
    });
  });

  describe("castVote()", () => {
    const mockTxHash = "def456";

    beforeEach(() => {
      jest.useFakeTimers();
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("successfully casts a For vote", async () => {
      const promise = client.castVote(mockKeypair, 1n, VoteSupport.For);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockGetTransaction).toHaveBeenCalledWith(mockTxHash);
    });

    it("successfully casts an Against vote", async () => {
      const promise = client.castVote(mockKeypair, 1n, VoteSupport.Against);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("successfully casts an Abstain vote", async () => {
      const promise = client.castVote(mockKeypair, 1n, VoteSupport.Abstain);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws error when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Already voted",
      });

      await expect(
        client.castVote(mockKeypair, 1n, VoteSupport.For)
      ).rejects.toThrow("castVote failed");
    });
  });

  describe("getProposalVotes()", () => {
    it("returns vote breakdown for a proposal", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue([100n, 50n, 25n]);

      const votes = await client.getProposalVotes(1n);

      expect(votes).toEqual({
        votesFor: 100n,
        votesAgainst: 50n,
        votesAbstain: 25n,
      });
    });

    it("throws error when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Proposal not found",
      });

      await expect(client.getProposalVotes(999n)).rejects.toThrow("Simulation error: Proposal not found");
    });

    it("throws error when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      await expect(client.getProposalVotes(1n)).rejects.toThrow("No return value");
    });
  });

  describe("proposalCount()", () => {
    it("returns total number of proposals", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(5);

      const count = await client.proposalCount();

      expect(count).toBe(5n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Contract error",
      });

      const count = await client.proposalCount();

      expect(count).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const count = await client.proposalCount();

      expect(count).toBe(0n);
    });
  });
});
