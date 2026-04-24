"use client";

/**
 * Create proposal page with simulation support.
 * TODO issue #44: add calldata encoder for on-chain execution targets.
 * Four-step proposal wizard: basics → actions (optional) → review → success.
 * Updated with SHA-256 hashing and metadata URI support.
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { ChevronDown, ChevronUp, Share2, Loader2, Hash, Link as LinkIcon, FileText, AlertCircle } from "lucide-react";
import { GovernorClient, VotesClient, hashDescription, type Network } from "@nebgov/sdk";
import {
  calldataArgRowToScVal,
  encodeGovernorCalldataBytes,
  newArgRow,
  type CalldataArgRow,
} from "../../lib/treasury-calldata";
import { useWallet } from "../../lib/wallet-context";

interface ProposalAction {
  target: string;
  function: string;
  args: any[];
}

interface SimulationResult {
  success: boolean;
  computeUnits?: number;
  stateChanges?: any[];
  error?: string;
}

export default function ProposePage() {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("");
  const [functionName, setFunctionName] = useState("");
  const [args, setArgs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parseArgs = (argsString: string): any[] => {
    if (!argsString.trim()) return [];
    try {
      return JSON.parse(argsString);
    } catch {
      return argsString.split(',').map(arg => arg.trim());
    }
  };

  const getErrorMessage = (error: string): string => {
    if (error.includes("insufficient fee")) {
      return "Transaction fee is too low. Please increase the fee.";
    }
    if (error.includes("invalid address")) {
      return "Invalid contract address provided.";
    }
    if (error.includes("no such function")) {
      return "The specified function doesn't exist on the target contract.";
    }
    if (error.includes("invalid args")) {
      return "The function arguments are invalid or malformed.";
    }
    return error;
  };

  async function handleSimulation(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !target.trim() || !functionName.trim()) return;

    setSimulating(true);
    setSimulationResult(null);
    setError(null);

    try {
      const actions: ProposalAction[] = [{
        target: target.trim(),
        function: functionName.trim(),
        args: parseArgs(args)
      }];

      // TODO: Replace with actual GovernorClient.simulateProposal call
      console.log("Simulating proposal:", { description, actions });
      
      // Mock simulation result for now
      await new Promise((r) => setTimeout(r, 1000));
      
      const mockResult: SimulationResult = {
        success: true,
        computeUnits: 125000,
        stateChanges: []
      };
      
      setSimulationResult(mockResult);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setSimulationResult({
        success: false,
        error: getErrorMessage(errorMessage)
      });
    } finally {
      setSimulating(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !target.trim() || !functionName.trim()) return;

    // Check if simulation was successful
    if (!simulationResult?.success) {
      setError("Please run and pass simulation before submitting the proposal.");
      return;
    }

  useEffect(() => {
    if (!hydrated) return;
    saveDraft(draft);
  }, [draft, hydrated]);

  // Auto-hash description when it changes
  useEffect(() => {
    if (!draft.description.trim()) return;

    const timer = setTimeout(async () => {
      setIsHashing(true);
      try {
        const hash = await hashDescription(draft.description);
        setDraft(d => ({ ...d, descriptionHash: hash }));
      } catch (err) {
        console.error("Hashing failed:", err);
      } finally {
        setIsHashing(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [draft.description]);

  useEffect(() => {
    if (step === 4 && !successIdParam) {
      router.replace("/propose?step=3");
    }
  }, [step, successIdParam, router]);

  const setStep = useCallback(
    (n: number) => {
      const q = new URLSearchParams(searchParams.toString());
      q.set("step", String(n));
      if (n !== 4) q.delete("id");
      router.push(`/propose?${q.toString()}`);
    },
    [router, searchParams],
  );

  function validateStep1(): string[] {
    const err: string[] = [];
    const t = draft.title.trim();
    if (t.length < TITLE_MIN || t.length > TITLE_MAX) {
      err.push(`Title must be ${TITLE_MIN}–${TITLE_MAX} characters.`);
    }
    if (draft.description.trim().length < DESC_MIN) {
      err.push(`Description must be at least ${DESC_MIN} characters.`);
    }
    if (!isReasonableIpfsRef(draft.ipfsRef)) {
      err.push(
        "IPFS reference must be a gateway URL, ipfs:// link, or raw CID.",
      );
    }
    if (!draft.descriptionHash && draft.description.trim()) {
      err.push("Waiting for description hash computation...");
    }
    return err;
  }

  function validateStep2(): string[] {
    const err: string[] = [];
    for (const a of draft.actions) {
      if (!a.target.trim() || !a.fnName.trim()) {
        err.push("Each action needs a target and function name.");
        break;
      }
      const hasArgs = a.args.some((r) => r.value.trim() !== "");
      if (hasArgs && a.simulateOk !== true) {
        err.push("Simulate every action that has arguments before continuing.");
        break;
      }
    }
    return err;
  }

  function goNext() {
    setStepErrors([]);
    if (step === 1) {
      const e = validateStep1();
      if (e.length) {
        setStepErrors(e);
        return;
      }
    }
    if (step === 2) {
      const e = validateStep2();
      if (e.length) {
        setStepErrors(e);
        return;
      }
    }
    if (step === 3) {
      if (!isConnected || !publicKey) {
        setStepErrors(["Connect your wallet to submit."]);
        return;
      }
      if (votes === null || threshold === null) {
        setStepErrors(["Still loading voting power. Try again in a moment."]);
        return;
      }
      if (votes < threshold) {
        setStepErrors([
          `Voting power is below the proposal threshold (${threshold.toString()} required).`,
        ]);
        return;
      }
      void submitProposal();
      return;
    }
    setStep(step + 1);
  }

  async function submitProposal() {
    if (!clients || !publicKey) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // TODO issue #44: call GovernorClient.propose() with connected wallet.
      // Placeholder — replace with real submission.
      console.log("Submitting proposal:", { description, target, functionName, args });
      await new Promise((r) => setTimeout(r, 1500));
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      const description = buildDescription(
        draft.title,
        draft.description,
        draft.ipfsRef,
      );
      const { targets, fnNames, calldatas } = buildPayload(
        draft.actions,
        clients.governorAddress,
      );
      const id = await clients.governor.proposeWithSign(
        publicKey,
        description,
        draft.descriptionHash,
        draft.ipfsRef, // Metadata URI
        targets,
        fnNames,
        calldatas,
        signTransaction,
      );
      sessionStorage.removeItem(STORAGE_KEY);
      setDraft({ title: "", description: "", descriptionHash: "", ipfsRef: "", actions: [] });
      router.push(`/propose?step=4&id=${id.toString()}`);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function runReviewLoads() {
    if (!clients || !publicKey) return;
    setEstimate(null);
    setEstimateErr(null);
    const [v, t] = await Promise.all([
      clients.votes.getVotes(publicKey),
      clients.governor.proposalThreshold(),
    ]);
    setVotes(v);
    setThreshold(t);

    const description = buildDescription(
      draft.title,
      draft.description,
      draft.ipfsRef,
    );
    const { targets, fnNames, calldatas } = buildPayload(
      draft.actions,
      clients.governorAddress,
    );
    const est = await clients.governor.estimateProposeResources(
      publicKey,
      description,
      draft.descriptionHash,
      draft.ipfsRef,
      targets,
      fnNames,
      calldatas,
    );
    if (!est.ok) {
      setEstimateErr(est.error ?? "Could not estimate proposal cost.");
      return;
    }
    setEstimate({ cpuInsns: est.cpuInsns, memBytes: est.memBytes });
  }

  useEffect(() => {
    if (step !== 3 || !clients || !publicKey) return;
    void runReviewLoads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    step,
    publicKey,
    clients?.governorAddress,
    draft.title,
    draft.description,
    draft.descriptionHash,
    draft.ipfsRef,
    draft.actions,
  ]);

  async function simulateAction(act: WizardAction) {
    if (!clients || !publicKey) return;
    setSimBusy(act.id);
    try {
      const args = act.args
        .filter((r) => r.value.trim())
        .map(calldataArgRowToScVal);
      const res = await clients.governor.simulateTargetInvocation(
        publicKey,
        act.target.trim(),
        act.fnName.trim(),
        args,
      );
      setDraft((d) => ({
        ...d,
        actions: d.actions.map((x) =>
          x.id === act.id
            ? {
              ...x,
              simulateOk: res.ok,
              simulateError: res.ok ? undefined : res.error,
            }
            : x,
        ),
      }));
    } catch (e: unknown) {
      setDraft((d) => ({
        ...d,
        actions: d.actions.map((x) =>
          x.id === act.id
            ? {
              ...x,
              simulateOk: false,
              simulateError:
                e instanceof Error ? e.message : "Simulation failed",
            }
            : x,
        ),
      }));
    } finally {
      setSimBusy(null);
    }
  }

  if (!clients) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
          Set <span className="font-mono">NEXT_PUBLIC_GOVERNOR_ADDRESS</span>,{" "}
          <span className="font-mono">NEXT_PUBLIC_TIMELOCK_ADDRESS</span>, and{" "}
          <span className="font-mono">NEXT_PUBLIC_VOTES_ADDRESS</span> in{" "}
          <span className="font-mono">.env.local</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">New proposal</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Step-by-step flow with validation, previews, and on-chain simulation.
      </p>

      {/* Progress */}
      <ol className="flex items-center gap-2 mb-10 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2 flex-1 min-w-0">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-semibold ${step >= s.id
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                }`}
            >
              {s.id}
            </span>
            <span
              className={`truncate hidden sm:inline ${step === s.id ? "font-semibold text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
                }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="h-px flex-1 bg-gray-200 min-w-[12px] hidden md:block" />
            )}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Title ({TITLE_MIN}–{TITLE_MAX} characters)
            </label>
            <input
              type="text"
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500"
              placeholder="Short, specific title"
              maxLength={TITLE_MAX + 5}
            />
            <p className="text-xs text-gray-400 mt-1">
              {draft.title.trim().length} / {TITLE_MAX} (min {TITLE_MIN})
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description (Markdown, min {DESC_MIN} chars)
              </label>
              <textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                rows={12}
                className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white font-mono focus:ring-2 focus:ring-indigo-500"
                placeholder="Full proposal narrative: context, options, risks…"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 flex items-center justify-between">
                Preview
                {isHashing && (
                  <span className="text-[10px] text-indigo-600 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Hashing...
                  </span>
                )}
              </label>
              <div className="min-h-[18rem] border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50/80 dark:bg-gray-900/50 text-sm text-gray-800 dark:text-gray-200 overflow-auto prose-p:my-2 prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-headings:font-semibold prose-a:text-indigo-600 dark:prose-invert">
                {draft.description.trim() ? (
                  <ReactMarkdown>{draft.description}</ReactMarkdown>
                ) : (
                  <span className="text-gray-400 dark:text-gray-500">Nothing to preview yet.</span>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Metadata Uri / IPFS Attachment
            </label>
            <input
              type="text"
              value={draft.ipfsRef}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ipfsRef: e.target.value }))
              }
              placeholder="ipfs://… or https://…"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 font-mono"
            />
            <p className="text-xs text-gray-400 mt-1">
              Points to the full proposal metadata. The description above will be hashed and stored on-chain.
            </p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            Optional on-chain actions after the vote passes. Leave empty to submit a
            governance-only signal (uses a safe <span className="font-mono">proposal_count</span>{" "}
            placeholder on the governor).
          </p>
          <button
            type="button"
            onClick={() =>
              setDraft((d) => ({ ...d, actions: [...d.actions, newAction()] }))
            }
            className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
          >
            + Add action
          </button>

          <ul className="space-y-4">
            {draft.actions.map((act, idx) => (
              <li
                key={act.id}
                className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white dark:bg-gray-800 space-y-3"
              >
                <div className="flex justify-between items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    Action {idx + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={idx === 0}
                      onClick={() =>
                        setDraft((d) => {
                          const a = [...d.actions];
                          [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]];
                          return { ...d, actions: a };
                        })
                      }
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={idx === draft.actions.length - 1}
                      onClick={() =>
                        setDraft((d) => {
                          const a = [...d.actions];
                          [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]];
                          return { ...d, actions: a };
                        })
                      }
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.filter((x) => x.id !== act.id),
                        }))
                      }
                      className="text-xs text-red-600 hover:text-red-800 ml-2"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500">Target (C… / G…)</label>
                    <input
                      value={act.target}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.map((x) =>
                            x.id === act.id ? { ...x, target: v, simulateOk: null } : x,
                          ),
                        }));
                      }}
                      className="w-full mt-0.5 border rounded-lg px-2 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Function name</label>
                    <input
                      value={act.fnName}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.map((x) =>
                            x.id === act.id ? { ...x, fnName: v, simulateOk: null } : x,
                          ),
                        }));
                      }}
                      className="w-full mt-0.5 border rounded-lg px-2 py-1.5 text-sm font-mono"
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">Arguments</span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          actions: d.actions.map((x) =>
                            x.id === act.id
                              ? { ...x, args: [...x.args, newArgRow()], simulateOk: null }
                              : x,
                          ),
                        }))
                      }
                      className="text-xs text-indigo-600"
                    >
                      + Arg
                    </button>
                  </div>
                  {act.args.map((row) => (
                    <div key={row.id} className="flex flex-wrap gap-2 mb-2">
                      <select
                        value={row.kind}
                        onChange={(e) => {
                          const kind = e.target.value as CalldataArgRow["kind"];
                          setDraft((d) => ({
                            ...d,
                            actions: d.actions.map((x) =>
                              x.id === act.id
                                ? {
                                  ...x,
                                  args: x.args.map((r) =>
                                    r.id === row.id ? { ...r, kind } : r,
                                  ),
                                  simulateOk: null,
                                }
                                : x,
                            ),
                          }));
                        }}
                        className="bg-gray-50 border rounded text-xs px-1 py-1"
                      >
                        <option value="address">Address</option>
                        <option value="string">String</option>
                        <option value="u64">u64</option>
                        <option value="i128">i128</option>
                        <option value="bool">Bool</option>
                      </select>
                      <input
                        value={row.value}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDraft((d) => ({
                            ...d,
                            actions: d.actions.map((x) =>
                              x.id === act.id
                                ? {
                                  ...x,
                                  args: x.args.map((r) =>
                                    r.id === row.id ? { ...r, value: v } : r,
                                  ),
                                  simulateOk: null,
                                }
                                : x,
                            ),
                          }));
                        }}
                        placeholder="Value"
                        className="flex-1 min-w-[120px] border border-gray-200 rounded px-2 py-1 text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            actions: d.actions.map((x) =>
                              x.id === act.id
                                ? {
                                  ...x,
                                  args: x.args.filter((r) => r.id !== row.id),
                                  simulateOk: null,
                                }
                                : x,
                            ),
                          }))
                        }
                        className="text-gray-400 hover:text-red-500"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="pt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={!act.target.trim() || !act.fnName.trim() || simBusy === act.id}
                    onClick={() => simulateAction(act)}
                    className="text-xs bg-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                  >
                    {simBusy === act.id ? "Simulating..." : "Simulate action"}
                  </button>
                  {act.simulateOk === true && (
                    <span className="text-xs text-green-600 font-medium">✓ Ready</span>
                  )}
                  {act.simulateOk === false && (
                    <span className="text-xs text-red-600 font-medium">
                      {act.simulateError ? `Error: ${act.simulateError}` : "Simulation failed"}
                    </span>
                  )}
                </div>
                {act.args.length > 0 && act.args.some((r) => r.value.trim() !== "") && (
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <p className="text-xs text-gray-500 mb-1">Encoded calldata (hex)</p>
                    <pre className="text-xs font-mono bg-gray-50 rounded-lg p-2 overflow-x-auto text-gray-700 break-all">
                      {getActionCalldataHex(act.args)}
                    </pre>
                    <p className="text-xs text-gray-400 mt-1">
                      {act.args.filter((r) => r.value.trim() !== "").length} argument(s) encoded as XDR
                    </p>
                  </div>
                )}              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-8">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
              Review Content
            </h2>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">Title</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white">{draft.title}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">Description Hash (SHA-256)</p>
                <p className="text-sm font-mono text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 px-2 py-1 rounded">
                  {draft.descriptionHash || "Computing..."}
                </p>
              </div>
              <div className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900/50 p-4 rounded-xl dark:prose-invert">
                <ReactMarkdown>{draft.description}</ReactMarkdown>
              </div>
              {draft.ipfsRef && (
                <div className="flex items-center gap-2 text-xs text-indigo-600">
                  <LinkIcon className="w-3 h-3" />
                  <span className="font-medium">Metadata URI:</span>
                  <span className="font-mono">{draft.ipfsRef}</span>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
              On-chain actions
            </h2>
            {draft.actions.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No on-chain actions (signal only).</p>
            ) : (
              <ul className="space-y-4">
                {draft.actions.map((act, i) => (
                  <li key={i} className="text-sm font-mono bg-gray-50 dark:bg-gray-900 p-3 rounded-lg border border-gray-100 dark:border-gray-700">
                    <div className="text-indigo-600 dark:text-indigo-400 mb-1">{act.target}</div>
                    <div className="text-gray-900 dark:text-gray-200">{act.fnName}({act.args.map(a => a.value).join(', ')})</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-6">
              Submission check
            </h2>
            <div className="space-y-6">
              {!isConnected ? (
                <div className="flex items-center gap-2 text-amber-700 bg-amber-50 p-4 rounded-xl text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  Please connect your wallet to verify permissions.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">Your Votes</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {votes === null ? "..." : (Number(votes) / 10 ** 7).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase mb-1">Threshold</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {threshold === null ? "..." : (Number(threshold) / 10 ** 7).toLocaleString()}
                    </p>
                  </div>
                </div>
              )}

              {estimate && (
                <div className="border-t border-gray-100 pt-6">
                  <p className="text-xs text-gray-400 font-medium uppercase mb-3">Resource Estimate</p>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <span className="text-gray-500 mr-2">CPU:</span>
                      <span className="font-mono font-medium">{Number(estimate.cpuInsns).toLocaleString()} cycles</span>
                    </div>
                    <div>
                      <span className="text-gray-500 mr-2">RAM:</span>
                      <span className="font-mono font-medium">{(Number(estimate.memBytes) / 1024).toFixed(1)} KB</span>
                    </div>
                  </div>
                </div>
              )}

              {estimateErr && (
                <div className="p-3 bg-red-50 text-red-600 text-xs rounded-lg border border-red-100">
                  Simulation Warning: {estimateErr}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

        <div>
          <label
            htmlFor="target"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Target Contract Address
          </label>
          <input
            id="target"
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            required
          />
        </div>

        <div>
          <label
            htmlFor="function"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Function Name
          </label>
          <input
            id="function"
            type="text"
            value={functionName}
            onChange={(e) => setFunctionName(e.target.value)}
            placeholder="transfer"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            required
          />
        </div>

        <div>
          <label
            htmlFor="args"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Function Arguments (JSON or comma-separated)
          </label>
          <textarea
            id="args"
            rows={3}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder='["recipient_address", 1000] or recipient_address, 1000'
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Simulation Results */}
        {simulationResult && (
          <div className={`rounded-lg p-4 ${simulationResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
            <h3 className={`font-medium mb-2 ${simulationResult.success ? 'text-green-800' : 'text-red-800'}`}>
              Simulation {simulationResult.success ? 'Passed' : 'Failed'}
            </h3>
            {simulationResult.success ? (
              <div className="text-sm text-green-700">
                <p>Compute units required: {simulationResult.computeUnits?.toLocaleString()}</p>
                <p className="mt-1">✓ Proposal execution should succeed</p>
              </div>
            ) : (
              <div className="text-sm text-red-700">
                <p>{simulationResult.error}</p>
                <p className="mt-1">✗ Please fix the issues before submitting</p>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-4">
          <button
            type="button"
            onClick={handleSimulation}
            disabled={simulating || !description.trim() || !target.trim() || !functionName.trim()}
            className="flex-1 bg-gray-600 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {simulating ? "Simulating..." : "Run Simulation"}
          </button>

          <button
            type="submit"
            disabled={submitting || !description.trim() || !target.trim() || !functionName.trim() || !simulationResult?.success}
            className="flex-1 bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Submitting..." : "Submit Proposal"}
          </button>
      {step === 4 && successIdParam && (
        <div className="text-center space-y-4 py-6">
          <p className="text-green-800 font-semibold text-lg">Proposal created</p>
          <p className="text-3xl font-mono font-bold text-gray-900">#{successIdParam}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href={`/proposal/${successIdParam}`}
              className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              View Proposal
            </Link>
            <button
              onClick={() => router.push("/")}
              className="text-gray-600 px-6 py-2 rounded-lg font-medium hover:bg-gray-100 transition-colors"
            >
              Back to list
            </button>
          </div>
        </div>
      )}

        {error && (
          <p className="text-red-600 text-sm">{error}</p>
        )}

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
          <strong>Simulation Required:</strong> Run simulation before submission to verify your proposal will execute successfully.
        </div>
      </form>
      {stepErrors.length > 0 && (
        <ul className="mt-6 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 list-disc list-inside">
          {stepErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {step < 4 && (
        <div className="mt-12 flex items-center justify-between pt-6 border-t border-gray-200">
          <button
            onClick={() => step > 1 && setStep(step - 1)}
            disabled={step === 1 || submitting}
            className="text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-30"
          >
            Back
          </button>

          <div className="flex items-center gap-3">
            {stepErrors.length > 0 && (
              <span className="text-xs text-red-600 font-medium">
                {stepErrors[0]}
              </span>
            )}
            <button
              onClick={goNext}
              disabled={submitting || (step === 3 && !reviewDataReady)}
              className="bg-indigo-600 text-white px-8 py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors min-w-[120px]"
            >
              {submitting ? "Submitting..." : step === 3 ? "Submit Proposal" : "Continue"}
            </button>
          </div>
        </div>
      )}

      {submitError && (
        <div className="mt-6 p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm">
          {submitError}
        </div>
      )}
    </div>
  );
}

export default function ProposeWizard() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-500">Loading wizard...</div>}>
      <ProposeWizardInner />
    </Suspense>
  );
}
