import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { AgentProposal } from "@teldra/application";
import { AgentProposalsPanel, type AgentProposalsPanelProps } from "./AgentProposalsPanel";

function Harness(props: AgentProposalsPanelProps) {
  return <main style={{ background: "#17212d", padding: "1rem" }}><AgentProposalsPanel {...props} /></main>;
}
const base = { agentId: "webmcp:assistant", baseRevision: "t0.w0.f0", createdAt: "2026-01-01T00:00:00Z", stale: false } as const;
const wall: AgentProposal = {
  ...base, id: "proposal:1", status: "pending", summary: "Extend the north wall by 1 m",
  operation: { kind: "wall.update", canonicalId: "wall:north", geometry: { start: [0, 0], end: [5, 0], thickness: 0.2, height: 2.5, elevation: 0 } },
  diff: [
    { target: "wall:north", cause: "requested", properties: [{ property: "end", before: [4, 0], after: [5, 0] }] },
    { target: "wall:east", cause: "connected", properties: [{ property: "start", before: [4, 0], after: [5, 0] }] },
  ],
};
const chair: AgentProposal = {
  ...base, id: "proposal:2", status: "applied", summary: "Move the chair next to the table",
  operation: { kind: "furniture.transform", canonicalId: "chair:1", position: [3, 1, 0], yawRadians: 0.5 },
  diff: [{ target: "chair:1", cause: "requested", properties: [{ property: "position", before: [1, 1, 0], after: [3, 1, 0] }] }],
};

const meta = {
  title: "Studio/AgentProposalsPanel",
  component: Harness,
  args: { proposals: [], onApprove: () => {}, onReject: () => {}, onRevert: () => {} },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const PendingWithBeforeAfter: Story = { args: { proposals: [wall] } };
export const AppliedCanRevert: Story = { args: { proposals: [chair] } };
export const Rejected: Story = { args: { proposals: [{ ...wall, status: "rejected" }] } };
export const StaleConflict: Story = {
  args: { proposals: [{ ...wall, stale: true }], error: "stale-revision: The project changed since this proposal was made." },
};
