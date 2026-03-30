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
import { GovernorConfig, DelegateInfo, Network } from "./types";

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
 * VotesClient — interact with the token-votes contract.
 * Handles delegation and voting power queries.
 *
 * TODO issue #32: add event subscription for DelegateChanged events.
 */
export class VotesClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.votesAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  /**
   * Delegate voting power to another address.
   * TODO issue #33: add self-delegation option and UI flow.
   */
  async delegate(signer: Keypair, delegatee: string): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "delegate",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(delegatee, { type: "address" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    await this.server.sendTransaction(prepared);
  }

  /**
   * Get current voting power of an address.
   */
  async getVotes(account: string): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(account),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call(
            "get_votes",
            nativeToScVal(account, { type: "address" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get voting power at a past ledger sequence.
   * TODO issue #9 (contract): requires checkpoint binary search to be implemented first.
   */
  async getPastVotes(account: string, ledger: number): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(account),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call(
            "get_past_votes",
            nativeToScVal(account, { type: "address" }),
            nativeToScVal(ledger, { type: "u32" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get current delegatee of an account.
   */
  async getDelegatee(account: string): Promise<string | null> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(account),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call(
            "delegates",
            nativeToScVal(account, { type: "address" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return null;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? (scValToNative(raw) as string) : null;
  }

  /**
   * Get total supply of the voting token.
   */
  async getTotalSupply(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.contract.contractId()),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(this.contract.call("total_supply"))
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get top delegates by voting power.
   *
   * Note: This queries known delegate addresses. In production, this would
   * use an indexer or event subscription to track DelegateChanged events.
   */
  async getTopDelegates(addresses: string[], limit = 20): Promise<DelegateInfo[]> {
    const totalSupply = await this.getTotalSupply();
    if (totalSupply === 0n) return [];

    const delegatePromises = addresses.map(async (address) => {
      const votes = await this.getVotes(address);
      return {
        address,
        votes,
        percentOfSupply: totalSupply > 0n
          ? Number((votes * 10000n) / totalSupply) / 100
          : 0,
      };
    });

    const delegates = await Promise.all(delegatePromises);
    return delegates
      .filter((d) => d.votes > 0n)
      .sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * Delegate voting power by signature (gasless for the token holder).
   *
   * A relayer submits this on behalf of a token holder who signed a message
   * off-chain. The holder only needs to sign, no gas required.
   *
   * @param owner - The token holder who signed the delegation message
   * @param delegatee - The address to delegate voting power to
   * @param nonce - Unique nonce to prevent replay attacks
   * @param expiry - Unix timestamp after which the signature is invalid
   * @param signature - Ed25519 signature over (owner, delegatee, nonce, expiry)
   */
  async delegateBySig(
    owner: string,
    delegatee: string,
    nonce: bigint,
    expiry: bigint,
    signature: Buffer
  ): Promise<void> {
    const account = await this.server.getAccount(this.contract.contractId());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "delegate_by_sig",
          nativeToScVal(owner, { type: "address" }),
          nativeToScVal(delegatee, { type: "address" }),
          nativeToScVal(nonce, { type: "u64" }),
          nativeToScVal(expiry, { type: "u64" }),
          nativeToScVal(signature, { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    await this.server.sendTransaction(prepared);
  }

  /**
   * Sign a delegation message off-chain for gasless delegation.
   *
   * @param signer - Keypair of the token holder
   * @param delegatee - Address to delegate to
   * @param nonce - Current nonce for the owner
   * @param expiry - Unix timestamp after which the signature is invalid
   * @returns Ed25519 signature bytes
   */
  signDelegation(
    signer: Keypair,
    delegatee: string,
    nonce: bigint,
    expiry: bigint
  ): Buffer {
    const message = Buffer.concat([
      Buffer.from(signer.publicKey()),
      Buffer.from(delegatee),
      Buffer.from(nonce.toString(16).padStart(16, "0"), "hex"),
      Buffer.from(expiry.toString(16).padStart(16, "0"), "hex"),
    ]);

    const signature = signer.sign(message);
    return signature;
  }
}

  /**
   * Delegate voting power by signature (gasless for the token holder).
   *
   * A relayer submits this on behalf of a token holder who signed a message
   * off-chain. The holder only needs to sign, no gas required.
   *
   * @param owner - The token holder who signed the delegation message
   * @param delegatee - The address to delegate voting power to
   * @param nonce - Unique nonce to prevent replay attacks
   * @param expiry - Unix timestamp after which the signature is invalid
   * @param signature - Ed25519 signature over (owner, delegatee, nonce, expiry)
   */
  async delegateBySig(
    owner: string,
    delegatee: string,
    nonce: bigint,
    expiry: bigint,
    signature: Buffer
  ): Promise<void> {
    const account = await this.server.getAccount(this.contract.contractId());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "delegate_by_sig",
          nativeToScVal(owner, { type: "address" }),
          nativeToScVal(delegatee, { type: "address" }),
          nativeToScVal(nonce, { type: "u64" }),
          nativeToScVal(expiry, { type: "u64" }),
          nativeToScVal(signature, { type: "bytes" })
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    await this.server.sendTransaction(prepared);
  }

  /**
   * Sign a delegation message off-chain for gasless delegation.
   *
   * @param signer - Keypair of the token holder
   * @param delegatee - Address to delegate to
   * @param nonce - Current nonce for the owner
   * @param expiry - Unix timestamp after which the signature is invalid
   * @returns Ed25519 signature bytes
   */
  signDelegation(
    signer: Keypair,
    delegatee: string,
    nonce: bigint,
    expiry: bigint
  ): Buffer {
    // Build message: (owner, delegatee, nonce, expiry)
    const message = Buffer.concat([
      Buffer.from(signer.publicKey()),
      Buffer.from(delegatee),
      Buffer.from(nonce.toString(16).padStart(16, "0"), "hex"),
      Buffer.from(expiry.toString(16).padStart(16, "0"), "hex"),
    ]);

    // Sign the message
    const signature = signer.sign(message);
    return signature;
  }
