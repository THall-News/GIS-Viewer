// Network transport for the headless copilot. No DOM, map, or application
// state is accessed here; callers provide the workspace snapshot.
async function jsonRequest(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

export const createSession = (prompt, workspace, runImmediately = false, mode = 'auto', conversation = []) => jsonRequest('/api/headless/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, runImmediately, workspace, mode, conversation })
});

export const planPrompt = (prompt, workspace, mode = 'auto', conversation = []) => jsonRequest('/api/headless/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, workspace, mode, conversation })
});

export const assistantTurn = (payload = {}) => jsonRequest('/api/headless/assistant/turn', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

export const catalogSearch = (query, options = {}) => jsonRequest('/api/catalog/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...options }),
});

export const getSession = sessionId => jsonRequest(`/api/headless/sessions/${encodeURIComponent(sessionId)}`);
export const listSessions = async () => (await jsonRequest('/api/headless/sessions')).sessions || [];

export const executeAction = (type, payload, { confirmed = false, planHash = null } = {}) => jsonRequest('/api/headless/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload, confirmed, planHash })
});
