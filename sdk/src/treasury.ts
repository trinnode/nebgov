import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { TreasuryConfig, BatchTransferRecipient, Network } from "./types";
import {
  TreasuryError,
  TreasuryErrorCode,
  parseTreasuryError,
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
 * Encode a {@link BatchTransferRecipient} as an XDR ScVal map matching the
 * on-chain `BatchRecipient` struct (field order is alphabetical per XDR spec).
 */
function encodeBatchRecipient(r: BatchTransferRecipient): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: nativeToScVal(r.amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("recipient"),
      val: nativeToScVal(r.address, { type: "address" }),
    }),
  ]);
}

/**
 * TreasuryClient — interact with a deployed NebGov treasury contract.
 *
 * The treasury holds protocol funds and disburses them via governor-approved
 * proposals. `batchTransfer` enables gas-efficient multi-recipient payouts
 * in a single transaction.
 *
 * @example
 * const client = new TreasuryClient({
 *   treasuryAddress: "CABC...",
 *   network: "testnet",
 * });
 *
 * const opHash = await client.batchTransfer(signer, tokenAddress, [
 *   { address: "GABC...", amount: 1_000_000n },
 *   { address: "GDEF...", amount: 2_000_000n },
 * ]);
 */
export class TreasuryClient {
  private readonly config: TreasuryConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: TreasuryConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.treasuryAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  /**
   * Disburse tokens to multiple recipients in a single transaction.
   *
   * Validation (all amounts positive, non-empty list) is enforced on-chain
   * before any transfer takes place — the operation is all-or-nothing.
   *
   * Only the governor may call this method.
   *
   * @param signer     - Keypair authorising the call (must be the governor signer)
   * @param token      - Strkey address of the SEP-41 token to transfer
   * @param recipients - List of recipient addresses and amounts
   * @returns Hex-encoded SHA-256 operation hash for tracking
   */
  async batchTransfer(
    signer: Keypair,
    token: string,
    recipients: BatchTransferRecipient[]
  ): Promise<string> {
    if (recipients.length === 0) {
      throw new TreasuryError(
        TreasuryErrorCode.InvalidArguments,
        "recipients list must not be empty"
      );
    }

    for (const r of recipients) {
      if (r.amount <= 0n) {
        throw new TreasuryError(
          TreasuryErrorCode.InvalidArguments,
          `amount must be positive, got ${r.amount} for ${r.address}`
        );
      }
    }

    const account = await this.server.getAccount(signer.publicKey());

    const recipientsScVal = xdr.ScVal.scvVec(
      recipients.map(encodeBatchRecipient)
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "batch_transfer",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(token, { type: "address" }),
          recipientsScVal
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseTreasuryError(result);
    }

    const confirmed = await this.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    if (!returnVal) {
      throw new TreasuryError(
        TreasuryErrorCode.MissingReturnValue,
        "No return value from batch_transfer"
      );
    }

    const bytes = scValToNative(returnVal) as Uint8Array;
    return Buffer.from(bytes).toString("hex");
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
        throw new TreasuryError(
          TreasuryErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`
        );
      }
    }
    throw new TreasuryError(
      TreasuryErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`
    );
  }
}
