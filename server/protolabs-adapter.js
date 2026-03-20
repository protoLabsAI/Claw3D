const { WebSocket } = require("ws");
const http = require("node:http");
const {
  resolveAgentForFeature,
  getAgentIds,
} = require("./protolabs-agent-roster");

let seqCounter = 100000;

const nextSeq = () => ++seqCounter;

const makeSessionKey = (agentId) => `agent:${agentId}:protolabs`;

const makeRunId = () =>
  `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const eventFrame = (event, payload, seq) => ({
  type: "event",
  event,
  payload,
  seq: seq ?? nextSeq(),
});

const chatFrame = (agentId, state, message, extra) =>
  eventFrame("chat", {
    runId: makeRunId(),
    sessionKey: makeSessionKey(agentId),
    state,
    ...(message != null ? { message } : {}),
    ...(extra ?? {}),
  });

const agentFrame = (agentId, stream, data) =>
  eventFrame("agent", {
    runId: makeRunId(),
    sessionKey: makeSessionKey(agentId),
    seq: nextSeq(),
    stream,
    ...(data != null ? { data } : {}),
  });

const presenceFrame = (activeAgentIds) => {
  const agents = {};
  for (const id of getAgentIds()) {
    agents[makeSessionKey(id)] = {
      status: activeAgentIds.includes(id) ? "active" : "idle",
    };
  }
  return eventFrame("presence", { agents });
};

// --- Automaker WebSocket source ---

function createAutomakerSource({ config, broadcast, log, logError }) {
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let stopped = false;
  let status = "disconnected";

  const featureAgentMap = new Map();

  const resolveAgent = (payload) => {
    const featureId = payload?.featureId ?? payload?.id ?? "";
    const title = payload?.title ?? payload?.featureTitle ?? "";
    const category = payload?.category ?? "";
    if (!featureId) return "sam";
    if (featureAgentMap.has(featureId)) return featureAgentMap.get(featureId);
    const agentId = resolveAgentForFeature(featureId, title, category);
    featureAgentMap.set(featureId, agentId);
    return agentId;
  };

  const translateEvent = (msg) => {
    const { type, payload } = msg;
    if (!type) return null;

    switch (type) {
      case "feature:started": {
        const agentId = resolveAgent(payload);
        return chatFrame(agentId, "delta", {
          role: "user",
          content: "go to your desk",
        });
      }

      case "feature:completed": {
        const agentId = resolveAgent(payload);
        return chatFrame(agentId, "final", {
          role: "user",
          content: "leave your desk",
        });
      }

      case "feature:status-changed": {
        const newStatus = payload?.status ?? payload?.newStatus;
        if (newStatus === "review") {
          const agentId = resolveAgent(payload);
          return chatFrame(agentId, "delta", {
            role: "user",
            content: "check github",
          });
        }
        return null;
      }

      case "feature:error":
      case "feature:blocked": {
        const agentId = resolveAgent(payload);
        return chatFrame(agentId, "error", undefined, {
          errorMessage: payload?.error ?? payload?.reason ?? "Feature blocked",
        });
      }

      case "agent:stream": {
        const agentId = resolveAgent(payload);
        return agentFrame(agentId, "assistant", payload?.data);
      }

      case "auto-mode:started": {
        return presenceFrame(getAgentIds().filter((id) => id !== "ava"));
      }

      case "auto-mode:stopped": {
        return presenceFrame([]);
      }

      default:
        return null;
    }
  };

  const connect = () => {
    if (stopped) return;

    const url = config.automakerUrl || "ws://localhost:3008";
    const apiKey = config.automakerApiKey || "";
    const wsUrl = apiKey
      ? `${url}/api/events?apiKey=${encodeURIComponent(apiKey)}`
      : `${url}/api/events`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      logError("Automaker WS connect failed", err);
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      status = "connected";
      reconnectDelay = 1000;
      log("Automaker source connected");
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const frame = translateEvent(msg);
        if (frame) broadcast(frame);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      status = "disconnected";
      log("Automaker source disconnected");
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      status = "error";
      logError("Automaker WS error", err);
    });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    }, reconnectDelay);
  };

  const start = () => {
    stopped = false;
    connect();
  };

  const stop = () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      ws?.close();
    } catch {}
    ws = null;
    status = "disconnected";
  };

  const getStatus = () => status;

  return { start, stop, getStatus };
}

// --- ProtoClawX health poller ---

function createProtoClawXSource({ config, broadcast, log, logError }) {
  let timer = null;
  let stopped = false;
  let status = "disconnected";
  let lastActive = false;

  const poll = () => {
    const url = config.protoclawxUrl || "http://localhost:8318";
    const healthUrl = `${url}/api/chat/health`;

    const parsed = new URL(healthUrl);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: "GET",
      timeout: 5000,
    };

    const req = http.request(reqOpts, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const isActive = data?.status === "ok" || data?.active === true;
          status = "connected";

          if (isActive !== lastActive) {
            lastActive = isActive;
            broadcast(presenceFrame(isActive ? ["ava"] : []));
            log(`ProtoClawX Ava ${isActive ? "active" : "idle"}`);
          }
        } catch {
          // ignore parse errors
        }
      });
    });

    req.on("error", (err) => {
      if (status !== "error") {
        logError("ProtoClawX health poll failed", err);
      }
      status = "error";
      if (lastActive) {
        lastActive = false;
        broadcast(presenceFrame([]));
      }
    });

    req.on("timeout", () => {
      req.destroy();
      status = "error";
    });

    req.end();
  };

  const start = () => {
    stopped = false;
    poll();
    const interval = config.healthPollMs || 10000;
    timer = setInterval(poll, interval);
  };

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    timer = null;
    status = "disconnected";
  };

  const getStatus = () => status;

  return { start, stop, getStatus };
}

// --- Main adapter ---

function createProtolabsAdapter(options) {
  const {
    config,
    log = (...args) => console.log("[protolabs]", ...args),
    logError = (...args) => console.error("[protolabs]", ...args),
  } = options || {};

  const browserClients = new Set();

  const broadcast = (frame) => {
    const raw = JSON.stringify(frame);
    for (const ws of browserClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  };

  const automaker = createAutomakerSource({ config, broadcast, log, logError });
  const protoclawx = createProtoClawXSource({
    config,
    broadcast,
    log,
    logError,
  });

  const start = () => {
    log("Starting adapter");
    automaker.start();
    protoclawx.start();
  };

  const stop = () => {
    log("Stopping adapter");
    automaker.stop();
    protoclawx.stop();
  };

  const addBrowserClient = (ws) => {
    browserClients.add(ws);
  };

  const removeBrowserClient = (ws) => {
    browserClients.delete(ws);
  };

  const getStatus = () => ({
    automaker: automaker.getStatus(),
    protoclawx: protoclawx.getStatus(),
    browserClients: browserClients.size,
  });

  return { start, stop, addBrowserClient, removeBrowserClient, getStatus };
}

module.exports = { createProtolabsAdapter };
