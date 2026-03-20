const ROSTER = {
  ava: { name: "Ava", role: "cos", source: "protoclawx" },
  kai: {
    name: "Kai",
    role: "backend",
    titleMatch: /backend|server|api|route|service|database|express|websocket/i,
  },
  matt: {
    name: "Matt",
    role: "frontend",
    titleMatch: /frontend|ui|component|page|css|style|react|tailwind|design/i,
  },
  sam: {
    name: "Sam",
    role: "agent",
    titleMatch: /agent|infra|pipeline|ci|workflow|mcp|tool|langfuse|tracing/i,
  },
  cindi: {
    name: "Cindi",
    role: "content",
    titleMatch: /content|docs|blog|writing|copy|documentation/i,
  },
  jon: {
    name: "Jon",
    role: "gtm",
    titleMatch: /gtm|marketing|growth|social|launch|brand/i,
  },
  josh: {
    name: "Josh",
    role: "founder",
    titleMatch: /architecture|core|critical|security/i,
  },
};

const assignmentCache = new Map();
const MAX_CACHE_SIZE = 10000;

const evictIfNeeded = () => {
  if (assignmentCache.size >= MAX_CACHE_SIZE) {
    const oldest = assignmentCache.keys().next().value;
    assignmentCache.delete(oldest);
  }
};

const resolveAgentForFeature = (featureId, title, category) => {
  const cached = assignmentCache.get(featureId);
  if (cached) return cached;

  const text = `${title ?? ""} ${category ?? ""}`.toLowerCase();

  for (const [agentId, agent] of Object.entries(ROSTER)) {
    if (agent.source) continue;
    if (agent.titleMatch && agent.titleMatch.test(text)) {
      evictIfNeeded();
      assignmentCache.set(featureId, agentId);
      return agentId;
    }
  }

  evictIfNeeded();
  assignmentCache.set(featureId, "sam");
  return "sam";
};

const getAgentIds = () => Object.keys(ROSTER);

module.exports = { ROSTER, resolveAgentForFeature, getAgentIds };
