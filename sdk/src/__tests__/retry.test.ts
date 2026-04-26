import { GovernorClient } from "../governor";
import { VoteSupport } from "../types";

// Mocking Stellar SDK
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockScValToNative = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: mockScValToNative,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 123 }),
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
      contractId: () => "CAAA",
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

describe("SDK Retry Logic", () => {
  let client: GovernorClient;
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";

  beforeEach(() => {
    jest.clearAllMocks();
    const { Account } = require("@stellar/stellar-sdk");
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);

    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
      maxAttempts: 3,
      baseDelayMs: 1, // Minimize delay for tests
    });
  });

  it("should retry read-only methods on network error", async () => {
    mockSimulate
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValue({
        result: { retval: {} },
      });
    mockScValToNative.mockReturnValue(["Active"]);

    const state = await client.getProposalState(1n);
    
    expect(mockSimulate).toHaveBeenCalledTimes(3);
    expect(state).toBeDefined();
  });

  it("should retry submission methods on network error", async () => {
    mockPrepareTransaction
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValue({ sign: jest.fn() });
    
    mockSendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: "tx123",
    });
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: {},
    });
    mockScValToNative.mockReturnValue(42n);

    const id = await client.propose(
      { sign: jest.fn() } as any,
      "Title",
      "hash",
      "uri",
      [validCAddr],
      ["fn"],
      [Buffer.from([])]
    );

    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
    expect(id).toBe(42n);
  });

  it("should NOT retry submission methods on contract error", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction.mockResolvedValue({
      status: "ERROR",
      error: "Error(Contract, #101)", // SDK/Contract error
    });

    await expect(client.castVote(
      { sign: jest.fn() } as any,
      1n,
      VoteSupport.For
    )).rejects.toThrow();

    // Should only attempt once because it's a contract error, not a network error
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("should NOT retry submission methods on TransactionAlreadyInMempool", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction.mockResolvedValue({
      status: "ERROR",
      error: "TransactionAlreadyInMempool",
    });

    await expect(client.castVote(
      { sign: jest.fn() } as any,
      1n,
      VoteSupport.For
    )).rejects.toThrow();

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("should retry submission methods on 5xx server error", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction
      .mockRejectedValueOnce(new Error("Internal Server Error (500)"))
      .mockResolvedValue({
        status: "PENDING",
        hash: "tx123",
      });
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: {},
    });

    await client.castVote(
      { sign: jest.fn() } as any,
      1n,
      VoteSupport.For
    );

    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });
});
