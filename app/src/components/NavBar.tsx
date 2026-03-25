"use client";

/**
 * Top navigation bar.
 * Wallet connection powered by @creit.tech/stellar-wallets-kit via WalletContext.
 */

import Link from "next/link";
import { useWallet } from "../lib/wallet-context";

export function NavBar() {
  const { address, isConnected, isConnecting, error, connect, disconnect } =
    useWallet();

  return (
    <nav className="fixed top-0 left-0 right-0 bg-white border-b border-gray-200 z-50 h-16">
      <div className="max-w-4xl mx-auto px-4 h-full flex items-center justify-between">
        {/* Left — logo + links */}
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg font-bold text-gray-900">
            NebGov
          </Link>
          <div className="flex items-center gap-6 text-sm text-gray-500">
            <Link href="/" className="hover:text-gray-900 transition-colors">
              Proposals
            </Link>
            <Link
              href="/treasury"
              className="hover:text-gray-900 transition-colors"
            >
              Treasury
            </Link>
          </div>
        </div>

        {/* Right — wallet button */}
        <div className="flex flex-col items-end gap-1">
          {isConnected ? (
            <div className="flex items-center gap-2">
              {/* Truncated address badge */}
              <span className="text-sm px-3 py-1.5 rounded-lg font-mono bg-green-50 text-green-700 border border-green-200">
                {address}
              </span>

              {/* Disconnect */}
              <button
                onClick={disconnect}
                className="text-sm px-3 py-1.5 rounded-lg font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={isConnecting}
              className="text-sm px-4 py-2 rounded-lg font-medium transition-colors bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isConnecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}

          {/* Inline error message */}
          {error && (
            <p className="text-xs text-red-500 max-w-xs text-right">{error}</p>
          )}
        </div>
      </div>
    </nav>
  );
}
