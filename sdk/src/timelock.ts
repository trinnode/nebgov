import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { GovernorConfig, Network } from "./types";
import {
  TimelockError,
  TimelockErrorCode,
  parseTimelockError,
} from "./errors";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

/**
 * TimelockClient — interact with a deployed NebGov timelock contract.
 *
 * The timelock enforces a mandatory delay between a proposal passing and its
 * on-chain execution, giving token holders time to exit before governance
 * actions take effect.
 *
 * @example
 * const client = new TimelockClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress:    "CGHI...",
 *   network: "testnet",
 * });
 *
 * const opId = await client.schedule(signer, targetAddress, calldata, 86400n);
 * const ready = await client.isReady(opId);
 * if (ready) await client.execute(signer, opId);
 */
export class TimelockClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.timelockAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  /**
   * Schedule a timelock operation.
   *
   * Only the governor may call this. The operation becomes executable once
   * `delay` seconds have elapsed since scheduling.
   *
   * @param signer  - Keypair authorising the call (must be the governor signer)
   * @param target  - Strkey address of the contract to invoke on execution
   * @param data    - Encoded calldata for the target invocation
   * @param delay   - Delay in seconds; must be >= the contract's `minDelay`
   * @returns Hex-encoded operation ID (SHA-256 of `data`)
   */
  async schedule(
    signer: Keypair,
    target: string,
    data: Buffer,
    delay: bigint
  ): Promise<string> {
    const account = await this.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "schedule",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(target, { type: "address" }),
          nativeToScVal(data, { type: "bytes" }),
          nativeToScVal(delay, { type: "u64" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseTimelockError(result);
    }

    const confirmed = await this.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    if (!returnVal) {
      throw new TimelockError(
        TimelockErrorCode.MissingReturnValue,
        "No return value from schedule"
      );
    }

    const bytes = scValToNative(returnVal) as Uint8Array;
    return Buffer.from(bytes).toString("hex");
  }

  /**
   * Execute a ready timelock operation.
   *
   * Only callable once the operation's delay has elapsed. The caller must be
   * the governor.
   *
   * @param signer - Keypair authorising the call (must be the governor signer)
   * @param opId   - Hex-encoded operation ID returned by {@link schedule}
   */
  async execute(signer: Keypair, opId: string): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "execute",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseTimelockError(result);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Cancel a pending timelock operation.
   *
   * Only the admin or governor may cancel. The operation must not have been
   * executed or already cancelled.
   *
   * @param signer - Keypair authorising the call (admin or governor signer)
   * @param opId   - Hex-encoded operation ID returned by {@link schedule}
   */
  async cancel(signer: Keypair, opId: string): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cancel",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseTimelockError(result);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Check whether an operation is ready for execution.
   *
   * An operation is ready when it has been scheduled, its delay has elapsed,
   * and it has not yet been executed or cancelled.
   *
   * @param opId - Hex-encoded operation ID
   */
  async isReady(opId: string): Promise<boolean> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.timelockAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call(
            "is_ready",
            nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return false;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? (scValToNative(raw) as boolean) : false;
  }

  /**
   * Check whether an operation is pending.
   *
   * An operation is pending when it has been scheduled but its delay has not
   * yet elapsed, and it has not been executed or cancelled.
   *
   * @param opId - Hex-encoded operation ID
   */
  async isPending(opId: string): Promise<boolean> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.timelockAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call(
            "is_pending",
            nativeToScVal(Buffer.from(opId, "hex"), { type: "bytes" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return false;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? (scValToNative(raw) as boolean) : false;
  }

  /**
   * Get the minimum enforced delay for new operations (in seconds).
   */
  async minDelay(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.timelockAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(this.contract.call("min_delay"))
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  // --- Internal ---

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new TimelockError(
          TimelockErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`
        );
      }
    }
    throw new TimelockError(
      TimelockErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`
    );
  }
}
