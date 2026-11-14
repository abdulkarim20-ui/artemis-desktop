const { app } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { decideAgentAction } = require('./agent-identity');
const apiKeys = require('./api-keys');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const configuredPort = Number(process.env.ARTEMIS_PORT);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
  ? configuredPort
  : DEFAULT_PORT;

/*
 * The agent refuses every /api request without this per-launch secret, and
 * writes it to a per-port temp file. Reading an existing file first keeps a
 * still-running agent from a previous launch usable: the renderer then sends
 * the token that agent already knows instead of a fresh one it would reject.
 * The file is 0600 in the user's temp folder.
 */
const AGENT_TOKEN_FILE = path.join(os.tmpdir(), `artemis-agent-${PORT}.token`);

function readAgentToken() {
  try {
    return fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

const AGENT_TOKEN = readAgentToken() || crypto.randomBytes(32).toString('hex');

let agentProcess = null;
let starting = false;
let restartQueue = Promise.resolve();

/*
 * Everything the agent says is piped into this process's console - which
 * nobody sees when the app is started from a shortcut. It is therefore also
 * appended to <userData>/ai-agent.log, so a question like "the sidebar is
 * empty" can be answered by opening one file: which folder the agent read,
 * which agent served the port, and what the import copied.
 */
const LOG_FILE = 'ai-agent.log';
const LOG_MAX_BYTES = 1024 * 1024; // start over instead of growing forever

function appendAgentLog(text) {
  try {
    const file = path.join(app.getPath('userData'), LOG_FILE);
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.rmSync(file);
    } catch {
      /* not there yet - first write */
    }
    const line = text.endsWith('\n') ? text : `${text}\n`;
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}`);
  } catch {
    // Logging must never break the app.
  }
}

/** Say something to the console AND the log file. */
function logLine(line) {
  console.log(line);
  appendAgentLog(line);
}

/**
 * Ask the port who is listening. Unlike a bare health check this returns the
 * agent's data folder, so the caller can tell "our agent" from a foreign one
 * (for example a standalone dev agent run without ARTEMIS_DATA_DIR).
 */
function probeAgent(timeoutMs = 700) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: HOST,
        port: PORT,
        path: '/api/health',
        timeout: timeoutMs,
        headers: { 'x-artemis-token': AGENT_TOKEN },
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 200) return resolve({ ok: false });
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          let dataRoot = null;
          try { dataRoot = JSON.parse(raw).dataRoot || null; } catch { /* not our agent's shape */ }
          resolve({ ok: true, dataRoot });
        });
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false });
    });
    request.on('error', () => resolve({ ok: false }));
  });
}

/** Back-compat wrapper: just "is something healthy listening?" */
async function isAgentHealthy(timeoutMs = 700) {
  return (await probeAgent(timeoutMs)).ok;
}

async function waitForAgent(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAgentHealthy(300)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * A graceful good-bye for an agent this app did not start, plus waiting for
 * the port to actually free: server.js exits on EADDRINUSE, so spawning over
 * a living stranger would just lose our agent.
 */
async function stopForeignAgent(timeoutMs = 4000) {
  await new Promise((resolve) => {
    const token = readAgentToken() || AGENT_TOKEN;
    const request = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/api/shutdown',
        method: 'POST',
        timeout: 2000,
        // Older standalone agents ignore the header; current ones reject
        // requests without it.
        headers: token ? { 'x-artemis-token': token } : {},
      },
      (response) => { response.resume(); resolve(); }
    );
    request.on('timeout', () => { request.destroy(); resolve(); });
    request.on('error', () => resolve());
    request.end();
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAgentHealthy(400))) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * Start the bundled AI agent if it is not already listening.
 * The agent is a normal Node program; Electron can run it as Node by setting
 * ELECTRON_RUN_AS_NODE, which avoids requiring a separate Node install.
 */
async function startAiAgent() {
  if (starting) return;
  starting = true;

  try {
    const first = await probeAgent();
    if (first.ok) {
      /*
       * The probe may have caught the previous session's agent still dying.
       * A short settle re-checks: a dead one means "spawn", a live one gets
       * identified by the data folder it reads.
       */
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await probeAgent();
      const theirDataRoot = second.dataRoot || first.dataRoot;
      const action = decideAgentAction({
        healthyAgain: second.ok,
        theirDataRoot,
        ourDataRoot: path.join(app.getPath('userData'), 'chats'),
      });
      logLine(`[AI Agent] Port ${PORT} is held by an agent reading ${theirDataRoot || 'an unknown folder'}; decision: ${action}`);

      if (action === 'reuse') {
        console.log('[AI Agent] Already running on port', PORT);
        return;
      }

      if (action === 'replace') {
        console.warn(
          `[AI Agent] Port ${PORT} is held by an agent reading a different data folder` +
          ` (${theirDataRoot}). Asking it to shut down so the app's` +
          ' own agent - and its chat history - takes over.'
        );
        await stopForeignAgent();
      }
      // action === 'spawn': the "already running" agent died between probes.
    }

    const agentDir = path.join(app.getAppPath(), 'ai-agent');
    const serverFile = path.join(agentDir, 'server.js');
    /*
     * When packaged, agentDir is inside app.asar and therefore not a real
     * directory: spawn() fails with ENOENT before the agent even starts. The
     * agent locates its own files through __dirname, so a real folder is all
     * cwd needs to be.
     */
    const agentCwd = app.isPackaged ? process.resourcesPath : agentDir;

    // Say where history lives, so an empty sidebar can be checked against the
    // log ("is it reading the folder I think it is?").
    logLine(`[AI Agent] Chat history folder: ${path.join(app.getPath('userData'), 'chats')}`);

    let savedKeys = {};
    try {
      savedKeys = apiKeys.getEnv();
    } catch (error) {
      logLine(`[AI Agent] Saved API keys could not be loaded: ${error?.message || error}`);
    }

    const child = spawn(process.execPath, [
      '--disable-warning=DEP0040',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      serverFile,
    ], {
      cwd: agentCwd,
      env: {
        ...process.env,
        ...savedKeys,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(PORT),
        ARTEMIS_API_TOKEN: AGENT_TOKEN,
        /*
         * The RAG index has to be written somewhere the packaged app is
         * actually allowed to write. Inside app.getAppPath() it is not: an
         * installed app lives under Program Files. userData is per-user,
         * survives updates, and is the same place Electron already keeps
         * everything else we own.
         */
        ARTEMIS_DATA_DIR: app.getPath('userData'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    agentProcess = child;

    child.stdout.on('data', (data) => {
      const text = String(data).trimEnd();
      if (!text) return;
      console.log('[AI Agent]', text);
      appendAgentLog(text);
    });
    child.stderr.on('data', (data) => {
      const text = String(data).trimEnd();
      if (!text) return;
      console.error('[AI Agent]', text);
      appendAgentLog(text);
    });
    child.on('exit', (code, signal) => {
      logLine(`[AI Agent] Exited { code: ${code}, signal: ${signal} }`);
      if (agentProcess === child) agentProcess = null;
    });
    child.on('error', (error) => {
      console.error('[AI Agent] Failed to start:', error);
      appendAgentLog(`[AI Agent] Failed to start: ${error?.stack || error}`);
      if (agentProcess === child) agentProcess = null;
    });

    // Give the agent a moment to bind its port before the renderer starts
    // requesting models. This avoids one noisy connection-refused retry.
    const ready = await waitForAgent();
    if (!ready) {
      logLine('[AI Agent] Still not healthy after 45s; the UI will keep retrying.');
    }
  } finally {
    starting = false;
  }
}

function stopAiAgent() {
  if (!agentProcess) return;
  const child = agentProcess;
  agentProcess = null;

  try {
    child.kill();
  } catch {
    // Already gone.
  }
}

function restartAiAgent() {
  const restart = restartQueue.then(async () => {
    while (starting) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    logLine('[AI Agent] Restarting to apply new API keys');
    stopAiAgent();
    if (!(await stopForeignAgent())) {
      throw new Error('The previous AI agent did not stop; the saved key is not active yet.');
    }
    await startAiAgent();
    if (!(await isAgentHealthy(1000))) {
      throw new Error('The AI agent did not become healthy after restarting.');
    }
    return true;
  });

  // Keep the queue usable after a failed restart while returning that failure
  // to the IPC caller.
  restartQueue = restart.catch(() => {});
  return restart;
}

module.exports = {
  startAiAgent,
  stopAiAgent,
  restartAiAgent,
  isAgentHealthy,
  probeAgent,
  AI_AGENT_PORT: PORT,
  AGENT_TOKEN,
};
