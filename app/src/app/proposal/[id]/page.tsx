"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { VoteSupport, ProposalState, VotesClient, GovernorClient, VoteType, type GovernorSettings, type Network } from "@nebgov/sdk";
import { AlertTriangle, Info, ExternalLink, Loader2 } from "lucide-react";
import { useWallet } from "../../../lib/wallet-context";
import { DelegateModal } from "../../../components/DelegateModal";
import { VotingModal } from "../../../components/VotingModal";
import { fetchProposalMetadata, verifyMetadataHash } from "../../../lib/metadata";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine
} from "recharts";

import { useTheme } from "../../../hooks/useTheme";

interface Props {
  params: { id: string };
}

// Initial state for proposal to avoid undefined errors during loading
const INITIAL_PROPOSAL = {
  id: 0n,
  description: "Loading...",
  descriptionHash: "",
  metadataUri: "",
  state: ProposalState.Pending,
  votesFor: 0n,
  votesAgainst: 0n,
  votesAbstain: 0n,
  endLedger: 0,
  proposer: "",
  quorum: 0n,
};

export default function ProposalDetailPage({ params }: Props) {
  const proposalId = useMemo(() => BigInt(params.id), [params.id]);
  const [proposal, setProposal] = useState(INITIAL_PROPOSAL);
  const [loading, setLoading] = useState(true);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [hashMismatched, setHashMismatched] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [voted, setVoted] = useState(false);
  const [selectedSupport, setSelectedSupport] = useState<VoteSupport | null>(null);
  const [delegateModalOpen, setDelegateModalOpen] = useState(false);
  const [voteModalOpen, setVoteModalOpen] = useState(false);
  const [votingPower, setVotingPower] = useState<bigint>(0n);
  const [delegationLoading, setDelegationLoading] = useState(false);
  const [isVoting, setIsVoting] = useState(false);
  const [voteSuccess, setVoteSuccess] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [votedSupport, setVotedSupport] = useState<VoteSupport | null>(null);
  const [voteType, setVoteType] = useState<VoteType>(VoteType.Simple);

  const { publicKey, isConnected, signTransaction } = useWallet();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const config = useMemo(() => {
    const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
    const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
    const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
    const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

    if (!governorAddress || !timelockAddress || !votesAddress) return null;

    return {
      governorAddress,
      timelockAddress,
      votesAddress,
      network,
      ...(rpcUrl && { rpcUrl }),
    };
  }, []);

  const votesClient = useMemo(() => config ? new VotesClient(config) : null, [config]);
  const governorClient = useMemo(() => config ? new GovernorClient(config) : null, [config]);

  const loadProposal = useCallback(async () => {
    if (!governorClient) return;
    setLoading(true);
    try {
      const p = await governorClient.getProposal(proposalId);
      setProposal({
        ...p,
        state: await governorClient.getProposalState(proposalId),
      });
    } catch (err) {
      console.error("Failed to load proposal:", err);
    } finally {
      setLoading(false);
    }
  }, [governorClient, proposalId]);

  useEffect(() => {
    loadProposal();
  }, [loadProposal]);

  useEffect(() => {
    if (!governorClient) return;
    governorClient.getSettings().then((s: GovernorSettings) => setVoteType(s.voteType)).catch(() => {});
  }, [governorClient]);

  const loadMetadata = useCallback(async () => {
    if (!proposal.metadataUri) return;
    setMetadataLoading(true);
    setFetchError(null);
    try {
      const content = await fetchProposalMetadata(proposal.metadataUri);
      setMetadata(content);
      const isMatch = await verifyMetadataHash(content, proposal.descriptionHash);
      setHashMismatched(!isMatch);
    } catch (err: any) {
      setFetchError(err.message);
    } finally {
      setMetadataLoading(false);
    }
  }, [proposal.metadataUri, proposal.descriptionHash]);

  useEffect(() => {
    if (proposal.id !== 0n) {
      loadMetadata();
    }
  }, [proposal.id, loadMetadata]);

  async function refreshDelegation() {
    if (!votesClient || !publicKey) return;
    setDelegationLoading(true);
    try {
      const power = await votesClient.getVotes(publicKey);
      setVotingPower(power);
    } catch (err) {
      console.error("Failed to fetch voting power:", err);
    } finally {
      setDelegationLoading(false);
    }
  }

  useEffect(() => {
    if (isConnected) {
      refreshDelegation();
    }
  }, [isConnected, votesClient, publicKey]);

  // Transform data for Recharts
  const chartData = useMemo(() => [
    { name: "For", votes: Number(proposal.votesFor) },
    { name: "Against", votes: Number(proposal.votesAgainst) },
    { name: "Abstain", votes: Number(proposal.votesAbstain) },
  ], [proposal.votesFor, proposal.votesAgainst, proposal.votesAbstain]);

  const COLORS: Record<string, string> = {
    For: "#10b981",    // green-500
    Against: "#f43f5e", // rose-500
    Abstain: isDark ? "#475569" : "#94a3b8", // slate-600 : slate-400
  };

  const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;

  async function handleCastVote() {
    if (selectedSupport === null || !governorClient || !publicKey || isVoting) return;

    setIsVoting(true);
    setVoteError(null);
    setVoteSuccess(false);

    try {
      await governorClient.castVoteWithSign(
        publicKey,
        proposalId,
        selectedSupport,
        signTransaction
      );

      setVoteSuccess(true);
      setVotedSupport(selectedSupport);
      setVoted(true);
      await loadProposal();
    } catch (err: any) {
      console.error("Vote submission failed:", err);
      let message = "An unknown error occurred while casting your vote.";

      const errStr = String(err);
      if (errStr.includes("already voted") || errStr.includes("Already voted") || errStr.includes("Error(Contract, #1)")) {
        message = "You have already voted on this proposal.";
      } else if (errStr.includes("Proposal not active") || errStr.includes("Error(Contract, #2)")) {
        message = "This proposal is no longer accepting votes.";
      } else if (errStr.includes("zero voting power") || errStr.includes("Insufficient voting power") || errStr.includes("Error(Contract, #3)")) {
        message = "You do not have sufficient voting power to vote on this proposal.";
      }

      setVoteError(message);
    } finally {
      setIsVoting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin mb-4" />
        <p>Loading proposal data...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-1">
        <p className="text-sm text-gray-400">
          Proposal #{params.id}
        </p>
        <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider
          ${proposal.state === ProposalState.Active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
          {ProposalState[proposal.state]}
        </div>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        {proposal.description}
      </h1>

      <p className="text-sm text-gray-500 mb-6">
        Proposed by <span className="font-mono">{proposal.proposer}</span>
      </p>

      {/* Veto Window Status - shown when proposal is Queued */}
      {proposal.state === ProposalState.Queued && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse"></div>
            <div>
              <p className="text-sm font-semibold text-blue-900">
                Veto Window Open
              </p>
              <p className="text-xs text-blue-700 mt-1">
                The guardian can cancel this proposal during the veto window before execution becomes possible.
              </p>
      {/* Hash Mismatch Warning */}
      {hashMismatched && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <h3 className="font-semibold text-amber-800">Content Integrity Warning</h3>
            <p className="text-amber-700 mt-0.5">
              The external content fetched for this proposal does not match the hash stored on-chain.
              The displayed description may have been tampered with.
            </p>
            <div className="mt-2 space-y-1 font-mono text-[11px]">
              <p className="text-gray-500">On-chain: {proposal.descriptionHash.substring(0, 16)}...</p>
            </div>
          </div>
        </div>
      )}

      {/* Fetch Error Info */}
      {fetchError && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 flex gap-3 text-sm">
          <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="text-blue-700">
            <p className="font-semibold text-blue-800">Metadata Unreachable</p>
            <p className="mt-0.5">Could not load the full description. Check the URI directly below.</p>
            <p className="mt-2 font-mono text-[11px] text-gray-500">Hash: {proposal.descriptionHash}</p>
          </div>
        </div>
      )}

      {/* Metadata / Description Section */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Description
          </h2>
          {proposal.metadataUri && (
            <a
              href={proposal.metadataUri.startsWith('ipfs://')
                ? `https://ipfs.io/ipfs/${proposal.metadataUri.replace('ipfs://', '')}`
                : proposal.metadataUri}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 flex items-center gap-1 text-xs hover:underline"
            >
              View Source <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        {metadataLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Fetching off-chain content...
          </div>
        ) : metadata ? (
          <div className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
            {metadata}
          </div>
        ) : (
          <p className="text-gray-400 italic py-4">
            {fetchError ? "Content unavailable" : proposal.description}
          </p>
        )}
      </div>

      {/* Delegation */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-1">
              Your Voting Power
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-gray-900 dark:text-white font-mono">
                {delegationLoading ? "..." : (Number(votingPower) / 10 ** 7).toLocaleString()}
              </span>
              <span className="text-sm text-gray-400">NEB</span>
            </div>
          </div>
          <button
            onClick={() => setDelegateModalOpen(true)}
            className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Delegate
          </button>
        </div>
      </div>

      {/* Vote bars */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Current Votes
          </h2>
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
            voteType === VoteType.Quadratic
              ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
              : voteType === VoteType.Extended
              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
          }`}>
            {voteType}
          </span>
        </div>

        <div className="h-48 w-full mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ left: -20, right: 20, top: 0, bottom: 0 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 12, fontWeight: 500, fill: isDark ? '#94a3b8' : '#64748b' }}
              />
               <Tooltip
                cursor={{ fill: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)' }}
                contentStyle={{ 
                  borderRadius: '12px', 
                  border: 'none', 
                  boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                  backgroundColor: isDark ? '#1f2937' : '#ffffff',
                  color: isDark ? '#f3f4f6' : '#111827'
                }}
                itemStyle={{ color: isDark ? '#f3f4f6' : '#111827' }}
              />
              <Bar
                dataKey="votes"
                radius={[0, 4, 4, 0]}
                animationDuration={800}
                barSize={28}
              >
                {chartData.map((entry) => (
                  <Cell key={entry.name} fill={COLORS[entry.name]} />
                ))}
              </Bar>
              {proposal.quorum && (
                <ReferenceLine
                  x={Number(proposal.quorum)}
                  stroke="#ef4444"
                  strokeDasharray="3 3"
                  label={{ position: 'top', value: 'Quorum', fill: '#ef4444', fontSize: 10 }}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-3 gap-4 border-t border-gray-100 dark:border-gray-700 pt-6">
          <div>
            <p className="text-xs text-gray-400 font-medium mb-1 uppercase">For</p>
            <p className="font-mono text-lg font-bold text-emerald-600">{(Number(proposal.votesFor) / 10 ** 7).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 font-medium mb-1 uppercase">Against</p>
            <p className="font-mono text-lg font-bold text-rose-600">{(Number(proposal.votesAgainst) / 10 ** 7).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 font-medium mb-1 uppercase">Abstain</p>
            <p className="font-mono text-lg font-bold text-slate-500 dark:text-slate-400">{(Number(proposal.votesAbstain) / 10 ** 7).toLocaleString()}</p>
          </div>
        </div>
      </div>

      {/* Voting UI */}
      {proposal.state === ProposalState.Active && !voted && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
            Cast Your Vote
          </h2>

          {!isConnected ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
              <p className="text-gray-600 text-sm mb-3">Connect your wallet to participate in governance.</p>
              <button
                onClick={() => useWallet().connect()}
                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
              >
                Connect Wallet to Vote
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row gap-3 mb-4">
                {[
                  { label: "For", value: VoteSupport.For, aria: "Vote For" },
                  { label: "Against", value: VoteSupport.Against, aria: "Vote Against" },
                  { label: "Abstain", value: VoteSupport.Abstain, aria: "Vote Abstain" },
                ].map(({ label, value, aria }) => (
                  <button
                    key={label}
                    onClick={() => setSelectedSupport(value)}
                    disabled={isVoting}
                    aria-label={aria}
                    className={`flex-1 py-3 rounded-lg border-2 font-medium transition-all
                      ${selectedSupport === value
                        ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
                        : "border-gray-100 dark:border-gray-700 hover:border-gray-200 dark:hover:border-gray-600 text-gray-600 dark:text-gray-400"}
                      ${isVoting ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {voteError && (
                <div role="alert" className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex gap-2 items-start">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  {voteError}
                </div>
              )}

              <button
                onClick={handleCastVote}
                disabled={selectedSupport === null || isVoting}
                aria-busy={isVoting}
                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {isVoting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Submitting Vote...
                  </>
                ) : (
                  "Submit Vote"
                )}
              </button>
            </>
          )}
        </div>
      )}

      {voted && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center" aria-live="polite">
          <p className="text-emerald-800 font-medium">
            Your vote {votedSupport !== null ? `(${VoteSupport[votedSupport]})` : ""} has been recorded!
          </p>
        </div>
      )}

      <DelegateModal
        isOpen={delegateModalOpen}
        onClose={() => setDelegateModalOpen(false)}
        onSuccess={refreshDelegation}
      />
      <VotingModal
        open={voteModalOpen}
        onClose={() => setVoteModalOpen(false)}
        proposalId={proposalId}
        preselectedSupport={selectedSupport}
        votingPower={votingPower}
        voteType={voteType}
        onVoted={() => {
          setVoted(true);
          loadProposal();
        }}
        governorClient={governorClient}
      />
    </div>
  );
}
