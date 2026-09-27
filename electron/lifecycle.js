"use strict";

// Pure helpers pulled out of electron/main.js so the port-scan and tree-kill
// rules can be exercised by a unit test without booting Electron. main.js
// injects the real http / child_process functions; the test injects fakes.

const BASE_PORT = 8000;
const PORT_TRIES = 10;

// Walk 8000, 8001, … until something is not already answering, so a stale
// server (or a second instance) cannot make this one bind-fail.
async function pickFreePort(isUp, base = BASE_PORT, tries = PORT_TRIES) {
  let port = base;
  for (let i = 0; i < tries; i++) {
    if (!(await isUp(port))) return port;
    port += 1;
  }
  throw new Error(`no free port in ${base}-${base + tries - 1}`);
}

// Tree-kill: terminates the python process AND its java (LanguageTool) child,
// which a plain terminate would orphan (Windows has no process groups here).
function killTree(execSync, pid) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

module.exports = { BASE_PORT, PORT_TRIES, pickFreePort, killTree };
