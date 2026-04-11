/**
 * Lightweight accessor for the global agent singleton.
 * Used by services that don't have a direct agent reference
 * (e.g., crypto strategies) to access agent-level services like P2P.
 */
let _agent = null;

export function setGlobalAgent(agent) {
  _agent = agent;
}

export function getGlobalAgent() {
  return _agent;
}
