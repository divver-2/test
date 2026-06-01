// Persists domain → outreach records, Affinity IDs, and follow-up state
const fs = require('fs');
const path = require('path');

const TRACKER_FILE = path.join(__dirname, '../data/outreach-tracker.json');
const FOLLOWUP_DAYS = 30;

function load() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[outreachTracker] Failed to read tracker file:', e.message);
  }
  return {};
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(TRACKER_FILE), { recursive: true });
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[outreachTracker] Failed to write tracker file:', e.message);
  }
}

// Save Affinity IDs for a domain so we can look them up on reply
function saveTracking(domain, { priorityFieldValueId, connectedOptionId, orgId, priorityContext }) {
  if (!domain || !priorityFieldValueId || !connectedOptionId) return;
  const data = load();
  const key = domain.toLowerCase();
  data[key] = { ...( data[key] || {}), priorityFieldValueId, connectedOptionId, orgId, priorityContext: priorityContext || null, savedAt: new Date().toISOString() };
  save(data);
}

// Log an outreach send — stores CEO + company info and timestamp for follow-up tracking
function logOutreach(domain, { ceoName, ceoEmail, companyName, industry, description }) {
  if (!domain) return;
  const data = load();
  const key = domain.toLowerCase();
  data[key] = {
    ...(data[key] || {}),
    ceoName: ceoName || null,
    ceoEmail: ceoEmail || null,
    companyName: companyName || domain,
    industry: industry || null,
    description: description || null,
    sentAt: new Date().toISOString(),
    followUpSentAt: null,
  };
  save(data);
}

// Mark that a follow-up was sent for a domain
function markFollowUpSent(domain) {
  if (!domain) return;
  const data = load();
  const key = domain.toLowerCase();
  if (data[key]) {
    data[key].followUpSentAt = new Date().toISOString();
    save(data);
  }
}

// Return all records where outreach was sent 30+ days ago and no follow-up yet
function getFollowUpsDue() {
  const data = load();
  const cutoff = Date.now() - FOLLOWUP_DAYS * 24 * 60 * 60 * 1000;
  return Object.entries(data)
    .filter(([, v]) => v.sentAt && !v.followUpSentAt && new Date(v.sentAt).getTime() <= cutoff)
    .map(([domain, v]) => ({ domain, ...v }))
    .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
}

// Get stored Affinity IDs for a domain
function getTracking(domain) {
  if (!domain) return null;
  const data = load();
  return data[domain.toLowerCase()] || null;
}

// Cache a confirmed domain → Affinity org ID mapping so future lookups skip the search
function learnOrgId(domain, orgId) {
  if (!domain || !orgId) return;
  const data = load();
  const key = domain.toLowerCase();
  if (data[key]?.orgId === orgId) return;
  data[key] = { ...(data[key] || {}), orgId, learnedAt: new Date().toISOString() };
  save(data);
  console.log(`[tracker] Learned Affinity org mapping: ${domain} → ${orgId}`);
}

// Get cached org ID for a domain (learned from prior launches)
function getCachedOrgId(domain) {
  if (!domain) return null;
  return getTracking(domain)?.orgId || null;
}

module.exports = { saveTracking, getTracking, learnOrgId, getCachedOrgId, logOutreach, markFollowUpSent, getFollowUpsDue };
