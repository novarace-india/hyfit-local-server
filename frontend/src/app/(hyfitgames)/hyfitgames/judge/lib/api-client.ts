const API_BASE = '/api/hyfit-judge';

async function request(path: string, options: RequestInit = {}) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  // Auth
  login: (staffId: string, pin: string, deviceLabel?: string) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ staffId, pin, deviceLabel }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  session: () => request('/auth/session'),

  // Admin
  overview: (eventId?: string) => request(`/admin/overview${eventId ? `?eventId=${eventId}` : ''}`),
  events: () => request('/admin/events'),
  createEvent: (data: any) => request('/admin/events', { method: 'POST', body: JSON.stringify(data) }),
  updateEvent: (data: any) => request('/admin/events', { method: 'PATCH', body: JSON.stringify(data) }),
  users: () => request('/admin/users'),
  createUser: (data: any) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (data: any) => request('/admin/users', { method: 'PATCH', body: JSON.stringify(data) }),
  config: (eventId?: string) => request(`/admin/config${eventId ? `?eventId=${eventId}` : ''}`),
  saveConfig: (data: any) => request('/admin/config', { method: 'PUT', body: JSON.stringify(data) }),
  publishConfig: (data: any) => request('/admin/config', { method: 'POST', body: JSON.stringify(data) }),
  syncRuns: () => request('/admin/participants/sync'),

  // Check-in. Its state lives in RaceResult, not here, so there is no station,
  // exception or transaction-status route to call.
  participant: (bib: string) => request(`/checkin/participant?bib=${bib}`),
  participantByWristband: (wristband: string) => request(`/checkin/participant?wristband=${encodeURIComponent(wristband)}`),
  checkinContext: () => request('/checkin/context'),
  completeStage: (data: any) => request('/checkin/stage', { method: 'POST', body: JSON.stringify(data) }),

  // Judge. The race runs on the tablet and is stored nowhere, so there is no
  // claim, no release, no per-tap timing route and nothing to export: find the
  // athlete, then hand in the finished race.
  resolve: (code: string) => request(`/judge/resolve?code=${code}`),
  submitRace: (data: any) => request('/judge/results', { method: 'POST', body: JSON.stringify(data) }),

  // Participants
  participants: () => request('/participants'),
};
