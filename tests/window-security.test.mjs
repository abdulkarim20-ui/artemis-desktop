/**
 * ============================================================================
 * WINDOW / IPC SECURITY TESTS
 * ============================================================================
 * The renderer can reveal a saved API key. A link in model output must never
 * be able to turn a remote page into that renderer:
 *
 *   - target="_blank" links open in the user's browser, never a child window;
 *   - the app window cannot navigate away from renderer/index.html;
 *   - keys:* IPC rejects any frame that is not the main renderer.
 *
 * The agent API itself gets a per-launch token because any local web page can
 * POST to 127.0.0.1 without CORS permission, and CORS cannot distinguish this
 * file:// page from a sandboxed iframe (both send Origin: null).
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import rendererUrl from "../main/renderer-url.js";

const { RENDERER_INDEX, isRendererUrl, isTrustedIpcSender } = rendererUrl;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const INDEX_URL = pathToFileURL(RENDERER_INDEX).href;

test("only the real renderer file is a trusted URL", () => {
    assert.equal(isRendererUrl(INDEX_URL), true);
    assert.equal(isRendererUrl(`${INDEX_URL}?view=chat#message-1`), true);

    assert.equal(isRendererUrl("https://example.com/renderer/index.html"), false);
    assert.equal(isRendererUrl("file:///C:/Windows/System32/drivers/etc/hosts"), false);
    assert.equal(isRendererUrl(`${INDEX_URL}.bak`), false);
    assert.equal(isRendererUrl("file://server/share/renderer/index.html"), false);
    assert.equal(isRendererUrl("javascript:alert(1)"), false);
    assert.equal(isRendererUrl(""), false);
    assert.equal(isRendererUrl(null), false);
});

test("trusted IPC means the main frame of the real renderer", () => {
    const mainFrame = { url: INDEX_URL };
    const sender = { mainFrame };

    assert.equal(isTrustedIpcSender({ sender, senderFrame: mainFrame }), true);

    // Same file inside an iframe is still not the top frame.
    assert.equal(
        isTrustedIpcSender({ sender, senderFrame: { url: INDEX_URL } }),
        false
    );
    assert.equal(
        isTrustedIpcSender({ sender, senderFrame: { url: "https://example.com" } }),
        false
    );
    assert.equal(isTrustedIpcSender({ sender, senderFrame: null }), false);
    assert.equal(isTrustedIpcSender({}), false);
});

test("the window denies child windows and foreign navigation", async () => {
    const source = await fs.readFile(path.join(ROOT, "main/window.js"), "utf8");

    assert.match(source, /setWindowOpenHandler/, "target=_blank can still create a child window");
    assert.match(source, /action:\s*'deny'/, "the window-open handler does not deny the child");
    assert.match(source, /shell\.openExternal/, "external links are not handed to the browser");
    assert.match(source, /protocol === 'https:'/, "non-HTTPS URLs can reach the OS handler");
    assert.match(source, /will-navigate/, "the app window can navigate to a remote page");
    assert.match(source, /will-redirect/, "a redirect can move the app window");
    assert.match(source, /isRendererUrl\(url\)/, "navigation is not compared with the renderer URL");
});

test("every keys:* handler checks its sender", async () => {
    const source = await fs.readFile(path.join(ROOT, "main/api-keys-ipc.js"), "utf8");

    assert.match(source, /isTrustedIpcSender/, "IPC does not identify the calling frame");

    for (const channel of ["keys:status", "keys:reveal", "keys:save", "keys:clear", "keys:open-help"]) {
        const registration = new RegExp(
            `ipcMain\\.handle\\('${channel}',\\s*trusted\\('${channel}'`
        );
        assert.match(source, registration, `${channel} is registered without a sender check`);
    }
});

test("every /api request requires the per-launch token", async () => {
    const serverSource = await fs.readFile(path.join(ROOT, "ai-agent/server.js"), "utf8");
    const mainSource = await fs.readFile(path.join(ROOT, "main/ai-server.js"), "utf8");

    assert.match(serverSource, /ARTEMIS_API_TOKEN/, "the agent cannot receive a token");
    assert.match(serverSource, /app\.use\("\/api"/, "there is no auth middleware in front of the routes");
    assert.match(serverSource, /x-artemis-token/, "the agent does not read the token header");
    assert.match(serverSource, /timingSafeEqual/, "the token is compared with a timing-safe check");
    assert.match(mainSource, /x-artemis-token/, "Electron never sends the token");
    assert.match(
        mainSource,
        /ARTEMIS_API_TOKEN: AGENT_TOKEN/,
        "the spawned agent is not given the token"
    );
    assert.match(mainSource, /module\.exports[\s\S]*AGENT_TOKEN/, "the renderer config cannot read the token");
});

test("the packaged agent is spawned from a real working directory", async () => {
    const mainSource = await fs.readFile(path.join(ROOT, "main/ai-server.js"), "utf8");

    // app.getAppPath() is inside app.asar when packaged; spawn() treats that as
    // a missing cwd and fails with ENOENT even though the executable exists.
    assert.match(mainSource, /app\.isPackaged \? process\.resourcesPath : agentDir/);
    assert.match(mainSource, /cwd: agentCwd/);
});

test("the renderer learns the configured agent port and token", async () => {
    const preload = await fs.readFile(path.join(ROOT, "preload/preload.js"), "utf8");
    const main = await fs.readFile(path.join(ROOT, "main/ai-server.js"), "utf8");
    const ipc = await fs.readFile(path.join(ROOT, "main/ipc.js"), "utf8");
    const client = await fs.readFile(path.join(ROOT, "renderer/js/ai/ai-client.js"), "utf8");
    const auth = await fs.readFile(path.join(ROOT, "renderer/js/agent-auth.js"), "utf8");
    const html = await fs.readFile(path.join(ROOT, "renderer/index.html"), "utf8");

    assert.match(main, /ARTEMIS_PORT/, "the main process ignores ARTEMIS_PORT");
    assert.match(preload, /app:config/, "the preload bridge never asks for the port");
    assert.match(preload, /appConfig/, "the renderer has no way to read the port");
    assert.match(preload, /apiToken/, "the preload bridge never exposes the token");
    assert.match(ipc, /apiToken:\s*AGENT_TOKEN/, "app:config does not include the token");
    assert.match(client, /appConfig\?\.agentPort/, "the AI client still hardcodes 3000");
    assert.match(html, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/, "the CSP only allows port 3000");
    assert.match(auth, /x-artemis-token/, "the fetch wrapper never sends the token");
    assert.match(auth, /127\.0\.0\.1/, "the token could be attached to a non-loopback request");

    const authIndex = html.indexOf("js/agent-auth.js");
    const appIndex = html.indexOf("js/app.js");
    assert.notEqual(authIndex, -1, "the auth wrapper is not loaded");
    assert.ok(authIndex < appIndex, "the auth wrapper loads after the clients it patches");
});

/* ------------------------------------------------------------------ */
/* real request: unauthenticated shutdown is refused, token works      */
/* ------------------------------------------------------------------ */

const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

const request = (port, { path: requestPath = "/api/shutdown", method = "POST", token } = {}) =>
    new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: requestPath,
                method,
                timeout: 2000,
                headers: token ? { "x-artemis-token": token } : {},
            },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => resolve({ status: res.statusCode, body }));
            }
        );
        req.on("timeout", () => req.destroy(new Error(`${requestPath} request timed out`)));
        req.on("error", reject);
        req.end();
    });

const requestJson = async (port, options) => {
    const response = await request(port, options);
    try {
        return { ...response, data: JSON.parse(response.body) };
    } catch {
        return { ...response, data: null };
    }
};

const waitForHealth = async (port, deadline) => {
    while (Date.now() < deadline) {
        try {
            const ok = await new Promise((resolve) => {
                const req = http.get(
                    { host: "127.0.0.1", port, path: "/api/health", timeout: 500 },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode === 200);
                    }
                );
                req.on("timeout", () => { req.destroy(); resolve(false); });
                req.on("error", () => resolve(false));
            });
            if (ok) return true;
        } catch {
            // keep waiting
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
};

test("a local page cannot use the agent without the token", async (t) => {
    const port = await freePort();
    const token = "test-agent-token";
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "artemis-shutdown-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

    const child = spawn(process.execPath, [
        "--disable-warning=DEP0040",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        path.join(ROOT, "ai-agent/server.js"),
    ], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            ARTEMIS_DATA_DIR: dataDir,
            ARTEMIS_RAG_DISABLED: "1",
            ARTEMIS_API_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });

    t.after(() => {
        if (child.exitCode === null) child.kill();
    });

    assert.equal(
        await waitForHealth(port, Date.now() + 15000),
        true,
        `the agent did not start:\n${output}`
    );

    // Liveness stays public, but the data-folder fingerprint needs the token.
    const openHealth = await requestJson(port, { path: "/api/health", method: "GET" });
    assert.equal(openHealth.status, 200, "the health probe should stay available");
    assert.equal(openHealth.data?.dataRoot, undefined, "health leaked the data folder");

    const trustedHealth = await requestJson(port, { path: "/api/health", method: "GET", token });
    assert.equal(trustedHealth.status, 200);
    assert.equal(typeof trustedHealth.data?.dataRoot, "string", "the main process cannot identify the agent");

    assert.equal(
        (await request(port, { path: "/api/models", method: "GET" })).status,
        401,
        "the model registry was readable without the token"
    );
    assert.equal(
        (await request(port, { path: "/api/models", method: "GET", token: "wrong-token" })).status,
        401,
        "a wrong token was accepted"
    );
    assert.equal(
        (await request(port, { path: "/api/models", method: "GET", token })).status,
        200,
        "the real token was refused"
    );

    assert.equal((await request(port)).status, 403, "an unauthenticated POST shut the agent down");
    assert.equal((await request(port, { token: "wrong-token" })).status, 403, "a wrong token was accepted");
    assert.equal((await request(port, { token })).status, 200, "the real token was refused");

    await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(resolve, 4000).unref();
    });
    assert.notEqual(child.exitCode, null, "the agent did not exit after the authenticated shutdown");
});
