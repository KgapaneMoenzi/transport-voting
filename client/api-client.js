// Drop-in replacement for the window.storage-based data layer in the original
// transport-voting.html. Include this file before your existing <script>, set
// API_BASE below, and replace the functions listed in README.md with the
// equivalents here (see the mapping table in README.md).

const API_BASE = 'https://YOUR-BACKEND-URL.example.com/api'; // <-- change this

let authToken = localStorage.getItem('tb_token') || null; // OK here: this runs in the browser, not an Artifact

function setToken(token) {
  authToken = token;
  if (token) localStorage.setItem('tb_token', token);
  else localStorage.removeItem('tb_token');
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

// ---- Auth ----
async function apiSignup(studentId, username, password) {
  const data = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ studentId, username, password }) });
  setToken(data.token);
  return data;
}
async function apiLogin(studentId, password) {
  const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ studentId, password }) });
  setToken(data.token);
  return data;
}
async function apiAdminLogin(password) {
  const data = await api('/auth/admin-login', { method: 'POST', body: JSON.stringify({ password }) });
  setToken(data.token);
  return data;
}
function apiLogout() { setToken(null); }

// ---- Slots ----
async function apiGetSlots() { return api('/slots'); }
async function apiCreateSlot(direction, time, capacity) {
  return api('/slots', { method: 'POST', body: JSON.stringify({ direction, time, capacity }) });
}
async function apiUpdateSlot(id, fields) {
  return api(`/slots/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
}
async function apiDeleteSlot(id) { return api(`/slots/${id}`, { method: 'DELETE' }); }

// ---- Votes ----
async function apiMyVotes() { return api('/votes/mine'); }
async function apiAllVotes() { return api('/votes'); } // admin only
async function apiRidersFor(slotId) { return api(`/votes/slot/${slotId}`); }
async function apiBookSlot(direction, slotId) {
  return api('/votes', { method: 'POST', body: JSON.stringify({ direction, slotId }) });
}
async function apiClearAllVotes() { return api('/votes', { method: 'DELETE' }); } // admin only

// ---- Change requests ----
async function apiSubmitChangeRequest(direction, imageDataUrl, note) {
  return api('/change-requests', { method: 'POST', body: JSON.stringify({ direction, imageDataUrl, note }) });
}
async function apiMyChangeRequests() { return api('/change-requests/mine'); }
async function apiAllChangeRequests() { return api('/change-requests'); } // admin only
async function apiApproveChangeRequest(id) { return api(`/change-requests/${id}/approve`, { method: 'POST' }); }
async function apiRejectChangeRequest(id) { return api(`/change-requests/${id}/reject`, { method: 'POST' }); }
