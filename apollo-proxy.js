/**
 * Apollo MCP Proxy — runs on port 3001
 * Queues lookup requests so Claude can service them via MCP tools.
 *
 * Endpoints used by the main server (apollo.js):
 *   POST /v1/organizations/enrich
 *   POST /v1/mixed_people/search
 *   POST /v1/people/match
 *
 * Endpoints used by Claude to service the queue:
 *   GET  /queue            — list pending requests
 *   POST /fulfill/:id      — post result for a request
 */

const express = require('express');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

// In-memory queue: id → { id, type, payload, resolve, reject, timer }
const pending = new Map();

const TIMEOUT_MS = 60_000; // 60 seconds to wait for Claude to fulfill

function enqueue(type, payload) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP lookup timed out (${type}). Make sure the proxy worker is running.`));
    }, TIMEOUT_MS);

    pending.set(id, { id, type, payload, createdAt: Date.now(), resolve, reject, timer });
    console.log(`[proxy] queued ${type} request ${id.slice(0, 8)}`);
  });
}

// ── Apollo-compatible endpoints ────────────────────────────────────────────────

app.post('/v1/organizations/enrich', async (req, res) => {
  try {
    const result = await enqueue('org_enrich', req.body);
    res.json(result);
  } catch (e) {
    res.status(504).json({ error: e.message });
  }
});

app.post('/v1/mixed_people/search', async (req, res) => {
  try {
    const result = await enqueue('ceo_search', req.body);
    res.json(result);
  } catch (e) {
    res.status(504).json({ error: e.message });
  }
});

app.post('/v1/people/match', async (req, res) => {
  try {
    const result = await enqueue('people_match', req.body);
    res.json(result);
  } catch (e) {
    res.status(504).json({ error: e.message });
  }
});

// Stub endpoints (not needed for CEO lookup flow)
app.post('/v1/contacts/search', (_, res) => res.json({ contacts: [] }));
app.post('/v1/contacts', (_, res) => res.json({ contact: null }));
app.post('/v1/accounts', (_, res) => res.json({ account: null }));
app.get('/v1/email_accounts', (_, res) => res.json({ email_accounts: [] }));
app.get('/v1/emailer_campaigns/search', (_, res) => res.json({ emailer_campaigns: [] }));
app.post('/v1/emailer_campaigns', (_, res) => res.json({ emailer_campaign: { id: 'mock', name: 'mock' } }));
app.post('/v1/mixed_companies/search', async (req, res) => {
  try {
    const result = await enqueue('company_search', req.body);
    res.json(result);
  } catch (e) {
    res.status(504).json({ error: e.message });
  }
});

// ── Claude worker endpoints ────────────────────────────────────────────────────

// List pending requests for Claude to service
app.get('/queue', (_, res) => {
  const items = [...pending.values()].map(({ id, type, payload, createdAt }) => ({
    id, type, payload, createdAt,
  }));
  res.json(items);
});

// Claude posts the result for a specific request
app.post('/fulfill/:id', (req, res) => {
  const entry = pending.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Request not found or already fulfilled' });
  clearTimeout(entry.timer);
  pending.delete(req.params.id);
  entry.resolve(req.body);
  console.log(`[proxy] fulfilled ${entry.type} request ${req.params.id.slice(0, 8)}`);
  res.json({ ok: true });
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true, pending: pending.size }));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\nApollo MCP proxy running on http://localhost:${PORT}`);
  console.log('Waiting for Claude to service requests via /queue + /fulfill/:id\n');
});
