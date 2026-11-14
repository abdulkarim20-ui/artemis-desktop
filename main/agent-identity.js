/**
 * ============================================================================
 * AGENT IDENTITY (main/agent-identity.js)
 * ============================================================================
 * Decides what to do with an agent that is ALREADY listening on the port when
 * the app starts. Pure and dependency-free, so it is unit-testable without
 * Electron (main/ai-server.js only wires the async probes around it).
 *
 *   'reuse'   the running agent reads the same data folder this app would use.
 *             A quick restart of the same app: its chats are ours, keep it.
 *   'spawn'   the first probe caught the previous session's agent still
 *             dying, and it is gone now. Start a fresh one.
 *   'replace' the running agent reads a DIFFERENT data folder - typically a
 *             standalone dev agent started without ARTEMIS_DATA_DIR. It would
 *             show an empty history and file new chats where the app can
 *             never see them, which looks like "older chats disappeared".
 *             It has to go; the app starts its own agent on the real folder.
 * ============================================================================
 */

/**
 * @param {object} params
 * @param {boolean} params.healthyAgain  the agent was still healthy a moment after the first probe
 * @param {string} [params.theirDataRoot]  chats folder the running agent reports
 * @param {string} [params.ourDataRoot]  chats folder this app would use
 * @returns {'reuse'|'spawn'|'replace'}
 */
function decideAgentAction({ healthyAgain, theirDataRoot, ourDataRoot }) {
    if (!healthyAgain) return 'spawn';
    return theirDataRoot === ourDataRoot ? 'reuse' : 'replace';
}

module.exports = { decideAgentAction };
