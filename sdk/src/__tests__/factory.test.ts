var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();

import { FactoryClient } from "../factory";
import { xdr } from "@stellar/stellar-sdk";
import type { FactoryConfig } from "../types";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: jest.fn(() => false),
      },
    },
    Contract: jest.fn().mockImplementation((address) => ({
      call: jest.fn().mockReturnValue({}),
      contractId: jest.fn().mockReturnValue(address),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    nativeToScVal: jest.fn(),
    scValToNative: jest.fn(),
    Networks: actual.Networks,
    BASE_FEE: actual.BASE_FEE,
    xdr: actual.xdr,
  };
});

const { scValToNative } = require("@stellar/stellar-sdk");
const { SorobanRpc } = require("@stellar/stellar-sdk");

describe("FactoryClient", () => {
  const config: FactoryConfig = {
    factoryAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue({});
    SorobanRpc.Api.isSimulationError.mockReturnValue(false);
  });

  it("fetches the governor count", async () => {
    const response = {
      result: { retval: xdr.ScVal.scvU64(new xdr.Uint64(3n)) },
    };
    mockSimulate.mockResolvedValue(response);
    scValToNative.mockReturnValue(3n);

    const client = new FactoryClient(config);
    const count = await client.getGovernorCount();

    expect(count).toBe(3n);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it("fetches a governor entry by id", async () => {
    const rawEntry = {
      id: 2n,
      governor: "GDUMMY",
      timelock: "GDUMMY2",
      token: "GDUMMY3",
      deployer: "GDUMMY4",
    };

    const response = { result: { retval: xdr.ScVal.scvMap([]) } };
    mockSimulate.mockResolvedValue(response);
    scValToNative.mockReturnValue(rawEntry);

    const client = new FactoryClient(config);
    const entry = await client.getGovernor(2n);

    expect(entry).toEqual(rawEntry);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it("fetches all governors in pages of 20", async () => {
    const responseCount = {
      result: { retval: xdr.ScVal.scvU64(new xdr.Uint64(22n)) },
    };
    const responseEntry = { result: { retval: xdr.ScVal.scvMap([]) } };
    mockSimulate.mockResolvedValueOnce(responseCount);
    for (let i = 0; i < 22; i += 1) {
      mockSimulate.mockResolvedValueOnce(responseEntry);
    }

    scValToNative.mockImplementation((raw: unknown) => {
      if (typeof raw === "object" && raw?.toString?.() === "ScVal") {
        return { id: 1n, governor: "G1", timelock: "T1", token: "TO1", deployer: "D1" };
      }
      return 22n;
    });

    const client = new FactoryClient(config);
    const entries = await client.getAllGovernors();

    expect(entries).toHaveLength(22);
    expect(entries[0]).toEqual({
      id: 1n,
      governor: "G1",
      timelock: "T1",
      token: "TO1",
      deployer: "D1",
    });
  });
});
