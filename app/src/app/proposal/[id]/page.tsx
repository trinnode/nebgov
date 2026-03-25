"use client";

/**
 * Proposal detail page — shows votes, description, and voting UI.
 * TODO issue #43: fetch real proposal data, add vote breakdown chart (recharts).
 * TODO issue #46: wire up vote casting UI to GovernorClient.castVote().
 */

import { useEffect, useMemo, useState } from "react";
import { VoteSupport, ProposalState, VotesClient, type Network } from "@nebgov/sdk";
import { useWallet } from "../../../lib/wallet-context";
import { DelegateModal } from "../../../components/DelegateModal";

interface Props {
  params: { id: string };
}

const MOCK_PROPOSAL = {
  id: 1n,
  description: "Upgrade protocol fee to 0.3%",
  state: ProposalState.Active,
  votesFor: 150000n,
  votesAgainst: 40000n,
  votesAbstain: 5000n,
  endLedger: 123456,
  proposer: "GABC...1234",
};

export default function ProposalDetailPage({ params }: Props) {
  const [voted, setVoted] = useState(false);
  const [voting, setVoting] = useState(false);
  const [selectedSupport, setSelectedSupport] = useState<VoteSupport | null>(null);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [delegatee, setDelegatee] = useState<string | null>(null);
  const [votingPower, setVotingPower] = useState<bigint>(0n);
  const [delegationLoading, setDelegationLoading] = useState(false);

  const proposal = MOCK_PROPOSAL; // TODO: fetch by params.id
  const { publicKey, isConnected } = useWallet();

  const votesClient = useMemo(() => {
    const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
    const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
    const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
    const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

    if (!governorAddress || !timelockAddress || !votesAddress) return null;

    return new VotesClient({
      governorAddress,
      timelockAddress,
      votesAddress,
      network,
      ...(rpcUrl && { rpcUrl }),
    });
  }, []);

  async function refreshDelegation() {
    if (!votesClient || !publicKey) return;
    setDelegationLoading(true);
    try {
      const [d, power] = await Promise.all([
        votesClient.getDelegatee(publicKey),
        votesClient.getVotes(publicKey),
      ]);
      setDelegatee(d);
      setVotingPower(power);
    } finally {
      setDelegationLoading(false);
    }
  }

  useEffect(() => {
    if (!isConnected || !publicKey) {
      setDelegatee(null);
      setVotingPower(0n);
      return;
    }
    refreshDelegation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, publicKey, votesClient]);

  const total =
    Number(proposal.votesFor) +
    Number(proposal.votesAgainst) +
    Number(proposal.votesAbstain);

  const pct = (n: bigint) =>
    total === 0 ? 0 : Math.round((Number(n) / total) * 100);

  async function handleVote() {
    if (selectedSupport === null) return;
    setVoting(true);
    try {
      // TODO issue #46: call GovernorClient.castVote(signer, proposalId, support)
      console.log("Casting vote:", VoteSupport[selectedSupport]);
      await new Promise((r) => setTimeout(r, 1500));
      setVoted(true);
    } finally {
      setVoting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <p className="text-sm text-gray-400 mb-1">
        Proposal #{params.id}
      </p>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        {proposal.description}
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Proposed by <span className="font-mono">{proposal.proposer}</span>
      </p>

      {/* Delegation */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
              Delegation
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Delegate voting power to yourself or another address.
            </p>
          </div>
          <button
            onClick={() => setDelegateOpen(true)}
            disabled={!isConnected}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Delegate
          </button>
        </div>

        <div className="mt-4 text-sm text-gray-700">
          {delegationLoading ? (
            <p className="text-gray-500">Loading delegation…</p>
          ) : delegatee ? (
            <div className="space-y-1">
              <p>
                Current delegatee:{" "}
                <span className="font-mono text-gray-900">{delegatee}</span>
              </p>
              <p>
                Voting power:{" "}
                <span className="font-mono text-gray-900">{votingPower.toString()}</span>
              </p>
            </div>
          ) : (
            <p className="text-gray-500">
              No delegatee set{isConnected ? "." : " (connect wallet to view)."}
            </p>
          )}
        </div>
      </div>

      {/* Vote bars — TODO issue #43: replace with recharts pie/bar chart */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
          Current Votes
        </h2>

        {[
          { label: "For", votes: proposal.votesFor, color: "bg-green-500" },
          { label: "Against", votes: proposal.votesAgainst, color: "bg-red-500" },
          { label: "Abstain", votes: proposal.votesAbstain, color: "bg-gray-400" },
        ].map(({ label, votes, color }) => (
          <div key={label}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-700">{label}</span>
              <span className="text-gray-500">
                {(Number(votes) / 1e7).toLocaleString()} ({pct(votes)}%)
              </span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className={`${color} h-2 rounded-full`}
                style={{ width: `${pct(votes)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Voting UI */}
      {proposal.state === ProposalState.Active && !voted && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">
            Cast Your Vote
          </h2>
          <div className="flex gap-3 mb-4">
            {[
              { label: "For", value: VoteSupport.For, color: "border-green-500 text-green-700" },
              { label: "Against", value: VoteSupport.Against, color: "border-red-500 text-red-700" },
              { label: "Abstain", value: VoteSupport.Abstain, color: "border-gray-400 text-gray-600" },
            ].map(({ label, value, color }) => (
              <button
                key={label}
                onClick={() => setSelectedSupport(value)}
                className={`flex-1 border-2 rounded-lg py-2 text-sm font-medium transition-colors
                  ${selectedSupport === value ? color + " bg-opacity-10" : "border-gray-200 text-gray-500"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={handleVote}
            disabled={selectedSupport === null || voting}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {voting ? "Submitting vote..." : "Submit Vote"}
          </button>
        </div>
      )}

      {voted && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-green-800 text-sm">
          Your vote has been submitted.
        </div>
      )}

      <DelegateModal
        open={delegateOpen}
        onClose={() => setDelegateOpen(false)}
        onDelegated={() => refreshDelegation()}
      />
    </div>
  );
}
