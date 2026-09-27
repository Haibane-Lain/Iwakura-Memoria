// Unit tests for the Electron shell's pure lifecycle helpers (the free-port
// scan and the tree-kill). They live in electron/lifecycle.js so they can run
// under plain node, without booting Electron.
//
// Run: node tests/electron-lifecycle.test.mjs  (or `npm run test:electron`)
import assert from "node:assert/strict";

import lifecycle from "../electron/lifecycle.js";

const { BASE_PORT, PORT_TRIES, pickFreePort, killTree } = lifecycle;

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

console.log("electron-lifecycle:");

await check("the default range is 8000-8009", () => {
  assert.equal(BASE_PORT, 8000);
  assert.equal(PORT_TRIES, 10);
});

await check("uses the base port when it is free", async () => {
  assert.equal(await pickFreePort(async () => false), 8000);
});

await check("skips ports that already answer", async () => {
  const busy = new Set([8000, 8001]);
  assert.equal(await pickFreePort(async (port) => busy.has(port)), 8002);
});

await check("throws when every port in the range is taken", async () => {
  await assert.rejects(
    () => pickFreePort(async () => true),
    /no free port in 8000-8009/
  );
});

await check("honours a custom base and range", async () => {
  assert.equal(await pickFreePort(async () => false, 9000, 3), 9000);
  await assert.rejects(
    () => pickFreePort(async () => true, 9000, 3),
    /no free port in 9000-9002/
  );
});

await check("tree-kills with taskkill /T /F", () => {
  const calls = [];
  killTree((cmd, opts) => calls.push({ cmd, opts }), 4321);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "taskkill /PID 4321 /T /F");
  assert.deepEqual(calls[0].opts, { stdio: "ignore" });
});

await check("swallows a taskkill failure", () => {
  killTree(() => {
    throw new Error("no such process");
  }, 1);
});

if (failures) {
  console.log(`electron-lifecycle: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("electron-lifecycle: all checks passed");
