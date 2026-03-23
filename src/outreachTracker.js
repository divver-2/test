// Persists domain → Affinity IDs so the Apollo reply webhook can update status
const fs = require('fs');
const path = require('path');

const TRACKER_FILE = path.join(__dirname, '../data/outreach-tracker.json');

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
function saveTracking(domain, { priorityFieldValueId, connectedOptionId, orgId }) {
  if (!domain || !priorityFieldValueId || !connectedOptionId) return;
  const data = load();
  data[domain.toLowerCase()] = { priorityFieldValueId, connectedOptionId, orgId, savedAt: new Date().toISOString() };
  save(data);
}

// Get stored Affinity IDs for a domain
function getTracking(domain) {
  if (!domain) return null;
  const data = load();
  return data[domain.toLowerCase()] || null;
}

module.exports = { saveTracking, getTracking };
