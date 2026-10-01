import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createControllerServer } from "../src/server.js";

const hostKey = "test-host-key-with-more-than-24-characters";

test("validates server configuration", () => {
  assert.throws(
    () => createControllerServer({ hostKey: "short", publicBaseUrl: "https://controller.example.test" }),
    /HOST_KEY/
  );
  assert.throws(
    () => createControllerServer({ hostKey, publicBaseUrl: "http://controller.example.test" }),
    /PUBLIC_BASE_URL/
  );
  assert.throws(
    () => createControllerServer({ hostKey, publicBaseUrl: "https://controller.example.test/path" }),
    /PUBLIC_BASE_URL/
  );
  assert.throws(
    () => createControllerServer({ hostKey, publicBaseUrl: "https://controller.example.test", sessionTtlMilliseconds: 0 }),
    /sessionTtlMilliseconds/
  );
});

test("serves health checks and rejects unsupported HTTP methods", async () => {
  const app = createControllerServer({ hostKey, publicBaseUrl: "https://controller.example.test" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok\n");

  const head = await fetch(`${baseUrl}/healthz`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const rejected = await fetch(`${baseUrl}/healthz`, { method: "POST" });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD");

  await app.close();
});

test("creates two private slots and relays host and STUN ICE candidates", async t => {
  const app = createControllerServer({
    hostKey,
    publicBaseUrl: "https://controller.example.test",
    publicDir: path.resolve("public")
  });
  t.after(() => app.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert(address && typeof address === "object");
  const endpoint = `ws://127.0.0.1:${address.port}/signal`;

  const host = await connect(endpoint);
  host.send(JSON.stringify({ type: "host.create", hostKey }));
  const created = await nextMessage(host);
  assert.equal(created.type, "session.created");
  assert.match(created.slots.p1.joinUrl, /slot=p1/);
  assert.match(created.slots.p2.joinUrl, /slot=p2/);
  assert.notEqual(created.slots.p1.joinUrl, created.slots.p2.joinUrl);

  const joinUrl = new URL(created.slots.p1.joinUrl);
  const phone = await connect(endpoint);
  const phoneReady = nextMessage(phone);
  const hostJoined = nextMessage(host);
  phone.send(JSON.stringify({
    type: "peer.join",
    session: joinUrl.searchParams.get("session"),
    slot: "p1",
    token: joinUrl.searchParams.get("token")
  }));
  assert.equal((await phoneReady).type, "peer.ready");
  assert.deepEqual(await hostJoined, { type: "peer.joined", slot: "p1" });

  const phoneOffer = nextMessage(phone);
  host.send(JSON.stringify({ type: "rtc.offer", slot: "p1", sdp: "offer-sdp" }));
  assert.deepEqual(await phoneOffer, { type: "rtc.offer", slot: "p1", sdp: "offer-sdp" });

  const hostCandidate = nextMessage(host);
  phone.send(JSON.stringify({
    type: "rtc.candidate",
    slot: "p1",
    candidate: { candidate: "candidate:1 1 udp 1 192.168.1.8 9999 typ host", sdpMid: "0", sdpMLineIndex: 0 }
  }));
  assert.equal((await hostCandidate).type, "rtc.candidate");

  const stunCandidate = nextMessage(host);
  phone.send(JSON.stringify({
    type: "rtc.candidate",
    slot: "p1",
    candidate: { candidate: "candidate:2 1 udp 1 203.0.113.8 9999 typ srflx", sdpMid: "0", sdpMLineIndex: 0 }
  }));
  assert.deepEqual(await stunCandidate, {
    type: "rtc.candidate", slot: "p1",
    candidate: { candidate: "candidate:2 1 udp 1 203.0.113.8 9999 typ srflx", sdpMid: "0", sdpMLineIndex: 0 }
  });

  phone.close();
  host.close();
});

test("rejects an invalid host secret", async () => {
  const app = createControllerServer({ hostKey, publicBaseUrl: "https://controller.example.test" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert(address && typeof address === "object");
  const client = await connect(`ws://127.0.0.1:${address.port}/signal`);
  const rejection = nextMessage(client);
  client.send(JSON.stringify({ type: "host.create", hostKey: "wrong" }));
  assert.deepEqual(await rejection, { type: "error", message: "Host authentication failed" });
  client.close();
  await app.close();
});

test("serializes session creation and QR rotation", async () => {
  const app = createControllerServer({ hostKey, publicBaseUrl: "https://controller.example.test" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert(address && typeof address === "object");
  const endpoint = `ws://127.0.0.1:${address.port}/signal`;

  const host = await connect(endpoint);
  const replies = nextMessages(host, 2);
  host.send(JSON.stringify({ type: "host.create", hostKey }));
  host.send(JSON.stringify({ type: "slot.rotate", slot: "p1" }));
  const [created, rotated] = await replies;
  assert.equal(created.type, "session.created");
  assert.equal(rotated.type, "slot.rotated");
  assert.equal(rotated.slot, "p1");
  assert.notEqual(created.slots.p1.joinUrl, rotated.joinUrl);

  const staleUrl = new URL(created.slots.p1.joinUrl);
  const stalePhone = await connect(endpoint);
  const rejection = nextMessage(stalePhone);
  stalePhone.send(JSON.stringify({
    type: "peer.join",
    session: staleUrl.searchParams.get("session"),
    slot: "p1",
    token: staleUrl.searchParams.get("token")
  }));
  assert.deepEqual(await rejection, { type: "error", message: "QR link is invalid or expired" });

  const currentUrl = new URL(rotated.joinUrl);
  const currentPhone = await connect(endpoint);
  const ready = nextMessage(currentPhone);
  const joined = nextMessage(host);
  currentPhone.send(JSON.stringify({
    type: "peer.join",
    session: currentUrl.searchParams.get("session"),
    slot: "p1",
    token: currentUrl.searchParams.get("token")
  }));
  assert.deepEqual(await ready, { type: "peer.ready", slot: "p1" });
  assert.deepEqual(await joined, { type: "peer.joined", slot: "p1" });

  stalePhone.close();
  currentPhone.close();
  host.close();
  await app.close();
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

async function nextMessage(socket: WebSocket): Promise<any> {
  const [data] = await once(socket, "message");
  return JSON.parse(data.toString());
}

async function nextMessages(socket: WebSocket, count: number): Promise<any[]> {
  return new Promise(resolve => {
    const messages: any[] = [];
    const onMessage = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length !== count) return;
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.on("message", onMessage);
  });
}
