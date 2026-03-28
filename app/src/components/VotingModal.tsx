"use client";

import React, { useEffect, useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import toast from "react-hot-toast";
import { GovernorClient, VoteSupport, VotesClient, type Network } from "@nebgov/sdk";
import { useWallet } from "../lib/wallet-context";

interface Props {
  open: boolean;
  onClose: () => void;
  proposalId: bigint;
  preselectedSupport: VoteSupport | null;
  delegatee: string | null;
  votingPower: bigint;
  onOpenDelegate: () => void;
  onVoted: () => void;
}

function getGovernorClientFromEnv(): GovernorClient {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) {
    throw new Error("Missing NEXT_PUBLIC_* contract addresses in .env.local");
  }

  return new GovernorClient({
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl && { rpcUrl }),
  });
}

function getVoteSigner(): Keypair {
  const secret =
    process.env.NEXT_PUBLIC_VOTE_SIGNER_SECRET_KEY ||
    process.env.NEXT_PUBLIC_DELEGATE_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "Missing NEXT_PUBLIC_VOTE_SIGNER_SECRET_KEY (or NEXT_PUBLIC_DELEGATE_SECRET_KEY) in .env.local",
    );
  }
  return Keypair.fromSecret(secret);
}

export function VotingModal({
  open,
  onClose,
  proposalId,
  preselectedSupport,
  delegatee,
  votingPower,
  onOpenDelegate,
  onVoted,
}: Props) {
  const { isConnected, connect, publicKey } = useWallet();
  const [support, setSupport] = useState<VoteSupport | null>(preselectedSupport ?? null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setSupport(preselectedSupport ?? null), [preselectedSupport]);

  if (!open) return null;

  const tokenAmount = Number(votingPower) / 1e6;

  const totalSupplyRaw = process.env.NEXT_PUBLIC_TOTAL_SUPPLY; // optional, in tokens (raw units)
  const percentOfSupply = (() => {
    try {
      if (!totalSupplyRaw) return null;
      const total = BigInt(totalSupplyRaw);
      if (total === 0n) return null;
      return Number((votingPower * 10000n) / total) / 100; // two decimals
    } catch {
      return null;
    }
  })();

  async function handleConfirm() {
    if (support === null) {
      toast.error("Select a vote option first.");
      return;
    }

    if (!isConnected || !publicKey) {
      try {
        await connect();
      } catch (e) {
        toast.error("Please connect your wallet to continue.");
        return;
      }
    }

    if (!delegatee) {
      toast.error("Delegate first before casting a vote.");
      return;
    }

    setSubmitting(true);
    try {
      const client = getGovernorClientFromEnv();
      const signer = getVoteSigner();
      await client.castVote(signer, proposalId, support);
      toast.success("Vote submitted successfully");
      onVoted();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to submit vote: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 w-full max-w-lg shadow-xl">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Cast Your Vote</h2>
            <p className="text-sm text-gray-500 dark:text-gray-300">Confirm and sign your vote on-chain.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {/* Delegation check */}
        <div className="bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-lg p-3 mb-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">Delegation</p>
          {delegatee ? (
            <p className="text-sm text-gray-700 dark:text-gray-200 mt-1">Delegated to <span className="font-mono">{delegatee}</span></p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <p className="text-sm text-red-600">You have not delegated voting power yet.</p>
              <button
                onClick={onOpenDelegate}
                className="ml-auto text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Delegate now
              </button>
            </div>
          )}
        </div>

        {/* Voting power */}
        <div className="mb-4">
          <p className="text-sm text-gray-500">Your voting power</p>
          <p className="text-base font-medium text-gray-900 dark:text-gray-100">
            {tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} tokens
            {percentOfSupply !== null ? (
              <span className="text-sm text-gray-500"> ({percentOfSupply}%)</span>
            ) : null}
          </p>
        </div>

        {/* Vote options */}
        <div className="flex gap-3 mb-4">
          {[
            { label: "For", value: VoteSupport.For, color: "border-green-500 text-green-700" },
            { label: "Against", value: VoteSupport.Against, color: "border-red-500 text-red-700" },
            { label: "Abstain", value: VoteSupport.Abstain, color: "border-gray-400 text-gray-600" },
          ].map(({ label, value, color }) => (
            <button
              key={label}
              onClick={() => setSupport(value)}
              className={`flex-1 border-2 rounded-lg py-2 text-sm font-medium transition-colors ${
                support === value ? color + " bg-opacity-10" : "border-gray-200 text-gray-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="block text-sm text-gray-600 dark:text-gray-300 mb-2">Optional reason <span className="text-xs text-gray-400">(max 256)</span></label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 256))}
          placeholder="I support this because..."
          className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 mb-3"
          rows={4}
        />
        <div className="flex items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={submitting || !isConnected || !delegatee}
            className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          >
            {submitting ? "Submitting vote..." : "Confirm & Sign"}
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
