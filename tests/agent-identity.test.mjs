/**
 * ============================================================================
 * AGENT STARTUP IDENTITY TESTS
 * ============================================================================
 * "Older chats disappear after a restart" had three causes; two live in the
 * startup wiring between the Electron main process and the agent:
 *
 *   - a previous session's agent still dying made the new app skip spawning
 *     its own agent, leaving nothing on the port;
 *   - a standalone dev agent (no ARTEMIS_DATA_DIR) holding the port was
 *     reused silently, so the app talked to an EMPTY data folder and new
 *     chats were filed where the app can never see them again.
 *
 * decideAgentAction() is the pure decision at the center of that fix; the
 * source assertions pin the async wiring around it.
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import agentIdentity from "../main/agent-identity.js";
const { decideAgentAction } = agentIdentity;

const OURS = "C:\\Users\\me\\AppData\\Roaming\\artemis\\chats";
const FOREIGN = "D:\\artemis\\ai-agent\\.data\\chats";

test("an agent reading our own data folder is reused", () => {
    assert.equal(
        decideAgentAction({ healthyAgain: true, theirDataRoot: OURS, ourDataRoot: OURS }),
        "reuse"
    );
});

test("an agent reading a different data folder is replaced, never reused", () => {
    assert.equal(
        decideAgentAction({ healthyAgain: true, theirDataRoot: FOREIGN, ourDataRoot: OURS }),
        "replace"
    );
});

test("an agent that does not report a data folder counts as foreign", () => {
    // A pre-existing agent build that predates the dataRoot report cannot be
    // identified, and the data on disk is safe either way: replace it.
    assert.equal(
        decideAgentAction({ healthyAgain: true, theirDataRoot: null, ourDataRoot: OURS }),
        "replace"
    );
});

test("an agent that died between the probes means spawn, whatever it read", () => {
    assert.equal(
        decideAgentAction({ healthyAgain: false, theirDataRoot: OURS, ourDataRoot: OURS }),
        "spawn"
    );
    assert.equal(
        decideAgentAction({ healthyAgain: false, theirDataRoot: FOREIGN, ourDataRoot: OURS }),
        "spawn"
    );
});

/* ------------------------------------------------------------------ */
/* the async wiring the decision feeds into                            */
/* ------------------------------------------------------------------ */

test("server.js reports its data root and can be asked to shut down", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, "../ai-agent/server.js"), "utf8");

    assert.match(source, /dataRoot: resolveChatsRoot\(\)/, "health does not identify the data folder");
    assert.match(source, /app\.post\("\/api\/shutdown"/, "a foreign agent cannot be asked to leave");
    assert.match(source, /shutdown\("Shutdown request"\)/, "the shutdown route does not shut the agent down");
});

test("ai-server.js identifies the running agent before reusing the port", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, "../main/ai-server.js"), "utf8");

    assert.match(source, /decideAgentAction/, "the port is reused without checking who is on it");
    assert.match(source, /path\.join\(app\.getPath\('userData'\), 'chats'\)/, "our own chats folder is not compared");
    assert.match(source, /\/api\/shutdown/, "a foreign agent is not asked to leave");
    assert.match(source, /ARTEMIS_DATA_DIR: app\.getPath\('userData'\)/, "the spawned agent loses its data folder");
    assert.match(source, /async function waitForAgent\(timeoutMs = 45000\)/, "the startup wait is too short for a cold start");
});
