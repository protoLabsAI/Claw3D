const { WebSocket } = require("ws");

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

function createSyntheticGateway(options) {
  const {
    adapter,
    log = (...args) => console.log("[protolabs:gateway]", ...args),
  } = options || {};

  const handleConnection = (browserWs) => {
    let heartbeatInterval = null;

    browserWs.on("message", (raw) => {
      const msg = safeJsonParse(String(raw ?? ""));
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "req" && msg.method === "connect" && msg.id) {
        const response = {
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 1,
            features: {
              methods: [],
              events: ["chat", "agent", "presence", "heartbeat"],
            },
            policy: { tickIntervalMs: 30000 },
          },
        };
        browserWs.send(JSON.stringify(response));
        log("Synthetic hello-ok sent");

        adapter.addBrowserClient(browserWs);

        heartbeatInterval = setInterval(() => {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(
              JSON.stringify({
                type: "event",
                event: "heartbeat",
                payload: { ts: Date.now() },
              }),
            );
          }
        }, 30000);
      }
    });

    browserWs.on("close", () => {
      adapter.removeBrowserClient(browserWs);
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      log("Browser client disconnected");
    });

    browserWs.on("error", () => {
      adapter.removeBrowserClient(browserWs);
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    });
  };

  return { handleConnection };
}

module.exports = { createSyntheticGateway };
