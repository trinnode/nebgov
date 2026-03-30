// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();

import { TimelockClient } from "../timelock";
import { TimelockError, TimelockErrorCode } from "../errors";

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

describe("TimelockClient", () => {
  let client: TimelockClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    
    client = new TimelockClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("schedule()", () => {
    const mockTxHash = "schedule123";
    const mockOpId = "a1b2c3d4e5f6";

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
    });

    it("returns operation ID on successful schedule", async () => {
      const mockBytes = Buffer.from(mockOpId, "hex");
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
      mockScValToNative.mockReturnValue(mockBytes);

      const opId = await client.schedule(
        mockKeypair,
        validCAddr,
        Buffer.from("calldata"),
        86400n
      );

      expect(opId).toBe(mockOpId);
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws TimelockError(TransactionFailed) when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Unauthorized",
      });

      await expect(
        client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 86400n)
      ).rejects.toThrow(TimelockError);

      try {
        await client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 86400n);
      } catch (e) {
        expect((e as TimelockError).code).toBe(TimelockErrorCode.TransactionFailed);
        expect((e as TimelockError).message).toContain("Transaction failed");
      }
    });

    it("throws TimelockError(MissingReturnValue) when no return value", async () => {
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
      });

      await expect(
        client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 86400n)
      ).rejects.toThrow(TimelockError);

      try {
        await client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 86400n);
      } catch (e) {
        expect((e as TimelockError).code).toBe(TimelockErrorCode.MissingReturnValue);
      }
    });

    it("throws TimelockError(TransactionFailed) when confirmation fails", async () => {
      mockGetTransaction.mockResolvedValue({
        status: "FAILED",
      });

      await expect(
        client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 86400n)
      ).rejects.toThrow(TimelockError);

      try {
        await client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 86400n);
      } catch (e) {
        expect((e as TimelockError).code).toBe(TimelockErrorCode.TransactionFailed);
        expect((e as TimelockError).message).toContain("Transaction failed");
      }
    });

    it("throws TimelockError(TransactionFailed) when delay is below minimum", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Delay too short",
      });

      await expect(
        client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 100n)
      ).rejects.toThrow(TimelockError);

      try {
        await client.schedule(mockKeypair, validCAddr, Buffer.from("calldata"), 100n);
      } catch (e) {
        expect((e as TimelockError).code).toBe(TimelockErrorCode.TransactionFailed);
      }
    });
  });

  describe("execute()", () => {
    const mockTxHash = "execute123";
    const mockOpId = "a1b2c3d4e5f6";

    beforeEach(() => {
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

    it("successfully executes a ready operation", async () => {
      await client.execute(mockKeypair, mockOpId);

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockGetTransaction).toHaveBeenCalledWith(mockTxHash);
    });

    it("throws TimelockError(TransactionFailed) when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Operation not ready",
      });

      await expect(
        client.execute(mockKeypair, mockOpId)
      ).rejects.toThrow(TimelockError);

      try {
        await client.execute(mockKeypair, mockOpId);
      } catch (e) {
        expect((e as TimelockError).code).toBe(TimelockErrorCode.TransactionFailed);
      }
    });

    it("throws TimelockError(TransactionFailed) when operation not found", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Operation not found",
      });

      await expect(
        client.execute(mockKeypair, "nonexistent")
      ).rejects.toThrow(TimelockError);
    });

    it("throws TimelockError(TransactionFailed) when unauthorized", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Unauthorized",
      });

      await expect(
        client.execute(mockKeypair, mockOpId)
      ).rejects.toThrow(TimelockError);
    });
  });

  describe("cancel()", () => {
    const mockTxHash = "cancel123";
    const mockOpId = "a1b2c3d4e5f6";

    beforeEach(() => {
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

    it("successfully cancels a pending operation", async () => {
      await client.cancel(mockKeypair, mockOpId);

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockGetTransaction).toHaveBeenCalledWith(mockTxHash);
    });

    it("throws TimelockError(TransactionFailed) when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Operation already executed",
      });

      await expect(
        client.cancel(mockKeypair, mockOpId)
      ).rejects.toThrow(TimelockError);

      try {
        await client.cancel(mockKeypair, mockOpId);
      } catch (e) {
        expect((e as TimelockError).code).toBe(TimelockErrorCode.TransactionFailed);
      }
    });

    it("throws TimelockError(TransactionFailed) when unauthorized", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Unauthorized",
      });

      await expect(
        client.cancel(mockKeypair, mockOpId)
      ).rejects.toThrow(TimelockError);
    });

    it("throws TimelockError(TransactionFailed) when operation not found", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Operation not found",
      });

      await expect(
        client.cancel(mockKeypair, "nonexistent")
      ).rejects.toThrow(TimelockError);
    });
  });

  describe("isReady()", () => {
    const mockOpId = "a1b2c3d4e5f6";

    it("returns true when operation is ready", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(true);

      const ready = await client.isReady(mockOpId);

      expect(ready).toBe(true);
    });

    it("returns false when operation is not ready", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(false);

      const ready = await client.isReady(mockOpId);

      expect(ready).toBe(false);
    });

    it("returns false when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Operation not found",
      });

      const ready = await client.isReady(mockOpId);

      expect(ready).toBe(false);
    });

    it("returns false when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const ready = await client.isReady(mockOpId);

      expect(ready).toBe(false);
    });
  });

  describe("isPending()", () => {
    const mockOpId = "a1b2c3d4e5f6";

    it("returns true when operation is pending", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(true);

      const pending = await client.isPending(mockOpId);

      expect(pending).toBe(true);
    });

    it("returns false when operation is not pending", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(false);

      const pending = await client.isPending(mockOpId);

      expect(pending).toBe(false);
    });

    it("returns false when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Operation not found",
      });

      const pending = await client.isPending(mockOpId);

      expect(pending).toBe(false);
    });

    it("returns false when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const pending = await client.isPending(mockOpId);

      expect(pending).toBe(false);
    });
  });

  describe("minDelay()", () => {
    it("returns minimum delay in seconds", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(86400);

      const delay = await client.minDelay();

      expect(delay).toBe(86400n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Contract error",
      });

      const delay = await client.minDelay();

      expect(delay).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const delay = await client.minDelay();

      expect(delay).toBe(0n);
    });
  });
});
