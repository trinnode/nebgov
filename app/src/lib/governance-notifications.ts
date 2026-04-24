/**
 * Browser notification preferences and on-device event history (localStorage).
 */

import { backendFetch, getAuthToken } from "./backend";

export const LS_NOTIFY_TOGGLES = "nebgov-notify-toggles";
export const LS_NOTIFY_HISTORY = "nebgov-notify-history";
export const LS_PROPOSAL_META = "nebgov-proposal-meta";

/** Keys match the six user-facing toggle groups in the UI. */
export type NotificationToggleKey =
  | "created_self"
  | "active"
  | "voting_ends_soon"
  | "outcome"
  | "queued"
  | "executed";

export type NotificationToggles = Record<NotificationToggleKey, boolean>;

export const DEFAULT_NOTIFICATION_TOGGLES: NotificationToggles = {
  created_self: true,
  active: true,
  voting_ends_soon: true,
  outcome: true,
  queued: true,
  executed: true,
};

export type NotificationEventKind =
  | NotificationToggleKey
  | "passed"
  | "failed";

export type NotificationHistoryEntry = {
  id: string;
  kind: NotificationEventKind;
  proposalId: string;
  title: string;
  body: string;
  at: number;
  ledger?: number;
  read?: boolean;
};

const MAX_HISTORY = 200;

export function loadNotificationToggles(): NotificationToggles {
  if (typeof window === "undefined") return { ...DEFAULT_NOTIFICATION_TOGGLES };
  try {
    const raw = localStorage.getItem(LS_NOTIFY_TOGGLES);
    if (!raw) return { ...DEFAULT_NOTIFICATION_TOGGLES };
    const parsed = JSON.parse(raw) as Partial<NotificationToggles>;
    return { ...DEFAULT_NOTIFICATION_TOGGLES, ...parsed };
  } catch {
    return { ...DEFAULT_NOTIFICATION_TOGGLES };
  }
}

export function saveNotificationToggles(t: NotificationToggles): void {
  localStorage.setItem(LS_NOTIFY_TOGGLES, JSON.stringify(t));
  window.dispatchEvent(new Event("nebgov-notify-toggles"));

  const token = getAuthToken();
  if (!token) return;
  void backendFetch<NotificationToggles>("/notifications/preferences", {
    method: "POST",
    auth: true,
    body: JSON.stringify(t),
  }).catch(() => {
    /* best-effort */
  });
}

export function loadNotificationHistory(): NotificationHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_NOTIFY_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as NotificationHistoryEntry[];
    return parsed.map((e) => ({ ...e, read: e.read ?? false }));
  } catch {
    return [];
  }
}

export function appendNotificationHistory(
  entry: Omit<NotificationHistoryEntry, "id" | "at"> & { at?: number }
): void {
  const row: NotificationHistoryEntry = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    at: entry.at ?? Date.now(),
    kind: entry.kind,
    proposalId: entry.proposalId,
    title: entry.title,
    body: entry.body,
    ledger: entry.ledger,
    read: false,
  };
  const prev = loadNotificationHistory();
  const next = [row, ...prev].slice(0, MAX_HISTORY);
  localStorage.setItem(LS_NOTIFY_HISTORY, JSON.stringify(next));
  window.dispatchEvent(new Event("nebgov-notify-history"));

  const token = getAuthToken();
  if (!token) return;
  void backendFetch("/notifications", {
    method: "POST",
    auth: true,
    body: JSON.stringify({
      type: row.kind,
      proposal_id: Number.isFinite(Number(row.proposalId))
        ? Number(row.proposalId)
        : undefined,
      message: `${row.title}\n\n${row.body}`,
    }),
  }).catch(() => {
    /* best-effort */
  });
}

export function unreadCount(): number {
  return loadNotificationHistory().filter((e) => !e.read).length;
}

export async function syncNotificationsFromBackend(): Promise<void> {
  const token = getAuthToken();
  if (!token) return;

  const [prefs, history] = await Promise.all([
    backendFetch<NotificationToggles>("/notifications/preferences", {
      method: "GET",
      auth: true,
    }),
    backendFetch<{
      data: {
        id: number;
        type: string;
        proposal_id: number | null;
        message: string | null;
        read: boolean;
        created_at: string;
      }[];
    }>("/notifications?limit=200&offset=0", { method: "GET", auth: true }),
  ]);

  localStorage.setItem(LS_NOTIFY_TOGGLES, JSON.stringify(prefs));
  window.dispatchEvent(new Event("nebgov-notify-toggles"));

  const mapped: NotificationHistoryEntry[] = history.data.map((r) => {
    const msg = r.message ?? "";
    const [title, ...rest] = msg.split("\n\n");
    return {
      id: String(r.id),
      kind: (r.type as NotificationEventKind) ?? "active",
      proposalId: r.proposal_id != null ? String(r.proposal_id) : "0",
      title: title || r.type,
      body: rest.join("\n\n") || "",
      at: new Date(r.created_at).getTime(),
      read: r.read,
    };
  });

  localStorage.setItem(LS_NOTIFY_HISTORY, JSON.stringify(mapped));
  window.dispatchEvent(new Event("nebgov-notify-history"));
}

export function markAllNotificationsRead(): void {
  const prev = loadNotificationHistory();
  if (prev.length === 0) return;
  const next = prev.map((e) => ({ ...e, read: true }));
  localStorage.setItem(LS_NOTIFY_HISTORY, JSON.stringify(next));
  window.dispatchEvent(new Event("nebgov-notify-history"));

  const token = getAuthToken();
  if (!token) return;
  void backendFetch("/notifications/mark-read", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ all: true }),
  }).catch(() => {
    /* best-effort */
  });
}

export type ProposalMeta = {
  endLedger: number;
  startLedger: number;
  proposer: string;
};

export function loadProposalMeta(): Record<string, ProposalMeta> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_PROPOSAL_META);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ProposalMeta>;
  } catch {
    return {};
  }
}

export function saveProposalMeta(meta: Record<string, ProposalMeta>): void {
  localStorage.setItem(LS_PROPOSAL_META, JSON.stringify(meta));
}

export function mergeProposalMetaEntry(
  proposalId: bigint,
  patch: ProposalMeta
): void {
  const all = loadProposalMeta();
  all[proposalId.toString()] = patch;
  saveProposalMeta(all);
}
