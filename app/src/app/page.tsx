"use client";

/**
 * Proposals list page — the main landing page.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { GovernorClient, ProposalState, Network } from "@nebgov/sdk";

interface ProposalSummary {
  id: bigint;
  description: string;
  state: ProposalState;
  votesFor: bigint;
  votesAgainst: bigint;
  endLedger: number;
}

const STATE_COLORS: Record<ProposalState, string> = {
  [ProposalState.Pending]: "bg-yellow-100 text-yellow-800",
  [ProposalState.Active]: "bg-blue-100 text-blue-800",
  [ProposalState.Succeeded]: "bg-green-100 text-green-800",
  [ProposalState.Defeated]: "bg-red-100 text-red-800",
  [ProposalState.Queued]: "bg-purple-100 text-purple-800",
  [ProposalState.Executed]: "bg-gray-100 text-gray-800",
  [ProposalState.Cancelled]: "bg-gray-100 text-gray-500",
};

const PROPOSALS_PER_PAGE = 10;

/**
 * Loading skeleton for proposal cards
 */
function ProposalSkeleton() {
  return (
    <div className="block bg-white border border-gray-200 rounded-xl p-6 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="h-3 bg-gray-200 rounded w-24 mb-2"></div>
          <div className="h-5 bg-gray-200 rounded w-3/4 mb-3"></div>
          <div className="flex items-center gap-4">
            <div className="h-4 bg-gray-200 rounded w-20"></div>
            <div className="h-4 bg-gray-200 rounded w-20"></div>
          </div>
        </div>
        <div className="ml-4 h-6 bg-gray-200 rounded-full w-20"></div>
      </div>
    </div>
  );
}

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0n);

  useEffect(() => {
    async function fetchProposals() {
      setLoading(true);
      setError(null);

      try {
        // Read environment variables
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK ||
          "testnet") as Network;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

        // Validate required environment variables
        if (!governorAddress || !timelockAddress || !votesAddress) {
          throw new Error(
            "Missing required environment variables. Please check .env.local configuration.",
          );
        }

        // Initialize GovernorClient
        const client = new GovernorClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });

        // Get total proposal count
        const count = await client.proposalCount();
        setTotalCount(count);

        if (count === 0n) {
          setProposals([]);
          setLoading(false);
          return;
        }

        // Calculate which proposals to fetch for current page
        const startIdx = Number(count) - (currentPage - 1) * PROPOSALS_PER_PAGE;
        const endIdx = Math.max(startIdx - PROPOSALS_PER_PAGE, 0);

        // Fetch proposals in reverse order (newest first)
        const proposalPromises: Promise<ProposalSummary | null>[] = [];
        for (let i = startIdx; i > endIdx && i > 0; i--) {
          proposalPromises.push(
            (async () => {
              try {
                const proposalId = BigInt(i);

                // Fetch state and votes in parallel
                const [state, votes] = await Promise.all([
                  client.getProposalState(proposalId),
                  client.getProposalVotes(proposalId),
                ]);

                return {
                  id: proposalId,
                  description: `Proposal ${i}`, // TODO: Fetch actual description in future issue
                  state,
                  votesFor: votes.votesFor,
                  votesAgainst: votes.votesAgainst,
                  endLedger: 0, // TODO: Fetch actual endLedger in future issue
                };
              } catch (err) {
                console.error(`Error fetching proposal ${i}:`, err);
                return null;
              }
            })(),
          );
        }

        const results = await Promise.all(proposalPromises);
        const validProposals = results.filter(
          (p): p is ProposalSummary => p !== null,
        );

        setProposals(validProposals);
      } catch (err) {
        console.error("Error fetching proposals:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load proposals",
        );
      } finally {
        setLoading(false);
      }
    }

    fetchProposals();
  }, [currentPage]);

  const totalPages = Math.ceil(Number(totalCount) / PROPOSALS_PER_PAGE);
  const hasMultiplePages = totalPages > 1;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Proposals</h1>
          <p className="text-gray-500 mt-1">
            Vote on governance decisions for this protocol.
          </p>
        </div>
        <Link
          href="/propose"
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          New Proposal
        </Link>
      </div>

      {/* Error state */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
          <p className="text-red-800 text-sm font-medium">
            Error loading proposals
          </p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <ProposalSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && proposals.length === 0 && (
        <div className="text-center py-16">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            No proposals
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Get started by creating a new proposal.
          </p>
          <div className="mt-6">
            <Link
              href="/propose"
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              New Proposal
            </Link>
          </div>
        </div>
      )}

      {/* Proposals list */}
      {!loading && !error && proposals.length > 0 && (
        <>
          <div className="space-y-4">
            {proposals.map((p) => (
              <Link
                key={p.id.toString()}
                href={`/proposal/${p.id}`}
                className="block bg-white border border-gray-200 rounded-xl p-6 hover:border-indigo-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 mb-1">
                      Proposal #{p.id.toString()}
                    </p>
                    <h2 className="text-lg font-semibold text-gray-900 truncate">
                      {p.description}
                    </h2>
                    <div className="mt-3 flex items-center gap-4 text-sm text-gray-500">
                      <span>
                        For: {(Number(p.votesFor) / 1e7).toLocaleString()}
                      </span>
                      <span>
                        Against:{" "}
                        {(Number(p.votesAgainst) / 1e7).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`ml-4 shrink-0 px-3 py-1 rounded-full text-xs font-medium ${STATE_COLORS[p.state]}`}
                  >
                    {p.state}
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {hasMultiplePages && (
            <div className="mt-8 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Page {currentPage} of {totalPages} ({totalCount.toString()}{" "}
                proposals total)
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                  disabled={currentPage === totalPages}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
