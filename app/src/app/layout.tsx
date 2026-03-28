import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { NavBar } from "../components/NavBar";
import { GovernorNotificationsProvider } from "../components/GovernorNotificationsProvider";
import { WalletProvider } from "../lib/wallet-context";
import { Toaster } from "react-hot-toast";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NebGov — Governance for Stellar",
  description:
    "Permissionless on-chain governance for every Soroban protocol. Create proposals, vote, and execute decisions on-chain.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `;(function(){try{var theme=localStorage.getItem('theme');if(theme==='dark'){document.documentElement.classList.add('dark');return;}if(!theme&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body className={`${inter.className} bg-gray-50 dark:bg-gray-900 min-h-screen`}>
        <WalletProvider>
          <GovernorNotificationsProvider>
            <Toaster position="bottom-right" />
            <NavBar />
            <main className="pt-16">{children}</main>
          </GovernorNotificationsProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
