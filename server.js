const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const SENDER_KEY = process.env.SENDER_KEY || "sender-123a88d8f2b64f31";
const PUBLIC_DIR = __dirname;
const MAX_MESSAGE_BYTES = 1024 * 1024;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);
const STATIC_FILES = new Set([
  "index.html",
  "sender.html",
  "viewer.js",
  "sender.js",
  "styles.css"
]);

const rooms = new Map();
const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, url);
  });
});

wss.on("connection", (ws, req, url) => {
  const role = url.searchParams.get("role");
  const roomId = normalizeRoom(url.searchParams.get("room"));
  const room = getRoom(roomId);

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (role === "sender") {
    registerSender(ws, room, url.searchParams.get("key"));
    return;
  }

  if (role === "viewer") {
    registerViewer(ws, room);
    return;
  }

  send(ws, { type: "error", error: "Invalid role" });
  ws.close(1008, "Invalid role");
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Screen stream server listening on http://localhost:${PORT}`);
});

function handleHttp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      clients: wss.clients.size
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  serveStatic(url.pathname, req.method === "HEAD", res);
}

function registerSender(ws, room, key) {
  if (key !== SENDER_KEY) {
    send(ws, { type: "error", error: "Sender-Key ist falsch" });
    ws.close(1008, "Invalid sender key");
    return;
  }

  if (room.sender && room.sender.readyState === WebSocket.OPEN) {
    send(room.sender, { type: "error", error: "Sender wurde ersetzt" });
    room.sender.close(4000, "Sender replaced");
  }

  room.sender = ws;
  room.live = false;

  send(ws, {
    type: "welcome",
    role: "sender",
    room: room.id,
    viewerIds: Array.from(room.viewers.keys()),
    viewerCount: room.viewers.size
  });

  broadcastToViewers(room, {
    type: "stream-state",
    online: true,
    live: room.live
  });

  ws.on("message", (raw) => {
    const message = parseMessage(raw);

    if (message.type === "stream-state") {
      room.live = Boolean(message.payload && message.payload.live);
      broadcastToViewers(room, {
        type: "stream-state",
        online: true,
        live: room.live
      });
      return;
    }

    if (message.type === "answer" || message.type === "ice") {
      const viewer = room.viewers.get(message.viewerId);

      if (viewer) {
        send(viewer, {
          type: message.type,
          payload: message.payload || null
        });
      }
    }
  });

  ws.on("close", () => {
    if (room.sender === ws) {
      room.sender = null;
      room.live = false;
      broadcastToViewers(room, {
        type: "stream-state",
        online: false,
        live: false
      });
      cleanupRoom(room);
    }
  });
}

function registerViewer(ws, room) {
  const viewerId = crypto.randomUUID();
  room.viewers.set(viewerId, ws);

  send(ws, {
    type: "welcome",
    role: "viewer",
    room: room.id,
    viewerId
  });

  send(ws, {
    type: "stream-state",
    online: Boolean(room.sender),
    live: room.live
  });

  if (room.sender) {
    send(room.sender, {
      type: "viewer-joined",
      viewerId,
      viewerCount: room.viewers.size
    });
  }

  ws.on("message", (raw) => {
    const message = parseMessage(raw);

    if (!room.sender) {
      send(ws, {
        type: "stream-state",
        online: false,
        live: false
      });
      return;
    }

    if (message.type === "viewer-ready") {
      send(room.sender, {
        type: "viewer-ready",
        viewerId
      });
      return;
    }

    if (message.type === "offer" || message.type === "ice") {
      send(room.sender, {
        type: message.type,
        viewerId,
        payload: message.payload || null
      });
    }
  });

  ws.on("close", () => {
    room.viewers.delete(viewerId);

    if (room.sender) {
      send(room.sender, {
        type: "viewer-left",
        viewerId,
        viewerCount: room.viewers.size
      });
    }

    cleanupRoom(room);
  });
}

function serveStatic(pathname, isHead, res) {
  let requestedPath = pathname;

  if (requestedPath === "/") {
    requestedPath = "/index.html";
  } else if (requestedPath === "/sender" || requestedPath === "/sender/") {
    requestedPath = "/sender.html";
  }

  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(requestedPath));
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  const normalizedPath = relativePath.replace(/\\/g, "/");

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || !STATIC_FILES.has(normalizedPath)) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const mimeType = MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": "no-store"
    });

    if (isHead) {
      res.end();
      return;
    }

    res.end(content);
  });
}

function getRoom(roomId) {
  let room = rooms.get(roomId);

  if (!room) {
    room = {
      id: roomId,
      sender: null,
      live: false,
      viewers: new Map()
    };
    rooms.set(roomId, room);
  }

  return room;
}

function cleanupRoom(room) {
  if (!room.sender && room.viewers.size === 0) {
    rooms.delete(room.id);
  }
}

function broadcastToViewers(room, message) {
  for (const [viewerId, viewer] of room.viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      send(viewer, message);
    } else {
      room.viewers.delete(viewerId);
    }
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return {};
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function normalizeRoom(value) {
  const room = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9_-]{1,80}$/.test(room) ? room : "main";
}
