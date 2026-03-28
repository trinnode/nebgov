"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "../lib/wallet-context";
import {
  Menu,
  X,
  ChevronDown,
  Copy,
  User,
  LogOut,
  LayoutDashboard,
  Users,
  BarChart3,
  Wallet2,
  Sun,
  Moon,
} from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import toast from "react-hot-toast";

const NAV_LINKS = [
  { name: "Proposals", href: "/", icon: LayoutDashboard },
  { name: "Notifications", href: "/notifications", icon: Bell },
  { name: "Delegates", href: "/delegates", icon: Users },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
  { name: "Treasury", href: "/treasury", icon: Wallet2 },
];

export function NavBar() {
  const pathname = usePathname();
  const { address, publicKey, isConnected, isConnecting, connect, disconnect } =
    useWallet();

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    setIsMenuOpen(false);
    setIsWalletMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = isMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMenuOpen]);

  useEffect(() => {
    if (!isWalletMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsWalletMenuOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isWalletMenuOpen]);

  const copyAddress = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      toast.success("Address copied!", {
        style: { borderRadius: "10px", background: "#1e1b4b", color: "#fff" },
        iconTheme: { primary: "#818cf8", secondary: "#fff" },
      });
    } catch {
      toast.error("Failed to copy address.");
    } finally {
      setIsWalletMenuOpen(false);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setIsWalletMenuOpen(false);
    setIsMenuOpen(false);
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 bg-white border-b z-50 h-16 transition-all duration-200 ${
        scrolled ? "shadow-sm border-gray-200" : "border-gray-100"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between">
        <div className="flex items-center gap-10">
          <Link
            href="/"
            className="flex items-center gap-2 group"
            aria-label="NebGov home"
          >
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold transform group-hover:rotate-6 transition-transform select-none">
              N
            </div>
            <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-gray-900 to-gray-600 mr-4">
              NebGov
            </span>
          </Link>

          <div
            className="hidden md:flex items-center gap-1"
            role="navigation"
            aria-label="Main"
          >
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.name}
                  href={link.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    isActive
                      ? "text-indigo-600 bg-indigo-50"
                      : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
                  }`}
                >
                  {link.name}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="p-2 rounded-xl text-gray-600 hover:bg-gray-100 transition-colors"
          >
            {theme === "dark" ? (
              <Sun className="w-5 h-5" aria-hidden />
            ) : (
              <Moon className="w-5 h-5" aria-hidden />
            )}
          </button>
          <div className="hidden md:block relative">
            {isConnected ? (
              <div className="relative" ref={drawerRef}>
                <button
                  onClick={() => setIsWalletMenuOpen((v) => !v)}
                  aria-expanded={isWalletMenuOpen}
                  aria-haspopup="menu"
                  className="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all text-sm font-medium text-gray-700"
                >
                  <div
                    className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex-shrink-0"
                    aria-hidden
                  />
                  <span className="max-w-[9rem] truncate">{address}</span>
                  <ChevronDown
                    className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
                      isWalletMenuOpen ? "rotate-180" : ""
                    }`}
                    aria-hidden
                  />
                </button>

                {isWalletMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-[199] pointer-events-auto"
                      onClick={() => setIsWalletMenuOpen(false)}
                      aria-hidden
                    />

                    <div
                      role="menu"
                      className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-[200] overflow-hidden"
                    >
                      <div className="px-4 py-3 border-b border-gray-50 mb-1">
                        <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">
                          Active Wallet
                        </p>
                        <p
                          className="text-sm font-mono text-gray-600 truncate"
                          title={publicKey ?? ""}
                        >
                          {publicKey}
                        </p>
                      </div>

                      <button
                        role="menuitem"
                        onClick={copyAddress}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        <Copy className="w-4 h-4" aria-hidden />
                        Copy address
                      </button>

                      <Link
                        role="menuitem"
                        href={`/profile?address=${publicKey}`}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        <User className="w-4 h-4" aria-hidden />
                        My Profile
                      </Link>

                      <div className="h-px bg-gray-100 my-1" aria-hidden />

                      <button
                        role="menuitem"
                        onClick={handleDisconnect}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <LogOut className="w-4 h-4" aria-hidden />
                        Disconnect
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                onClick={connect}
                disabled={isConnecting}
                className="text-sm px-6 py-2.5 rounded-full font-semibold transition-all shadow-md shadow-indigo-100 hover:shadow-lg hover:shadow-indigo-200 active:scale-95 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isConnecting ? "Connecting…" : "Connect Wallet"}
              </button>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setIsMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={isMenuOpen}
            className="md:hidden p-2 rounded-xl text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <Menu className="w-6 h-6" aria-hidden />
          </button>
        </div>
      </div>

      {/* ── Mobile Drawer ── */}
      {isMenuOpen && (
        <div
          className="fixed inset-0 z-[100] md:hidden"
          role="dialog"
          aria-modal
          aria-label="Navigation menu"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
            onClick={() => setIsMenuOpen(false)}
            aria-hidden
          />

          <div className="absolute right-0 top-0 bottom-0 w-80 bg-white shadow-2xl flex flex-col">
            <div className="p-4 flex items-center justify-between border-b border-gray-100">
              <span className="text-lg font-bold text-gray-900">Menu</span>
              <button
                onClick={() => setIsMenuOpen(false)}
                aria-label="Close menu"
                className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <X className="w-6 h-6" aria-hidden />
              </button>
            </div>

            <nav
              className="flex-1 overflow-y-auto p-4 space-y-1"
              aria-label="Mobile navigation"
            >
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest px-2 mb-3">
                Navigation
              </p>
              {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href;
                const LinkIcon = link.icon;
                return (
                  <Link
                    key={link.name}
                    href={link.href}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex items-center gap-4 px-4 py-3.5 rounded-2xl text-base font-medium transition-all ${
                      isActive
                        ? "text-indigo-600 bg-indigo-50"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <LinkIcon
                      className={`w-5 h-5 flex-shrink-0 ${isActive ? "text-indigo-600" : "text-gray-400"}`}
                      aria-hidden
                    />
                    {link.name}
                  </Link>
                );
              })}

              {isConnected && (
                <Link
                  href={`/profile?address=${publicKey}`}
                  aria-current={pathname === "/profile" ? "page" : undefined}
                  className={`flex items-center gap-4 px-4 py-3.5 rounded-2xl text-base font-medium transition-all ${
                    pathname === "/profile"
                      ? "text-indigo-600 bg-indigo-50"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <User
                    className={`w-5 h-5 flex-shrink-0 ${pathname === "/profile" ? "text-indigo-600" : "text-gray-400"}`}
                    aria-hidden
                  />
                  My Profile
                </Link>
              )}
            </nav>

            {isMenuOpen && (
              <div
                className="fixed inset-0 z-[100] md:hidden"
                role="dialog"
                aria-modal
                aria-label="Navigation menu"
              >
                {/* Backdrop */}
                <div
                  className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
                  onClick={() => setIsMenuOpen(false)}
                  aria-hidden
                />

                <div className="absolute inset-0 bg-white shadow-2xl flex flex-col">
                  <div className="p-4 flex items-center justify-between border-b border-gray-100">
                    <span className="text-lg font-bold text-gray-900">
                      Menu
                    </span>
                    <button
                      onClick={() => setIsMenuOpen(false)}
                      className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <X className="w-6 h-6" aria-hidden />
                    </button>
                  </div>

                  {/* Nav links */}
                  <nav
                    className="flex-1 overflow-y-auto p-4 space-y-1"
                    aria-label="Mobile navigation"
                  >
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest px-2 mb-4">
                      Navigation
                    </p>

                    {NAV_LINKS.map((link) => {
                      const isActive = pathname === link.href;
                      const LinkIcon = link.icon;
                      return (
                        <Link
                          key={link.name}
                          href={link.href}
                          aria-current={isActive ? "page" : undefined}
                          className={`flex items-center gap-4 px-4 py-3.5 rounded-2xl text-base font-medium transition-all ${
                            isActive
                              ? "text-indigo-600 bg-indigo-50"
                              : "text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          <LinkIcon
                            className={`w-5 h-5 flex-shrink-0 ${isActive ? "text-indigo-600" : "text-gray-400"}`}
                            aria-hidden
                          />
                          {link.name}
                        </Link>
                      );
                    })}
                  </nav>

                  {/* Wallet Section - Simple "alice — Disconnect" style */}
                  <div className="p-4 border-t border-gray-100 bg-white mt-auto">
                    {isConnected ? (
                      <div className="flex items-center justify-between px-2 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-medium text-gray-900">
                            {address || "Connected"}
                          </span>
                          <button
                            onClick={copyAddress}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            aria-label="Copy Address"
                          >
                            <Copy className="w-4 h-4" aria-hidden />
                          </button>
                        </div>

                        <button
                          onClick={handleDisconnect}
                          className="text-red-600 hover:text-red-700 font-medium text-base transition-colors flex items-center gap-1.5"
                        >
                          Disconnect
                          <LogOut className="w-4 h-4" aria-hidden />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          connect();
                          setIsMenuOpen(false);
                        }}
                        className="w-full py-4 rounded-2xl bg-indigo-600 text-white font-semibold shadow-md hover:bg-indigo-700 transition-all"
                      >
                        Connect Wallet
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
