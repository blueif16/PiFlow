/* ============================================================
   products.ts — THE single source of truth for the product
   screens (Agents · Workflow · Memory). One file, one shape, so
   the same entry powers BOTH the grid card face (keyword eyebrow
   + title) AND the full-screen detail view you reach by clicking
   into a card (`details`). Update copy here only.

   Card face shows: `keywords` (short eyebrow) + `title`.
   Detail view shows: `summary` + `details.lead` + `details.points`.
   Presentation (HUD silhouette, grid layout, imagery) lives in
   the component — this file stays purely informational.
   ============================================================ */

export type ProductCard = {
  /** stable id — card key + future detail route/anchor */
  id: string;
  /** card-face heading */
  title: string;
  /** a few short keywords — the card's eyebrow / subtitle */
  keywords: string[];
  /** one-line gist (detail-view subheading) */
  summary: string;
  /** full-screen detail content, reached by clicking the card */
  details: {
    lead: string;
    points: string[];
  };
  /** placeholder slot — render a concise "coming soon", never hide */
  comingSoon?: boolean;
};

export type ProductPanel = {
  /** breadcrumb + anchor key */
  key: "agents" | "workflow" | "memory";
  /** breadcrumb label */
  name: string;
  /** rail index label, e.g. "P1" */
  layer: string;
  cards: ProductCard[];
};

// Concise placeholder for a slot whose copy hasn't landed yet.
const soon = (id: string): ProductCard => ({
  id,
  title: "Coming soon",
  keywords: [],
  summary: "",
  details: { lead: "", points: [] },
  comingSoon: true,
});

const AGENTS: ProductCard[] = [
  {
    id: "node",
    title: "Node",
    keywords: ["Pi agent", "Scoped"],
    summary: "A full Pi agent you scope and equip.",
    details: {
      lead: "Every node is a complete Pi agent — not a thin model call. You define exactly what it can see, touch, and do.",
      points: [
        "Freely define the read and write scope.",
        "Declare the tools and skills it can use.",
        "Install any MCP or OpenClaw plugin.",
        "Connect to any MCP server.",
      ],
    },
  },
  {
    id: "hooks",
    title: "Hooks",
    keywords: ["Pre / post", "Gate"],
    summary: "Programmatic checks around every node.",
    details: {
      lead: "Hooks let you run programmatic checks before and after a node — the seam where the gate and policy are applied.",
      points: [
        "Run a check before a node executes.",
        "Run a check after a node completes.",
        "Apply the gate + policy here.",
      ],
    },
  },
  {
    id: "sandbox",
    title: "Sandbox",
    keywords: ["Isolated", "Filesystem"],
    summary: "Isolated execution with file-based hand-off.",
    details: {
      lead: "The filesystem carries every hand-off between nodes, and each node runs isolated in a sandbox you scope at exactly the level you need.",
      points: [
        "All file passing goes through the filesystem.",
        "Set a sandbox per workflow, per run, or per node.",
        "Git-tracked sandboxes.",
        "Create one locally, on any OS, or on a supported cloud provider.",
      ],
    },
  },
  {
    id: "telemetry",
    title: "Telemetry",
    keywords: ["Live debug", "CLI"],
    summary: "See and debug the agent's runtime, live.",
    details: {
      lead: "Agent-native CLI commands surface the pieces that matter most when debugging an agent's runtime — every tool call and every sync.",
      points: [
        "Agent-native CLI commands for inspecting a run.",
        "Trace each tool call and each syncing step.",
        "Docker-style streaming modes to debug in real time.",
        "Monitor agent performance as it runs.",
      ],
    },
  },
  {
    id: "composability",
    title: "Composability",
    keywords: ["Lego-style", "Specialist"],
    summary: "Compose specialists from base types, skills, and tools.",
    details: {
      lead: "Start from base agent types and snap on skills and their associated tools like Lego — each node grows into the specialist its task needs.",
      points: [
        "Base agent types as the starting point.",
        "Skills and their associated tools.",
        "Piece them together like Lego.",
        "Each node wires up exactly the tools its task requires.",
      ],
    },
  },
  // Sixth slot fills the 3×2 grid with a "coming soon" placeholder.
  soon("agents-soon"),
];

const WORKFLOW: ProductCard[] = [
  {
    id: "adaptivity",
    title: "Adaptivity",
    keywords: ["Any DAG", "1-click"],
    summary: "Flexible designs that adapt to any graph change.",
    details: {
      lead: "Construct flexible designs that adapt to any DAG change — copy any pre-built workflow assembled with deep skill systems, and migrate in one click.",
      points: [
        "Adapt to any change in the DAG.",
        "Copy pre-built workflows assembled with massive skill systems.",
        "One-click migration — visualize every part of a running workflow.",
        "Each node is set up and wired with the tools that make it production-reliable.",
        "Get the full monitoring interface — e.g. visualize a model fusion in one click to see exactly how the graph grows.",
      ],
    },
  },
  {
    id: "cloud",
    title: "Cloud",
    keywords: ["Cloud promote", "Control plane"],
    summary: "Promote any DAG or node to a cloud control plane.",
    details: {
      lead: "Move your entire DAG, any node, or the rest of a run to the cloud — with a click or a message to an agent. Pi Flow promotes the local runtime to a cloud VM with a Kubernetes-style control plane.",
      points: [
        "Move the whole DAG, a single node, or the remaining run — one click, or a message to an agent.",
        "Auto-promote the local Pi Flow runtime to a cloud VM.",
        "A Kubernetes-style control plane monitors every agent runtime in its sandbox.",
        "Pushes the flow and gives remote access to monitor and control through the GUI.",
      ],
    },
  },
  soon("wf-soon"),
];

const MEMORY: ProductCard[] = [soon("mem-1"), soon("mem-2")];

export const PRODUCTS: ProductPanel[] = [
  { key: "agents", name: "Agents", layer: "P1", cards: AGENTS },
  { key: "workflow", name: "Workflow", layer: "P2", cards: WORKFLOW },
  { key: "memory", name: "Memory", layer: "P3", cards: MEMORY },
];
