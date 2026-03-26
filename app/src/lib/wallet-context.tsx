"use client";

/**
 * Wallet context — single source of truth for Stellar wallet state.
 * Uses @creit.tech/stellar-wallets-kit (v2.x) with Freighter, Albedo, xBull.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  FreighterModule,
  xBullModule,
  AlbedoModule,
  type ISupportedWallet,
} from "@creit.tech/stellar-wallets-kit";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WalletContextValue {
  /** Truncated public key when connected, e.g. "GABC...XY12" */
  address: string | null;
  /** Full public key when connected, e.g. "G...". */
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  /** Opens the StellarWalletsKit modal */
  connect: () => Promise<void>;
  disconnect: () => void;
}

// Context

const WalletContext = createContext<WalletContextValue | null>(null);

// Helper

function truncateAddress(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// Provider

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const kitRef = useRef<StellarWalletsKit | null>(null);

  const [address, setAddress] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialise the kit once — only on the client
  useEffect(() => {
    kitRef.current = new StellarWalletsKit({
      network: WalletNetwork.TESTNET,
      selectedWalletId: FREIGHTER_ID,
      modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
    });
  }, []);

  const connect = useCallback(async () => {
    const kit = kitRef.current;
    if (!kit) return;

    setError(null);
    setIsConnecting(true);

    try {
      await kit.openModal({
        onWalletSelected: async (option: ISupportedWallet) => {
          try {
            kit.setWallet(option.id);
            const { address: rawAddress } = await kit.getAddress();
            setAddress(truncateAddress(rawAddress));
            setPublicKey(rawAddress);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Failed to get address";
            setError(msg);
          }
        },
      });
    } catch (err) {
      // User closed modal or wallet not installed
      const msg =
        err instanceof Error ? err.message : "Wallet connection cancelled";
      setError(msg);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setPublicKey(null);
    setError(null);
  }, []);

  return (
    <WalletContext.Provider
      value={{
        address,
        publicKey,
        isConnected: !!address,
        isConnecting,
        error,
        connect,
        disconnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

//Hook

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside <WalletProvider>");
  }
  return ctx;
}
