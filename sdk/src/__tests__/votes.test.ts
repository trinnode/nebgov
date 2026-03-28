// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockIsSimulationError = jest.fn();

import { VotesClient } from "../votes";

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
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
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

describe("VotesClient", () => {
  let client: VotesClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    
    client = new VotesClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("delegate()", () => {
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "delegate123",
      });
    });

    it("successfully delegates voting power", async () => {
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockPrepareTransaction).toHaveBeenCalled();
    });

    it("successfully self-delegates", async () => {
      await client.delegate(mockKeypair, mockKeypair.publicKey());

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("handles transaction errors gracefully", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Invalid delegatee",
      });

      // The current implementation doesn't throw on sendTransaction error
      // It just sends and doesn't wait for confirmation
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("calls contract with correct parameters", async () => {
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, { type: "address" });
    });
  });

  describe("getVotes()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("returns current voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(1000);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(1000n);
    });

    it("returns 0n when account has no voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(0);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Account not found",
      });

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("handles large voting power values", async () => {
      const scv = {} as xdr.ScVal;
      const largeValue = 999999999999n;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(largeValue);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(largeValue);
    });
  });

  describe("getPastVotes()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const ledgerSeq = 12345;

    it("returns historical voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(500);

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(500n);
    });

    it("returns 0n when account had no voting power at ledger", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(0);

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Ledger too old",
      });

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("calls contract with correct ledger parameter", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(100);

      await client.getPastVotes(accountAddr, ledgerSeq);

      expect(mockNativeToScVal).toHaveBeenCalledWith(accountAddr, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(ledgerSeq, { type: "u32" });
    });
  });

  describe("getDelegatee()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("returns current delegatee address", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(delegateeAddr);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBe(delegateeAddr);
    });

    it("returns null when account has no delegatee", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(null);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("returns null when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Account not found",
      });

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("returns null when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("handles self-delegation", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(accountAddr);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBe(accountAddr);
    });
  });
});
