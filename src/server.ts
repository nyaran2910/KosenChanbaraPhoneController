import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";

type SlotId = "p1" | "p2";
type ClientRole = "unknown" | "host" | "peer";

interface Slot {
  id: SlotId;
  token: string;
  peer?: WebSocket;
}

interface Session {
  id: string;
  host: WebSocket;
  slots: Record<SlotId, Slot>;
  touchedAt: number;
}

interface ClientContext {
  role: ClientRole;
  session?: Session;
  slot?: Slot;
  messageCount: number;
  rateWindowStarted: number;
  messageQueue: Promise<void>;
}

export interface ControllerServerOptions {
  hostKey: string;
  publicBaseUrl: string;
  publicDir?: string;
  sessionTtlMilliseconds?: number;
}

export interface ControllerServer {
  server: http.Server;
  close(): Promise<void>;
}

const slots: SlotId[] = ["p1", "p2"];
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

export function createControllerServer(options: ControllerServerOptions): ControllerServer {
  if (options.hostKey.length < 24) {
    throw new Error("HOST_KEY must be at least 24 characters");
  }

  let parsedPublicBaseUrl: URL;
  try {
    parsedPublicBaseUrl = new URL(options.publicBaseUrl);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid https:// origin");
  }
  if (parsedPublicBaseUrl.protocol !== "https:" || parsedPublicBaseUrl.pathname !== "/" ||
      parsedPublicBaseUrl.username || parsedPublicBaseUrl.password ||
      parsedPublicBaseUrl.search || parsedPublicBaseUrl.hash) {
    throw new Error("PUBLIC_BASE_URL must be a valid https:// origin");
  }

  const publicBaseUrl = parsedPublicBaseUrl.origin;
  const publicDir = options.publicDir ?? path.resolve(process.cwd(), "public");
  const ttl = options.sessionTtlMilliseconds ?? 12 * 60 * 60 * 1000;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("sessionTtlMilliseconds must be positive");
  }
  const sessions = new Map<string, Session>();
  const contexts = new WeakMap<WebSocket, ClientContext>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 262_144 });

  const server = http.createServer((request, response) => {
    void serveHttp(request, response, publicDir);
  });

  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/signal") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, webSocket => {
      wss.emit("connection", webSocket, request);
    });
  });

  wss.on("connection", webSocket => {
    webSocket.on("error", error => {
      console.error("signaling socket failed", error);
    });
    contexts.set(webSocket, {
      role: "unknown",
      messageCount: 0,
      rateWindowStarted: Date.now(),
      messageQueue: Promise.resolve()
    });

    webSocket.on("message", (raw, isBinary) => {
      if (isBinary) {
        webSocket.close(1003, "Text signaling only");
        return;
      }

      const context = contexts.get(webSocket);
      if (!context || !consumeRateLimit(context)) {
        webSocket.close(4008, "Rate limit");
        return;
      }

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        sendError(webSocket, "Invalid JSON");
        return;
      }

      context.messageQueue = context.messageQueue
        .then(() => {
          if (webSocket.readyState !== WebSocket.OPEN) return;
          return handleMessage(webSocket, context, message);
        })
        .catch(error => {
          console.error("signaling message failed", error);
          sendError(webSocket, "Signaling request failed");
        });
    });

    webSocket.on("close", () => {
      const context = contexts.get(webSocket);
      if (!context?.session) return;

      if (context.role === "host" && context.session.host === webSocket) {
        destroySession(context.session, sessions);
      } else if (context.role === "peer" && context.slot?.peer === webSocket) {
        context.slot.peer = undefined;
        send(context.session.host, { type: "peer.left", slot: context.slot.id });
      }
    });
  });

  const cleanupTimer = setInterval(() => {
    const expiredBefore = Date.now() - ttl;
    for (const session of sessions.values()) {
      if (session.touchedAt < expiredBefore) destroySession(session, sessions);
    }
  }, 60_000);
  cleanupTimer.unref();

  async function handleMessage(
    webSocket: WebSocket,
    context: ClientContext,
    message: Record<string, unknown>
  ): Promise<void> {
    const type = asString(message.type);

    if (context.role === "unknown") {
      if (type === "host.create") {
        if (!secretMatches(asString(message.hostKey), options.hostKey)) {
          sendError(webSocket, "Host authentication failed");
          webSocket.close(4003, "Forbidden");
          return;
        }

        const session = createSession(webSocket);
        sessions.set(session.id, session);
        context.role = "host";
        context.session = session;
        const presentations = await Promise.all(slots.map(id => presentSlot(session, session.slots[id])));
        send(webSocket, {
          type: "session.created",
          sessionId: session.id,
          slots: Object.fromEntries(presentations.map(item => [item.slot, item]))
        });
        return;
      }

      if (type === "peer.join") {
        const session = sessions.get(asString(message.session));
        const slotId = parseSlot(message.slot);
        const token = asString(message.token);
        const slot = session && slotId ? session.slots[slotId] : undefined;
        if (!session || !slot || !secretMatches(token, slot.token) || session.host.readyState !== WebSocket.OPEN) {
          sendError(webSocket, "QR link is invalid or expired");
          webSocket.close(4004, "Invalid link");
          return;
        }

        if (slot.peer && slot.peer !== webSocket) {
          slot.peer.close(4001, "Replaced by a new phone");
        }
        slot.peer = webSocket;
        session.touchedAt = Date.now();
        context.role = "peer";
        context.session = session;
        context.slot = slot;
        send(webSocket, { type: "peer.ready", slot: slot.id });
        send(session.host, { type: "peer.joined", slot: slot.id });
        return;
      }

      sendError(webSocket, "Authenticate first");
      return;
    }

    const session = context.session;
    if (!session) return;
    session.touchedAt = Date.now();

    if (context.role === "host") {
      const slotId = parseSlot(message.slot);
      if (!slotId) {
        sendError(webSocket, "Invalid slot");
        return;
      }
      const slot = session.slots[slotId];

      if (type === "slot.rotate") {
        if (slot.peer) slot.peer.close(4001, "QR rotated");
        slot.peer = undefined;
        slot.token = randomToken(24);
        send(webSocket, { type: "slot.rotated", ...(await presentSlot(session, slot)) });
        return;
      }
      if (type === "rtc.offer") {
        const sdp = asBoundedString(message.sdp, 180_000);
        if (sdp) send(slot.peer, { type, slot: slotId, sdp });
        return;
      }
      if (type === "rtc.candidate") {
        relayCandidate(slot.peer, slotId, message.candidate);
        return;
      }
      sendError(webSocket, "Unsupported host message");
      return;
    }

    const slot = context.slot;
    if (!slot || slot.peer !== webSocket) return;
    if (type === "rtc.answer") {
      const sdp = asBoundedString(message.sdp, 180_000);
      if (sdp) send(session.host, { type, slot: slot.id, sdp });
      return;
    }
    if (type === "rtc.candidate") {
      relayCandidate(session.host, slot.id, message.candidate);
      return;
    }
    sendError(webSocket, "Unsupported phone message");
  }

  function createSession(host: WebSocket): Session {
    return {
      id: randomToken(12),
      host,
      touchedAt: Date.now(),
      slots: {
        p1: { id: "p1", token: randomToken(24) },
        p2: { id: "p2", token: randomToken(24) }
      }
    };
  }

  async function presentSlot(session: Session, slot: Slot) {
    const joinUrl = `${publicBaseUrl}/?session=${encodeURIComponent(session.id)}&slot=${slot.id}&token=${encodeURIComponent(slot.token)}`;
    const qrPngBase64 = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512
    });
    return { slot: slot.id, joinUrl, qrPngBase64 };
  }

  return {
    server,
    async close() {
      clearInterval(cleanupTimer);
      for (const session of sessions.values()) destroySession(session, sessions);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  };
}

async function serveHttp(request: IncomingMessage, response: ServerResponse, publicDir: string): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { "allow": "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed\n");
    return;
  }
  const headOnly = method === "HEAD";
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request\n");
    return;
  }
  if (pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(headOnly ? undefined : "ok\n");
    return;
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(`${path.resolve(publicDir)}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }

  try {
    const contents = await fs.readFile(resolved);
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": path.extname(resolved) === ".html" ? "no-store" : "public, max-age=3600",
      "content-security-policy": "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    });
    response.end(headOnly ? undefined : contents);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
}

function relayCandidate(target: WebSocket | undefined, slot: SlotId, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  const candidateText = asBoundedString(candidate.candidate, 4096);
  if (!candidateText) return;
  send(target, {
    type: "rtc.candidate",
    slot,
    candidate: {
      candidate: candidateText,
      sdpMid: asBoundedString(candidate.sdpMid, 128) ?? null,
      sdpMLineIndex: typeof candidate.sdpMLineIndex === "number" ? candidate.sdpMLineIndex : null
    }
  });
}

function consumeRateLimit(context: ClientContext): boolean {
  const now = Date.now();
  if (now - context.rateWindowStarted >= 10_000) {
    context.rateWindowStarted = now;
    context.messageCount = 0;
  }
  context.messageCount += 1;
  return context.messageCount <= 160;
}

function destroySession(session: Session, sessions: Map<string, Session>): void {
  sessions.delete(session.id);
  for (const slot of slots) {
    session.slots[slot].peer?.close(4004, "Session expired");
    session.slots[slot].peer = undefined;
  }
  if (session.host.readyState === WebSocket.OPEN) session.host.close(1000, "Session closed");
}

function send(socket: WebSocket | undefined, message: unknown): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A close can race with readyState between the check and send.
  }
}

function sendError(socket: WebSocket, message: string): void {
  send(socket, { type: "error", message });
}

function parseSlot(value: unknown): SlotId | undefined {
  return value === "p1" || value === "p2" ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoundedString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function secretMatches(received: string, expected: string): boolean {
  const receivedHash = createHash("sha256").update(received).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}
