"use client";

/**
 * Proposals list page — the main landing page.
 * TODO issue #42: wire up real proposals from GovernorClient, add filters and pagination.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { ProposalState } from "@nebgov/sdk";

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

// Placeholder data — replace with GovernorClient calls in issue #42.
const MOCK_PROPOSALS: ProposalSummary[] = [
  {
    id: 1n,
    description: "Upgrade protocol fee to 0.3%",
    state: ProposalState.Active,
    votesFor: 150000n,
    votesAgainst: 40000n,
    endLedger: 123456,
  },
  {
    id: 2n,
    description: "Add USDC/XLM pool to treasury",
    state: ProposalState.Succeeded,
    votesFor: 200000n,
    votesAgainst: 10000n,
    endLedger: 120000,
  },
];

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<ProposalSummary[]>(MOCK_PROPOSALS);

  // TODO issue #42: replace with real fetch from GovernorClient.proposalCount()
  useEffect(() => {
    setProposals(MOCK_PROPOSALS);
  }, []);

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

      <div className="space-y-4">
        {proposals.length === 0 && (
          <p className="text-gray-400 text-center py-16">No proposals yet.</p>
        )}
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
                    Against: {(Number(p.votesAgainst) / 1e7).toLocaleString()}
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
    </div>
  );
}
