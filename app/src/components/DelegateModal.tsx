"use client";

/**
 * Delegation modal — lets users delegate their voting power.
 */

import { useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import { VotesClient, type Network } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";

interface Props {
  open: boolean;
  onClose: () => void;
  onDelegated?: () => void;
}

function getVotesClientFromEnv(): VotesClient {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) {
    throw new Error("Missing NEXT_PUBLIC_* contract addresses in .env.local");
  }

  return new VotesClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl && { rpcUrl }),
  });
}

function getDelegateSigner(): Keypair {
  const secret = process.env.NEXT_PUBLIC_DELEGATE_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "Missing NEXT_PUBLIC_DELEGATE_SECRET_KEY (required to sign delegate() tx in this demo app).",
    );
  }
  return Keypair.fromSecret(secret);
}

export function DelegateModal({ open, onClose, onDelegated }: Props) {
  const [delegatee, setDelegatee] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { isConnected, publicKey } = useWallet();

  if (!open) return null;

  async function handleDelegate(e: React.FormEvent) {
    e.preventDefault();
    if (!delegatee.trim()) return;
    setSubmitting(true);
    try {
      if (!isConnected || !publicKey) {
        throw new Error("Connect your wallet first.");
      }

      const client = getVotesClientFromEnv();
      const signer = getDelegateSigner();
      await client.delegate(signer, delegatee.trim());

      onDelegated?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-bold text-gray-900 mb-1">
          Delegate Voting Power
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Delegate to yourself to activate your voting power, or choose another
          address.
        </p>

        <form onSubmit={handleDelegate} className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 font-mono">
              {publicKey ? `You: ${publicKey.slice(0, 4)}…${publicKey.slice(-4)}` : "Not connected"}
            </span>
            <button
              type="button"
              disabled={!publicKey}
              onClick={() => publicKey && setDelegatee(publicKey)}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Delegate to myself
            </button>
          </div>
          <input
            type="text"
            placeholder="Stellar address (G...)"
            value={delegatee}
            onChange={(e) => setDelegatee(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
            required
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Delegating..." : "Delegate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
