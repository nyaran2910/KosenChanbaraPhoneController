import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const hostKey = "local-startup-test-key-with-more-than-24-characters";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phone controller test "));
  const root = path.join(directory, "phone");
  const state = path.join(root, ".local");
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(state);
  const script = path.join(root, "scripts/local-control.sh");
  await fs.copyFile("scripts/local-control.sh", script);
  await fs.writeFile(path.join(state, "host-key"), hostKey);
  const env = { ...process.env };
  for (const key of ["UNITY_CONFIG", "LOCAL_PORT", "UNITY_SIGNALING_URL", "LOCAL_STOP_COMMAND", "TMUX"]) {
    delete env[key];
  }
  return { directory, root, state, script, env };
}

test("starting an existing server repairs the Unity config without restarting it", async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  for (const file of ["server.pid", "tunnel.pid"]) {
    await fs.writeFile(path.join(f.state, file), String(process.pid));
  }
  await fs.writeFile(path.join(f.state, "public-url"), "https://test.trycloudflare.com");
  await fs.writeFile(path.join(f.state, "ready"), "");
  const configPath = path.join(f.directory, "unity/Assets/StreamingAssets/controller-connection.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ signalingUrl: "ws://old/signal", hostKey: "outdated" }));

  await run("sh", [f.script, "start"], { cwd: f.root, env: f.env, timeout: 5000 });
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    signalingUrl: "ws://127.0.0.1:8080/signal", hostKey
  });
  assert.equal(await fs.readFile(path.join(f.state, "server.pid"), "utf8"), String(process.pid));

  // A second entrypoint can choose another project while reusing the same server.
  const customConfig = path.join(f.directory, "another Unity project/connection.json");
  await run("sh", [f.script, "start"], {
    cwd: f.root, env: { ...f.env, UNITY_CONFIG: "../another Unity project/connection.json" }, timeout: 5000
  });
  assert.equal(JSON.parse(await fs.readFile(customConfig, "utf8")).hostKey, hostKey);
});

test("detached startup retains settings when the tmux server has an older environment", async t => {
  const f = await fixture();
  const bin = path.join(f.root, "bin");
  await fs.mkdir(bin);
  await fs.mkdir(path.join(f.root, "node_modules/.bin"), { recursive: true });
  async function executable(file: string, source: string) {
    await fs.writeFile(file, source, { mode: 0o755 });
  }
  // Only the external tunnel and HTTP service are replaced. The startup script
  // and its supervisor run normally, including writing the actual config file.
  await executable(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  await executable(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n");
  await executable(path.join(bin, "node"), "#!/bin/sh\nexec sleep 60\n");
  await executable(path.join(f.root, "node_modules/.bin/wrangler"),
    "#!/bin/sh\nprintf '%s\\n' 'https://test.trycloudflare.com'\nexec sleep 60\n");
  await executable(path.join(bin, "tmux"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const state = path.resolve(__dirname, '../.local');
const pidFile = path.join(state, 'test-supervisor.pid');
const args = process.argv.slice(2);
if (args.shift() === 'kill-session') {
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
  }
  process.exit(0);
}
const env = { ...process.env };
for (const name of ['UNITY_CONFIG', 'LOCAL_PORT', 'UNITY_SIGNALING_URL', 'LOCAL_STOP_COMMAND']) delete env[name];
while (args[0]?.startsWith('-')) {
  const flag = args.shift();
  if (flag === '-d') continue;
  const value = args.shift();
  if (flag === '-e') {
    const equals = value.indexOf('=');
    env[value.slice(0, equals)] = value.slice(equals + 1);
  }
}
const log = fs.openSync(path.join(state, 'supervisor.log'), 'a');
const child = spawn(args.shift(), args, { cwd: '/tmp', env, detached: true, stdio: ['ignore', log, log] });
fs.writeFileSync(pidFile, String(child.pid));
child.unref();
`);
  const env = { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  t.after(async () => {
    try {
      await run("sh", [f.script, "stop"], { env, timeout: 15000 });
    } finally {
      await fs.rm(f.directory, { recursive: true, force: true });
    }
  });
  const customConfig = path.join(f.directory, "selected Unity project/connection.json");
  const started = await run("sh", [f.script, "start"], {
    cwd: f.root, timeout: 12000,
    env: {
      ...env, UNITY_CONFIG: "../selected Unity project/connection.json", LOCAL_PORT: "9099",
      UNITY_SIGNALING_URL: "ws://127.0.0.1:9099/custom-signal", LOCAL_STOP_COMMAND: "make phone-controller-local-stop"
    }
  });
  assert.deepEqual(JSON.parse(await fs.readFile(customConfig, "utf8")), {
    signalingUrl: "ws://127.0.0.1:9099/custom-signal", hostKey
  });
  assert.match(started.stdout, /停止: make phone-controller-local-stop/);
  await assert.rejects(fs.access(path.join(f.directory, "KosenChanbara/Assets/StreamingAssets/controller-connection.json")));
});
