"use client";

/**
 * Treasury page — shows balances and pending multi-sig transactions.
 */

import { useEffect, useMemo, useState } from "react";
import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Network } from "@nebgov/sdk";
import { useWallet } from "../../lib/wallet-context";

const HORIZON_URLS: Record<Network, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
};

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

type HorizonBalance =
  | { asset_type: "native"; balance: string }
  | {
      asset_type: "credit_alphanum4" | "credit_alphanum12";
      asset_code: string;
      asset_issuer: string;
      balance: string;
    };

type TreasuryTx = {
  id: bigint;
  proposer: string;
  target: string;
  approvals: number;
  executed: boolean;
  cancelled: boolean;
  dataHex: string;
};

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]*$/.test(s);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0 || !isHex(clean)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function getTreasurySigner(): Keypair {
  const secret = process.env.NEXT_PUBLIC_TREASURY_OWNER_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "Missing NEXT_PUBLIC_TREASURY_OWNER_SECRET_KEY (required to sign treasury approve/submit txs in this demo app).",
    );
  }
  return Keypair.fromSecret(secret);
}

class TreasuryClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(opts: { network: Network; treasuryAddress: string; rpcUrl?: string }) {
    const rpc = opts.rpcUrl ?? RPC_URLS[opts.network];
    this.server = new SorobanRpc.Server(rpc, { allowHttp: false });
    this.contract = new Contract(opts.treasuryAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[opts.network];
  }

  private async simulate(account: string, op: xdr.Operation): Promise<xdr.ScVal | null> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(account), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return null;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return raw ?? null;
  }

  async txCount(viewer: string): Promise<number | null> {
    // Not present in older local contract, but expected by issue #27.
    const rv = await this.simulate(viewer, this.contract.call("tx_count"));
    if (!rv) return null;
    return Number(scValToNative(rv));
  }

  async threshold(viewer: string): Promise<number> {
    const rv = await this.simulate(viewer, this.contract.call("threshold"));
    if (!rv) return 1;
    return Number(scValToNative(rv));
  }

  async getTx(viewer: string, id: number): Promise<TreasuryTx | null> {
    const rv = await this.simulate(
      viewer,
      this.contract.call("get_tx", nativeToScVal(id, { type: "u64" })),
    );
    if (!rv) return null;

    const tx = scValToNative(rv) as unknown as {
      id: bigint;
      proposer: string;
      target: string;
      data: Uint8Array;
      approvals: number;
      executed: boolean;
      cancelled: boolean;
    };

    return {
      id: BigInt(tx.id),
      proposer: tx.proposer,
      target: tx.target,
      approvals: Number(tx.approvals),
      executed: !!tx.executed,
      cancelled: !!tx.cancelled,
      dataHex: bytesToHex(tx.data),
    };
  }

  async hasApproved(viewer: string, txId: number, approver: string): Promise<boolean | null> {
    // Not present in older local contract, but expected by issue #27.
    const rv = await this.simulate(
      viewer,
      this.contract.call(
        "has_approved",
        nativeToScVal(txId, { type: "u64" }),
        nativeToScVal(approver, { type: "address" }),
      ),
    );
    if (!rv) return null;
    return Boolean(scValToNative(rv));
  }

  async approve(signer: Keypair, txId: number): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "approve",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(txId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    await this.server.sendTransaction(prepared);
  }

  async submit(signer: Keypair, target: string, data: Uint8Array): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "submit",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(target, { type: "address" }),
          nativeToScVal(data, { type: "bytes" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    await this.server.sendTransaction(prepared);
  }
}

export default function TreasuryPage() {
  const { isConnected } = useWallet();

  const [xlmBalance, setXlmBalance] = useState<string>("—");
  const [usdcBalance, setUsdcBalance] = useState<string>("—");

  const [txs, setTxs] = useState<TreasuryTx[]>([]);
  const [threshold, setThreshold] = useState<number>(1);
  const [alreadyApproved, setAlreadyApproved] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [submitTarget, setSubmitTarget] = useState("");
  const [submitDataHex, setSubmitDataHex] = useState("");

  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const horizonBaseUrl = HORIZON_URLS[network];

  const treasuryContractAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "";
  const treasuryAccountId = process.env.NEXT_PUBLIC_TREASURY_ACCOUNT || "";
  const usdcIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER || "";
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;

  const treasuryClient = useMemo(() => {
    if (!treasuryContractAddress) return null;
    return new TreasuryClient({ network, treasuryAddress: treasuryContractAddress, rpcUrl });
  }, [network, rpcUrl, treasuryContractAddress]);

  async function fetchBalances() {
    if (!treasuryAccountId) return;

    const res = await fetch(`${horizonBaseUrl}/accounts/${treasuryAccountId}`, {
      method: "GET",
    });
    if (!res.ok) throw new Error(`Failed to fetch treasury balances: ${res.status}`);

    const json = (await res.json()) as { balances?: HorizonBalance[] };
    const balances = json.balances ?? [];

    const native = balances.find((b) => b.asset_type === "native") as
      | { asset_type: "native"; balance: string }
      | undefined;
    setXlmBalance(native?.balance ?? "0");

    const usdc = balances.find((b) => {
      if (b.asset_type !== "credit_alphanum4" && b.asset_type !== "credit_alphanum12") {
        return false;
      }
      if (b.asset_code !== "USDC") return false;
      if (usdcIssuer && b.asset_issuer !== usdcIssuer) return false;
      return true;
    }) as
      | {
          asset_type: "credit_alphanum4" | "credit_alphanum12";
          asset_code: string;
          asset_issuer: string;
          balance: string;
        }
      | undefined;
    setUsdcBalance(usdc?.balance ?? "0");
  }

  async function fetchPendingTxs(viewer: string) {
    if (!treasuryClient) return;

    const [t, count] = await Promise.all([
      treasuryClient.threshold(viewer),
      treasuryClient.txCount(viewer),
    ]);
    setThreshold(t);

    // Fetch IDs 1..tx_count (fallback: scan until missing).
    const results: TreasuryTx[] = [];
    const limit = count ?? 50;
    for (let id = 1; id <= limit; id++) {
      const tx = await treasuryClient.getTx(viewer, id);
      if (!tx) {
        if (count === null) break;
        continue;
      }
      if (!tx.executed && !tx.cancelled) {
        results.push(tx);
      }
    }
    setTxs(results);

    // Fetch "already approved" when contract supports it.
    const approvedMap: Record<string, boolean> = {};
    for (const tx of results) {
      const v = await treasuryClient.hasApproved(viewer, Number(tx.id), viewer);
      if (v !== null) approvedMap[tx.id.toString()] = v;
    }
    setAlreadyApproved(approvedMap);
  }

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      const signer = getTreasurySigner();
      await Promise.all([fetchBalances(), fetchPendingTxs(signer.publicKey())]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load treasury data";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isConnected) {
      setTxs([]);
      setAlreadyApproved({});
      setThreshold(1);
      setLoading(false);
      return;
    }
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, treasuryClient]);

  async function handleApprove(txId: bigint) {
    if (!treasuryClient) return;
    setApproving((m) => ({ ...m, [txId.toString()]: true }));
    try {
      const signer = getTreasurySigner();
      await treasuryClient.approve(signer, Number(txId));
      await fetchPendingTxs(signer.publicKey());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Approve failed";
      setError(msg);
    } finally {
      setApproving((m) => ({ ...m, [txId.toString()]: false }));
    }
  }

  async function handleSubmitTx(e: React.FormEvent) {
    e.preventDefault();
    if (!treasuryClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const signer = getTreasurySigner();
      const data = hexToBytes(submitDataHex);
      await treasuryClient.submit(signer, submitTarget.trim(), data);
      setSubmitTarget("");
      setSubmitDataHex("");
      await fetchPendingTxs(signer.publicKey());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Submit failed";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Treasury</h1>

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!treasuryContractAddress && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          Missing <span className="font-mono">NEXT_PUBLIC_TREASURY_ADDRESS</span> in{" "}
          <span className="font-mono">app/.env.local</span>.
        </div>
      )}

      {!treasuryAccountId && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          Missing <span className="font-mono">NEXT_PUBLIC_TREASURY_ACCOUNT</span> (treasury
          Stellar account for Horizon balance queries).
        </div>
      )}

      {/* Balances */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <p className="text-sm text-gray-500">USDC Balance</p>
          <p className="text-2xl font-bold mt-1">
            {loading ? "Loading…" : `${usdcBalance} USDC`}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <p className="text-sm text-gray-500">XLM Balance</p>
          <p className="text-2xl font-bold mt-1">
            {loading ? "Loading…" : `${xlmBalance} XLM`}
          </p>
        </div>
      </div>

      {/* Submit Transaction */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Submit Transaction
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Owners can propose a new treasury action (target + calldata bytes).
        </p>

        <form onSubmit={handleSubmitTx} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Target address</label>
            <input
              type="text"
              value={submitTarget}
              onChange={(e) => setSubmitTarget(e.target.value)}
              placeholder="Contract (C...) or account (G...)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Calldata (hex)</label>
            <input
              type="text"
              value={submitDataHex}
              onChange={(e) => setSubmitDataHex(e.target.value)}
              placeholder="0x..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              required
            />
          </div>
          <button
            type="submit"
            disabled={!isConnected || submitting || !treasuryClient}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Submitting…" : "Submit Transaction"}
          </button>
        </form>
      </div>

      {/* Pending transactions */}
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Pending Transactions
      </h2>
      <div className="space-y-3">
        {txs.length === 0 && !loading && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500">
            No pending transactions.
          </div>
        )}

        {txs.map((tx) => {
          const approvals = tx.approvals;
          const has = alreadyApproved[tx.id.toString()] ?? false;
          const pct = threshold > 0 ? Math.min(100, Math.round((approvals / threshold) * 100)) : 0;

          return (
          <div
            key={tx.id.toString()}
            className="bg-white border border-gray-200 rounded-xl p-5 flex items-center justify-between"
          >
            <div>
              <p className="text-sm font-medium text-gray-900">
                Tx #{tx.id.toString()}
              </p>
              <div className="mt-2 space-y-1">
                <p className="text-xs text-gray-500 font-mono">
                  Target: {tx.target}
                </p>
                <p className="text-xs text-gray-400">
                  {approvals}/{threshold} approvals
                </p>
                <div className="w-64 max-w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-indigo-600 h-2 rounded-full"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
            <button
              onClick={() => handleApprove(tx.id)}
              disabled={!isConnected || has || approving[tx.id.toString()] || !treasuryClient}
              className="text-sm text-indigo-600 border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {has ? "Approved" : approving[tx.id.toString()] ? "Approving…" : "Approve"}
            </button>
          </div>
        )})}
      </div>
    </div>
  );
}
