import { For, Show, createSignal, onCleanup } from "solid-js";
import type { AgentProposal, AgentProposalReview } from "@teldra/application";
import "./AgentProposalsPanel.css";

export interface AgentProposalsPanelProps {
  readonly proposals: readonly AgentProposal[];
  /** Fires only from the user's explicit click. */
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
  readonly onRevert: (id: string) => void;
  /** Last review error (typed code + message), shown inline. */
  readonly error?: string | undefined;
}

const fmt = (value: unknown): string => (value === null || value === undefined ? "none" : typeof value === "string" ? value : JSON.stringify(value));

/** Reactive bridge: mirrors `review.list()` into a Solid accessor and exposes error-reporting handlers. */
export function connectAgentProposals(review: AgentProposalReview) {
  const [proposals, setProposals] = createSignal<readonly AgentProposal[]>(review.list());
  const [error, setError] = createSignal<string | undefined>(undefined);
  const off = review.subscribe(() => setProposals(review.list()));
  onCleanup(off);
  const guard = (action: (id: string) => unknown) => (id: string) => {
    try { action(id); setError(undefined); }
    catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(`${code ? `${code}: ` : ""}${cause instanceof Error ? cause.message : String(cause)}`);
    }
    setProposals(review.list());
  };
  return { proposals, error, onApprove: guard((id) => review.approve(id)), onReject: guard((id) => review.reject(id)), onRevert: guard((id) => review.revert(id)) };
}

export function AgentProposalsPanel(props: AgentProposalsPanelProps) {
  return (
    <section class="teldra-agent-proposals" aria-labelledby="teldra-agent-proposals-title">
      <h2 id="teldra-agent-proposals-title">Agent proposals</h2>
      <p class="teldra-agent-proposals__hint">Agents can only suggest changes. Nothing is applied until you approve it.</p>
      <Show when={props.error}><p role="alert" class="teldra-agent-proposals__error">{props.error}</p></Show>
      <Show when={props.proposals.length > 0} fallback={<p class="teldra-agent-proposals__empty">No proposals yet.</p>}>
        <ul class="teldra-agent-proposals__list">
          <For each={props.proposals}>{(proposal) => (
            <li class="teldra-agent-proposals__item" data-status={proposal.status} data-testid={`proposal-${proposal.id}`}>
              <header>
                <strong>{proposal.summary}</strong>
                <span class="teldra-agent-proposals__status">{proposal.status}</span>
              </header>
              <small>by {proposal.agentId}</small>
              <Show when={proposal.stale}>
                <p class="teldra-agent-proposals__stale" role="status">The project changed since this was proposed. Reject it and ask the agent to propose again.</p>
              </Show>
              <For each={proposal.diff}>{(entry) => (
                <table class="teldra-agent-proposals__diff">
                  <caption>{entry.target}{entry.cause === "connected" ? " (connected change)" : ""}</caption>
                  <thead><tr><th scope="col">Property</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
                  <tbody><For each={entry.properties}>{(row) => (
                    <tr><th scope="row">{row.property}</th><td>{fmt(row.before)}</td><td>{fmt(row.after)}</td></tr>
                  )}</For></tbody>
                </table>
              )}</For>
              <div class="teldra-agent-proposals__actions">
                <Show when={proposal.status === "pending" || proposal.status === "approved"}>
                  <button type="button" disabled={proposal.stale} onClick={() => props.onApprove(proposal.id)}>Approve</button>
                  <button type="button" onClick={() => props.onReject(proposal.id)}>Reject</button>
                </Show>
                <Show when={proposal.status === "applied"}>
                  <button type="button" onClick={() => props.onRevert(proposal.id)}>Revert</button>
                </Show>
              </div>
            </li>
          )}</For>
        </ul>
      </Show>
    </section>
  );
}
