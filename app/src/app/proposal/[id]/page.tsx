"use client";

/**
 * Proposal detail page — shows votes, description, and voting UI.
 * TODO issue #43: fetch real proposal data, add vote breakdown chart (recharts).
 * TODO issue #46: wire up vote casting UI to GovernorClient.castVote().
 */

import { useEffect, useMemo, useState } from "react";
import { VoteSupport, ProposalState, VotesClient, type Network } from "@nebgov/sdk";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  ReferenceLine,
} from "recharts";
import { useWallet } from "../../../lib/wallet-context";
import { DelegateModal } from "../../../components/DelegateModal";
import { VotingModal } from "../../../components/VotingModal";

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
  quorum: 100000n as bigint | undefined,
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

  const toMillions = (n: bigint) => Number(n) / 1e6;

  const chartData = [
    { name: "For", votes: toMillions(proposal.votesFor), pct: pct(proposal.votesFor) },
    { name: "Against", votes: toMillions(proposal.votesAgainst), pct: pct(proposal.votesAgainst) },
    { name: "Abstain", votes: toMillions(proposal.votesAbstain), pct: pct(proposal.votesAbstain) },
  ];

  const COLORS: Record<string, string> = {
    For: "#22c55e",
    Against: "#ef4444",
    Abstain: "#9ca3af",
  };

  const quorumThreshold = proposal.quorum
    ? Number(proposal.quorum) / 1e6
    : undefined;

  async function handleVote() {
    // Open vote confirmation modal instead of immediate submit
    if (selectedSupport === null) return;
    setVoteModalOpen(true);
  }

  const [voteModalOpen, setVoteModalOpen] = useState(false);

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

        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 30, left: 10, bottom: 0 }}
          >
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: "#6b7280" }}
              tickFormatter={(v: number) => `${v.toLocaleString()}M`}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 13, fontWeight: 500, fill: "#374151" }}
              width={70}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number, _name: string, entry: { payload: { pct: number } }) => [
                `${value.toLocaleString()}M tokens (${entry.payload.pct}%)`,
                "Votes",
              ]}
              cursor={{ fill: "rgba(0,0,0,0.04)" }}
              contentStyle={{ borderRadius: 8, fontSize: 13 }}
            />
            <Bar
              dataKey="votes"
              radius={[0, 6, 6, 0]}
              isAnimationActive={true}
              animationDuration={800}
              barSize={28}
            >
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={COLORS[entry.name]} />
              ))}
            </Bar>
            {quorumThreshold !== undefined && (
              <ReferenceLine
                x={quorumThreshold}
                stroke="#6366f1"
                strokeDasharray="6 3"
                strokeWidth={2}
                label={{
                  value: `Quorum ${quorumThreshold.toLocaleString()}M`,
                  position: "top",
                  fill: "#6366f1",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>

        {/* Legend with counts */}
        <div className="flex justify-center gap-6 mt-4 text-sm">
          {chartData.map((entry) => (
            <div key={entry.name} className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ backgroundColor: COLORS[entry.name] }}
              />
              <span className="text-gray-700 font-medium">{entry.name}</span>
              <span className="text-gray-400">
                {entry.votes.toLocaleString()}M ({entry.pct}%)
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Voting UI */}
      {proposal.state === ProposalState.Active && !voted && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-4">
            Cast Your Vote
          </h2>
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
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
      <VotingModal
        open={voteModalOpen}
        onClose={() => setVoteModalOpen(false)}
        proposalId={BigInt(params.id)}
        preselectedSupport={selectedSupport}
        delegatee={delegatee}
        votingPower={votingPower}
        onOpenDelegate={() => setDelegateOpen(true)}
        onVoted={() => {
          setVoted(true);
          refreshDelegation();
        }}
      />
    </div>
  );
}
