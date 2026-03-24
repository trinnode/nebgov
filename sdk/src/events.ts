import {
  SorobanRpc,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Network } from "./types";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

/**
 * Default polling interval in milliseconds.
 *
 * Soroban ledgers close roughly every 5–6 seconds on testnet. A 10-second
 * interval keeps RPC traffic low while still delivering near-real-time
 * updates. Pass a custom `intervalMs` to any subscription helper to override.
 */
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Shape of a raw Soroban contract event returned by `getEvents`. */
export interface SorobanEvent {
  /** Ledger sequence the event was emitted in */
  ledger: number;
  /** Contract that emitted the event */
  contractId: string;
  /** Decoded topic segments (symbol strings) */
  topic: string[];
  /** Decoded event body value */
  value: unknown;
}

/** Options shared by all subscription helpers. */
export interface SubscriptionOptions {
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public endpoint) */
  rpcUrl?: string;
  /**
   * Polling interval in milliseconds.
   * @default 10_000
   */
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildServer(opts: SubscriptionOptions): SorobanRpc.Server {
  const rpcUrl = opts.rpcUrl ?? RPC_URLS[opts.network];
  return new SorobanRpc.Server(rpcUrl, { allowHttp: false });
}

/**
 * Decode a single raw event from the `getEvents` response into a
 * friendly {@link SorobanEvent} shape.
 */
function decodeEvent(
  raw: SorobanRpc.Api.EventResponse
): SorobanEvent {
  const topic = raw.topic.map((t) => scValToNative(t) as string);
  const value = scValToNative(raw.value);

  return {
    ledger: raw.ledger,
    contractId: raw.contractId?.contractId() ?? "",
    topic,
    value,
  };
}

/**
 * Fetch events from the Soroban RPC matching the given filters, starting
 * from `startLedger`. Returns the decoded events **and** the latest ledger
 * seen so the caller can paginate forward.
 */
async function fetchEvents(
  server: SorobanRpc.Server,
  contractId: string,
  topicFilter: xdr.ScVal[],
  startLedger: number
): Promise<{ events: SorobanEvent[]; latestLedger: number }> {
  const response = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [contractId],
        topics: [topicFilter.map((v) => v.toXDR("base64"))],
      },
    ],
    limit: 100,
  });

  const events = (response.events ?? []).map(decodeEvent);
  const latestLedger = response.latestLedger
    ? Number(response.latestLedger)
    : startLedger;

  return { events, latestLedger };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to new `propose` events emitted by a NebGov governor contract.
 *
 * Polls `SorobanRpc.Server.getEvents()` on the given interval and invokes
 * `callback` for every new proposal event discovered.
 *
 * **Cleaning up:** call the returned function to stop polling.
 *
 * @param governorAddress - Strkey contract address of the governor
 * @param callback        - Invoked with each decoded proposal event
 * @param opts            - Network, optional RPC URL, and polling interval
 * @returns An unsubscribe function — call it to stop polling
 *
 * @example
 * ```ts
 * const unsub = subscribeToProposals(
 *   "CABC...",
 *   (event) => console.log("New proposal!", event),
 *   { network: "testnet" },
 * );
 * // later…
 * unsub();
 * ```
 */
export function subscribeToProposals(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  const server = buildServer(opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const topicFilter = [xdr.ScVal.scvSymbol("propose")];

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      if (!initialized) {
        const info = await server.getLatestLedger();
        cursor = info.sequence;
        initialized = true;
      }

      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor
      );

      for (const event of events) {
        if (!stopped) callback(event);
      }

      // Move cursor past the events we already processed
      cursor = latestLedger + 1;
    } catch {
      // Silently retry on transient RPC errors; consumer can monitor via
      // their own error boundary or logging.
    }
  }

  const handle = setInterval(() => void poll(), intervalMs);
  // Kick off the first poll immediately
  void poll();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Subscribe to `vote` events on a specific proposal.
 *
 * Polls `SorobanRpc.Server.getEvents()` filtering by the governor contract
 * and a `vote` topic that includes the given `proposalId`.
 *
 * **Cleaning up:** call the returned function to stop polling.
 *
 * @param governorAddress - Strkey contract address of the governor
 * @param proposalId      - The proposal to watch for votes
 * @param callback        - Invoked with each decoded vote event
 * @param opts            - Network, optional RPC URL, and polling interval
 * @returns An unsubscribe function — call it to stop polling
 *
 * @example
 * ```ts
 * const unsub = subscribeToVotes(
 *   "CABC...",
 *   1n,
 *   (event) => console.log("Vote cast!", event),
 *   { network: "testnet" },
 * );
 * // later…
 * unsub();
 * ```
 */
export function subscribeToVotes(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  const server = buildServer(opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const topicFilter = [
    xdr.ScVal.scvSymbol("vote"),
    xdr.ScVal.scvU64(new xdr.Uint64(Number(proposalId))),
  ];

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      if (!initialized) {
        const info = await server.getLatestLedger();
        cursor = info.sequence;
        initialized = true;
      }

      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor
      );

      for (const event of events) {
        if (!stopped) callback(event);
      }

      cursor = latestLedger + 1;
    } catch {
      // Silently retry on transient RPC errors
    }
  }

  const handle = setInterval(() => void poll(), intervalMs);
  void poll();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Fetch historical `propose` events from a governor contract starting at a
 * given ledger sequence.
 *
 * This is a one-shot query (not a subscription). Use it to back-fill
 * proposal history on initial page load.
 *
 * @param governorAddress - Strkey contract address of the governor
 * @param fromLedger      - Ledger sequence to start scanning from
 * @param opts            - Network and optional RPC URL
 * @returns Array of decoded proposal events
 *
 * @example
 * ```ts
 * const events = await getProposalEvents("CABC...", 500_000, {
 *   network: "testnet",
 * });
 * ```
 */
export async function getProposalEvents(
  governorAddress: string,
  fromLedger: number,
  opts: SubscriptionOptions
): Promise<SorobanEvent[]> {
  const server = buildServer(opts);
  const topicFilter = [xdr.ScVal.scvSymbol("propose")];

  const { events } = await fetchEvents(
    server,
    governorAddress,
    topicFilter,
    fromLedger
  );

  return events;
}
