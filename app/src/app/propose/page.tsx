"use client";

/**
 * Create proposal page with simulation support.
 * TODO issue #44: add calldata encoder for on-chain execution targets.
 * Four-step proposal wizard: basics → actions (optional) → review → success.
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
import { ChevronDown, ChevronUp, Share2 } from "lucide-react";
import { GovernorClient, VotesClient, type Network } from "@nebgov/sdk";
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
        targets,
        fnNames,
        calldatas,
        signTransaction,
      );
      sessionStorage.removeItem(STORAGE_KEY);
      setDraft({ title: "", description: "", ipfsRef: "", actions: [] });
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

  const belowThreshold =
    votes !== null && threshold !== null && votes < threshold;

  const reviewDataReady =
    votes !== null && threshold !== null && !submitting;

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
      <h1 className="text-3xl font-bold text-gray-900 mb-2">New proposal</h1>
      <p className="text-gray-500 mb-8">
        Step-by-step flow with validation, previews, and on-chain simulation.
      </p>

      {/* Progress */}
      <ol className="flex items-center gap-2 mb-10 text-sm">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2 flex-1 min-w-0">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-semibold ${
                  step >= s.id
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-200 text-gray-500"
                }`}
              >
                {s.id}
              </span>
              <span
                className={`truncate hidden sm:inline ${
                  step === s.id ? "font-semibold text-gray-900" : "text-gray-500"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Title ({TITLE_MIN}–{TITLE_MAX} characters)
            </label>
            <input
              type="text"
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              placeholder="Short, specific title"
              maxLength={TITLE_MAX + 5}
            />
            <p className="text-xs text-gray-400 mt-1">
              {draft.title.trim().length} / {TITLE_MAX} (min {TITLE_MIN})
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description (Markdown, min {DESC_MIN} chars)
              </label>
              <textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                rows={12}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-indigo-500"
                placeholder="Full proposal narrative: context, options, risks…"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Preview
              </label>
              <div className="min-h-[18rem] border border-gray-200 rounded-lg p-3 bg-gray-50/80 text-sm text-gray-800 overflow-auto prose-p:my-2 prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-headings:font-semibold prose-a:text-indigo-600">
                {draft.description.trim() ? (
                  <ReactMarkdown>{draft.description}</ReactMarkdown>
                ) : (
                  <span className="text-gray-400">Nothing to preview yet.</span>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              IPFS attachment (optional)
            </label>
            <input
              type="text"
              value={draft.ipfsRef}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ipfsRef: e.target.value }))
              }
              placeholder="https://… , ipfs://… , or CID"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Pin content separately, then paste a gateway link or CID. Stored in the
              on-chain description.
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
                className="border border-gray-200 rounded-xl p-4 bg-white space-y-3"
              >
                <div className="flex justify-between items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800">
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
                        className="border rounded-md text-xs py-1"
                      >
                        <option value="address">address</option>
                        <option value="i128">i128</option>
                        <option value="u64">u64</option>
                        <option value="string">string</option>
                        <option value="bool">bool</option>
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
                        className="flex-1 min-w-[6rem] border rounded-md px-2 py-1 text-sm font-mono"
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
                        className="text-xs text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!act.target.trim() || !act.fnName.trim() || simBusy === act.id}
                    onClick={() => void simulateAction(act)}
                    className="text-sm px-3 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-50"
                  >
                    {simBusy === act.id ? "Simulating…" : "Simulate"}
                  </button>
                  {act.simulateOk === true && (
                    <span className="text-xs font-medium text-green-700">Simulation OK</span>
                  )}
                  {act.simulateOk === false && (
                    <span className="text-xs text-red-600">{act.simulateError}</span>
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
        <div className="space-y-6">
          <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/80 space-y-2 text-sm">
            <p className="font-semibold text-gray-900">{draft.title.trim()}</p>
            <div className="text-gray-700 whitespace-pre-wrap border-t border-gray-100 pt-2 max-h-48 overflow-auto">
              {buildDescription(draft.title, draft.description, draft.ipfsRef)}
            </div>
            <p className="text-xs text-gray-500">
              {draft.actions.length === 0
                ? "Actions: default governor proposal_count placeholder"
                : `Actions: ${draft.actions.length} on-chain call(s), order preserved.`}
            </p>
          </div>

          {!isConnected && (
            <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
              Connect your wallet to check voting power and submit.
            </p>
          )}

          {isConnected && publicKey && (
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-gray-500">Your votes:</span>{" "}
                <span className="font-mono font-medium">{votes?.toString() ?? "…"}</span>
              </p>
              <p>
                <span className="text-gray-500">Proposal threshold:</span>{" "}
                <span className="font-mono font-medium">
                  {threshold?.toString() ?? "…"}
                </span>
              </p>
              {belowThreshold && (
                <p className="text-red-700 font-medium bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  Voting power is below the proposal threshold. You need at least{" "}
                  {threshold?.toString()} votes (currently {votes?.toString()}). Delegate or
                  acquire voting power before submitting.
                </p>
              )}
            </div>
          )}

          <div className="border border-gray-200 rounded-xl p-4 text-sm">
            <p className="font-medium text-gray-900 mb-1">Estimated simulation cost</p>
            {estimateErr && (
              <p className="text-amber-800 text-xs">{estimateErr}</p>
            )}
            {estimate && (
              <ul className="text-xs text-gray-600 space-y-1 font-mono">
                {estimate.cpuInsns && <li>CPU instructions: {estimate.cpuInsns}</li>}
                {estimate.memBytes && <li>Memory (bytes): {estimate.memBytes}</li>}
                {!estimate.cpuInsns && !estimate.memBytes && (
                  <li>Simulation succeeded — fee will include base + resource charges.</li>
                )}
              </ul>
            )}
            {!estimate && !estimateErr && publicKey && (
              <p className="text-xs text-gray-400">Estimating…</p>
            )}
          </div>

          {submitError && (
            <p className="text-red-600 text-sm">{submitError}</p>
          )}
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
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700"
            >
              Open proposal
            </Link>
            <button
              type="button"
              onClick={async () => {
                const url = `${window.location.origin}/proposal/${successIdParam}`;
                try {
                  if (navigator.share) {
                    await navigator.share({ title: "Governance proposal", url });
                  } else {
                    await navigator.clipboard.writeText(url);
                    alert("Link copied to clipboard.");
                  }
                } catch {
                  await navigator.clipboard.writeText(url);
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 font-medium text-gray-800 hover:bg-gray-50"
            >
              <Share2 className="w-4 h-4" />
              Share
            </button>
            <Link
              href="/propose?step=1"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg text-indigo-600 font-medium hover:underline"
            >
              Create another
            </Link>
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
        <div className="flex justify-between mt-10 gap-4">
          <button
            type="button"
            disabled={step <= 1}
            onClick={() => setStep(step - 1)}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="button"
            disabled={
              (step === 3 &&
                (!isConnected ||
                  !reviewDataReady ||
                  belowThreshold)) ||
              submitting
            }
            onClick={() => goNext()}
            className="px-5 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {step === 3
              ? submitting
                ? "Submitting…"
                : "Submit on-chain"
              : "Next"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProposePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-3xl mx-auto px-4 py-16 text-center text-gray-500 text-sm">
          Loading wizard…
        </div>
      }
    >
      <ProposeWizardInner />
    </Suspense>
  );
}
