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
import {
  GovernorConfig,
  DelegateInfo,
  Network,
  TopDelegate,
  VotingPowerDistribution,
  DelegatorInfo,
} from "./types";
import { VotesError, VotesErrorCode, parseVotesError } from "./errors";

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
 * Ledger window used when no fromLedger is specified for analytics queries.
 * 17,280 ledgers ≈ 24 hours at ~5 s/ledger on testnet.
 */
const DEFAULT_SCAN_WINDOW = 17_280;

/**
 * VotesClient — interact with the token-votes contract.
 * Handles delegation, voting power queries, and governance health analytics.
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
   * Delegate voting power to another address (or self-delegate).
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
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
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
   * Get top N delegates sorted by current voting power.
   *
   * Scans `del_chsh` (delegate changed) events emitted by the token-votes
   * contract to discover all accounts that have ever delegated, then queries
   * their current voting power and returns the top `limit` entries.
   *
   * @param limit      - Maximum number of delegates to return
   * @param fromLedger - Earliest ledger to scan events from. Defaults to the
   *                     current ledger minus {@link DEFAULT_SCAN_WINDOW}.
   */
  async getTopDelegates(
    limit: number,
    fromLedger?: number
  ): Promise<TopDelegate[]> {
    const delegationMap = await this.buildDelegationMap(fromLedger);
    if (delegationMap.size === 0) return [];

    // Group delegators by their current delegatee
    const byDelegate = new Map<string, Set<string>>();
    for (const [delegator, delegatee] of delegationMap) {
      if (!byDelegate.has(delegatee)) byDelegate.set(delegatee, new Set());
      byDelegate.get(delegatee)!.add(delegator);
    }

    // Query current voting power for each unique delegate
    const delegateAddresses = Array.from(byDelegate.keys());
    const powerEntries = await Promise.all(
      delegateAddresses.map(async (addr) => ({
        address: addr,
        votingPower: await this.getVotes(addr),
        delegatorCount: byDelegate.get(addr)!.size,
      }))
    );

    return powerEntries
      .filter((d) => d.votingPower > 0n)
      .sort((a, b) =>
        b.votingPower > a.votingPower ? 1 : b.votingPower < a.votingPower ? -1 : 0
      )
      .slice(0, limit);
  }

  /**
   * Get voting power distribution statistics for governance health dashboards.
   *
   * Computes:
   * - `totalDelegated`  — sum of all actively-delegated voting power
   * - `totalSupply`     — total token supply from the contract
   * - `delegationRate`  — fraction of supply that is delegated (0–1)
   * - `giniCoefficient` — concentration of voting power (0 = equal, 1 = concentrated)
   *
   * @param fromLedger - Earliest ledger to scan events from.
   */
  async getVotingPowerDistribution(
    fromLedger?: number
  ): Promise<VotingPowerDistribution> {
    const [delegationMap, totalSupply] = await Promise.all([
      this.buildDelegationMap(fromLedger),
      this.getTotalSupply(),
    ]);

    if (delegationMap.size === 0) {
      return {
        totalDelegated: 0n,
        totalSupply,
        delegationRate: 0,
        giniCoefficient: 0,
      };
    }

    // Group delegators by delegatee and query their voting power
    const byDelegate = new Map<string, Set<string>>();
    for (const [delegator, delegatee] of delegationMap) {
      if (!byDelegate.has(delegatee)) byDelegate.set(delegatee, new Set());
      byDelegate.get(delegatee)!.add(delegator);
    }

    const powers = await Promise.all(
      Array.from(byDelegate.keys()).map((addr) => this.getVotes(addr))
    );

    const activePowers = powers.filter((p) => p > 0n);
    const totalDelegated = activePowers.reduce((sum, p) => sum + p, 0n);

    const delegationRate =
      totalSupply > 0n ? Number(totalDelegated) / Number(totalSupply) : 0;

    const giniCoefficient = computeGini(activePowers);

    return { totalDelegated, totalSupply, delegationRate, giniCoefficient };
  }

  /**
   * Get all accounts currently delegating to a specific delegate address.
   *
   * Scans `del_chsh` events to find every delegator whose most recent
   * delegation points to `delegateAddress`, then queries each delegator's
   * current voting power contribution.
   *
   * @param delegateAddress - Strkey address of the delegate to look up
   * @param fromLedger      - Earliest ledger to scan events from.
   */
  async getDelegators(
    delegateAddress: string,
    fromLedger?: number
  ): Promise<DelegatorInfo[]> {
    const delegationMap = await this.buildDelegationMap(fromLedger);

    const delegators: string[] = [];
    for (const [delegator, delegatee] of delegationMap) {
      if (delegatee === delegateAddress) delegators.push(delegator);
    }

    if (delegators.length === 0) return [];

    const results = await Promise.all(
      delegators.map(async (delegator) => ({
        delegator,
        power: await this.getVotes(delegator),
      }))
    );

    return results
      .filter((d) => d.power > 0n)
      .sort((a, b) => (b.power > a.power ? 1 : b.power < a.power ? -1 : 0));
  }

  /**
   * Get top delegates by voting power using a pre-supplied address list.
   *
   * Useful when you already have a known set of delegate addresses (e.g. from
   * an off-chain indexer) and want to rank them without scanning chain events.
   *
   * @param addresses - Known delegate addresses to query
   * @param limit     - Maximum number to return (default 20)
   */
  async getTopDelegatesByAddresses(
    addresses: string[],
    limit = 20
  ): Promise<DelegateInfo[]> {
    const totalSupply = await this.getTotalSupply();
    if (totalSupply === 0n) return [];

    const delegates = await Promise.all(
      addresses.map(async (address) => {
        const votes = await this.getVotes(address);
        return {
          address,
          votes,
          percentOfSupply:
            totalSupply > 0n
              ? Number((votes * 10000n) / totalSupply) / 100
              : 0,
        };
      })
    );

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

    return signer.sign(message);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Scan all `del_chsh` (delegate changed) events from the token-votes
   * contract and return a Map of delegator → current delegatee.
   *
   * The contract emits this event on every `delegate()` call:
   *   topics: (symbol "del_chsh", delegator_address)
   *   data:   (previous_delegatee | null, new_delegatee)
   *
   * We take the last event per delegator to get the current delegation state.
   *
   * @throws {VotesError} with code EventScanFailed on RPC failure.
   */
  private async buildDelegationMap(
    fromLedger?: number
  ): Promise<Map<string, string>> {
    let startLedger = fromLedger;
    if (startLedger === undefined) {
      const info = await this.server.getLatestLedger();
      startLedger = Math.max(1, info.sequence - DEFAULT_SCAN_WINDOW);
    }

    const contractId = this.contract.contractId();
    const topicFilter = [xdr.ScVal.scvSymbol("del_chsh")];
    const delegationMap = new Map<string, string>();

    try {
      let cursor = startLedger;
      const latest = (await this.server.getLatestLedger()).sequence;

      while (cursor <= latest) {
        const response = await this.server.getEvents({
          startLedger: cursor,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
              topics: [topicFilter.map((v) => v.toXDR("base64"))],
            },
          ],
          limit: 100,
        });

        const events = response.events ?? [];
        let maxLedger = cursor;

        for (const event of events) {
          try {
            const delegator = scValToNative(event.topic[1]) as string;
            const data = scValToNative(event.value) as [string | null, string];
            const newDelegatee = data[1];
            if (typeof delegator === "string" && typeof newDelegatee === "string") {
              delegationMap.set(delegator, newDelegatee);
            }
          } catch {
            // Malformed event — skip
          }
          if (event.ledger > maxLedger) maxLedger = event.ledger;
        }

        if (events.length === 0) break;
        cursor = maxLedger + 1;
      }
    } catch (err) {
      throw new VotesError(
        VotesErrorCode.EventScanFailed,
        `Failed to scan delegation events: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    return delegationMap;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the Gini coefficient for an array of voting power values.
 *
 * Returns 0 when the array is empty or all values are equal (perfectly
 * uniform distribution), and approaches 1 when all power is concentrated
 * in a single account.
 */
function computeGini(powers: bigint[]): number {
  if (powers.length === 0) return 0;

  const sorted = [...powers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0n);
  if (total === 0n) return 0;

  let weightedSum = 0n;
  for (let i = 0; i < n; i++) {
    weightedSum += BigInt(i + 1) * sorted[i];
  }

  return (2 * Number(weightedSum)) / (n * Number(total)) - (n + 1) / n;
}
