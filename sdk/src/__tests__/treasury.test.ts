// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockNativeToScVal = jest.fn();
var mockScValToNative = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();

import { TreasuryClient } from "../treasury";
import { TreasuryError, TreasuryErrorCode, parseTreasuryError } from "../errors";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    nativeToScVal: mockNativeToScVal,
    scValToNative: mockScValToNative,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
      })),
      Api: {
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
      build: jest.fn().mockReturnValue({
        toXDR: jest.fn().mockReturnValue(""),
      }),
    })),
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("TreasuryClient", () => {
  let client: TreasuryClient;
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);

    client = new TreasuryClient({
      treasuryAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("submitWithLimit()", () => {
    it("should construct and send a submitWithLimit transaction", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01, 0x02, 0x03]);
      const amount = 1000n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "mock_hash",
      });

      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: xdr.ScVal.scvU64(new xdr.Uint64(123n)),
      });

      mockScValToNative.mockReturnValue(123n);

      const result = await client.submitWithLimit(
        mockKeypair,
        target,
        calldata,
        amount
      );

      // Verify the result is a bigint
      expect(result).toBe(123n);
      expect(typeof result).toBe("bigint");

      // Verify nativeToScVal was called for parameters
      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(target, {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(calldata, {
        type: "bytes",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(amount, {
        type: "i128",
      });
    });

    it("should throw TreasuryError on SingleTransferExceeded contract error", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01]);
      const amount = 1000000n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      // Simulate contract error response
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Error(Contract, #1)",
      });

      await expect(
        client.submitWithLimit(mockKeypair, target, calldata, amount)
      ).rejects.toThrow(TreasuryError);

      try {
        await client.submitWithLimit(mockKeypair, target, calldata, amount);
      } catch (e) {
        if (e instanceof TreasuryError) {
          expect(e.code).toBe(TreasuryErrorCode.SingleTransferExceeded);
        }
      }
    });

    it("should throw TreasuryError on DailyLimitExceeded contract error", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01]);
      const amount = 5000n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      // Simulate contract error for daily limit
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Error(Contract, #2)",
      });

      await expect(
        client.submitWithLimit(mockKeypair, target, calldata, amount)
      ).rejects.toThrow(TreasuryError);

      try {
        await client.submitWithLimit(mockKeypair, target, calldata, amount);
      } catch (e) {
        if (e instanceof TreasuryError) {
          expect(e.code).toBe(TreasuryErrorCode.DailyLimitExceeded);
        }
      }
    });

    it("should throw TreasuryError if return value is missing", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01]);
      const amount = 100n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "mock_hash",
      });

      // No returnValue in the response
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
      });

      await expect(
        client.submitWithLimit(mockKeypair, target, calldata, amount)
      ).rejects.toThrow(TreasuryError);

      try {
        await client.submitWithLimit(mockKeypair, target, calldata, amount);
      } catch (e) {
        if (e instanceof TreasuryError) {
          expect(e.code).toBe(TreasuryErrorCode.MissingReturnValue);
        }
      }
    });

    it("should handle transaction timeout error", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01]);
      const amount = 100n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "mock_hash",
      });

      // Simulate repeated failures until timeout
      mockGetTransaction.mockResolvedValue({
        status: "NOT_FOUND",
      });

      await expect(
        client.submitWithLimit(mockKeypair, target, calldata, amount)
      ).rejects.toThrow(TreasuryError);

      try {
        await client.submitWithLimit(mockKeypair, target, calldata, amount);
      } catch (e) {
        if (e instanceof TreasuryError) {
          expect(e.code).toBe(TreasuryErrorCode.TransactionTimeout);
        }
      }
    });

    it("should handle immediate transaction failure", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01]);
      const amount = 100n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "mock_hash",
      });

      mockGetTransaction.mockResolvedValue({
        status: "FAILED",
      });

      await expect(
        client.submitWithLimit(mockKeypair, target, calldata, amount)
      ).rejects.toThrow(TreasuryError);

      try {
        await client.submitWithLimit(mockKeypair, target, calldata, amount);
      } catch (e) {
        if (e instanceof TreasuryError) {
          expect(e.code).toBe(TreasuryErrorCode.TransactionFailed);
        }
      }
    });

    it("should properly serialize bigint amount to i128", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0x01]);
      const amount = BigInt("9223372036854775807"); // i128::MAX

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "mock_hash",
      });

      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: xdr.ScVal.scvU64(new xdr.Uint64(1n)),
      });

      mockScValToNative.mockReturnValue(1n);

      await client.submitWithLimit(mockKeypair, target, calldata, amount);

      // Verify i128 encoding was called with the full bigint
      expect(mockNativeToScVal).toHaveBeenCalledWith(amount, {
        type: "i128",
      });
    });

    it("should properly serialize bytes calldata", async () => {
      const target = validCAddr;
      const calldata = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
      const amount = 100n;

      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("prepared_xdr"),
        sign: jest.fn(),
      });

      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "mock_hash",
      });

      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: xdr.ScVal.scvU64(new xdr.Uint64(1n)),
      });

      mockScValToNative.mockReturnValue(1n);

      await client.submitWithLimit(mockKeypair, target, calldata, amount);

      // Verify bytes encoding was called
      expect(mockNativeToScVal).toHaveBeenCalledWith(calldata, {
        type: "bytes",
      });
    });
  });
});
