// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();

import { GovernorClient } from "../governor";
import { ProposalState, UnknownProposalStateError } from "../types";

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
      })),
      Api: {
        isSimulationError: jest.fn().mockReturnValue(false),
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

import { xdr, Account } from "@stellar/stellar-sdk";

describe("GovernorClient.getProposalState", () => {
  let client: GovernorClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  const variants = [
    { name: "Pending", expected: ProposalState.Pending },
    { name: "Active", expected: ProposalState.Active },
    { name: "Defeated", expected: ProposalState.Defeated },
    { name: "Succeeded", expected: ProposalState.Succeeded },
    { name: "Queued", expected: ProposalState.Queued },
    { name: "Executed", expected: ProposalState.Executed },
    { name: "Cancelled", expected: ProposalState.Cancelled },
  ];

  test.each(variants)("decodes variant '$name' correctly", async ({ name, expected }) => {
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
});
