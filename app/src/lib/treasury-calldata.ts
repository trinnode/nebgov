import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export type CalldataArgKind = "address" | "i128" | "u64" | "string" | "bool";

export type CalldataArgRow = {
  id: string;
  kind: CalldataArgKind;
  value: string;
};

export function newArgRow(): CalldataArgRow {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    kind: "address",
    value: "",
  };
}

export function calldataArgRowToScVal(row: CalldataArgRow): xdr.ScVal {
  const v = row.value.trim();
  switch (row.kind) {
    case "address":
      return nativeToScVal(v, { type: "address" });
    case "i128": {
      const n = BigInt(v || "0");
      return nativeToScVal(n, { type: "i128" });
    }
    case "u64": {
      const n = BigInt(v || "0");
      return nativeToScVal(n, { type: "u64" });
    }
    case "string":
      return nativeToScVal(v, { type: "string" });
    case "bool":
      return nativeToScVal(v === "true" || v === "1", { type: "bool" });
    default:
      return nativeToScVal(v, { type: "string" });
  }
}

/** Soroban-style payload: symbol + args, encoded as XDR of an ScVec (function name first). */
export function encodeCallableCalldata(
  functionName: string,
  rows: CalldataArgRow[]
): Uint8Array {
  const fn = functionName.trim();
  if (!fn) throw new Error("Function name is required.");

  const head = nativeToScVal(fn, { type: "symbol" });
  const tail = rows.filter((r) => r.value.trim() !== "").map(calldataArgRowToScVal);
  return Uint8Array.from(xdr.ScVal.scvVec([head, ...tail]).toXDR());
}

/** Governor `calldatas` entries: argument vector XDR only (function name is its own field). */
export function encodeGovernorCalldataBytes(rows: CalldataArgRow[]): Uint8Array {
  const vals = rows.filter((r) => r.value.trim() !== "").map(calldataArgRowToScVal);
  if (vals.length === 0) return new Uint8Array(0);
  return Uint8Array.from(xdr.ScVal.scvVec(vals).toXDR());
}

export function previewCalldata(
  target: string,
  functionName: string,
  rows: CalldataArgRow[]
): string {
  const t = target.trim() || "…";
  const f = functionName.trim() || "…";
  const parts = rows
    .filter((r) => r.value.trim() !== "")
    .map((r) => {
      const q = r.kind === "string" ? JSON.stringify(r.value.trim()) : r.value.trim();
      return q;
    });
  return `This will call ${f}(${parts.join(", ")}) on ${t}`;
}

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatNativeArg(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object" && v !== null && Symbol.iterator in (v as object)) {
    try {
      return `[${Array.from(v as Iterable<unknown>).map(formatNativeArg).join(", ")}]`;
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** One-line label for a pending treasury operation (for the list). */
export function labelPendingTx(target: string, dataHex: string): string {
  const clean = dataHex.trim().replace(/^0x/i, "");
  if (!clean || clean.length < 2) {
    return `Custom action · ${shortAddr(target)}`;
  }
  try {
    const buf = Buffer.from(clean, "hex");
    const sc = xdr.ScVal.fromXDR(buf);
    const nat = scValToNative(sc);
    if (Array.isArray(nat) && nat.length > 0) {
      const fn = String(nat[0]);
      const args = nat.slice(1).map(formatNativeArg);
      const human =
        fn === "transfer" && args.length >= 2
          ? `Transfer ${args[1]} to ${shortAddr(args[0])}` // (recipient, amount)
          : `${fn}(${args.join(", ")})`;
      return `${human} · ${shortAddr(target)}`;
    }
  } catch {
    /* fall through */
  }
  return `Custom calldata · ${shortAddr(target)}`;
}
