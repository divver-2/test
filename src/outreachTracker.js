const { Pool } = require('pg');

const FOLLOWUP_DAYS = 30;

let pool;
function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // Railway internal URLs (.railway.internal) don't use SSL; external URLs do
    const isInternal = url.includes('.railway.internal') || url.includes('localhost') || url.includes('127.0.0.1');
    pool = new Pool({ connectionString: url, ssl: isInternal ? false : { rejectUnauthorized: false } });
  }
  return pool;
}

async function init() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS outreach (
      domain TEXT PRIMARY KEY,
      ceo_name TEXT,
      ceo_email TEXT,
      company_name TEXT,
      industry TEXT,
      description TEXT,
      sent_at TIMESTAMPTZ,
      follow_up_sent_at TIMESTAMPTZ,
      org_id TEXT,
      priority_field_value_id TEXT,
      connected_option_id TEXT,
      priority_context JSONB,
      learned_at TIMESTAMPTZ
    )
  `);
}

async function ensureInit() {
  try { await init(); } catch(e) { console.error('[tracker] DB init error:', e.message || e.code || String(e)); }
}

// Log an outreach send
async function logOutreach(domain, { ceoName, ceoEmail, companyName, industry, description }) {
  if (!domain) return;
  await ensureInit();
  const db = getPool();
  await db.query(`
    INSERT INTO outreach (domain, ceo_name, ceo_email, company_name, industry, description, sent_at, follow_up_sent_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW(),NULL)
    ON CONFLICT (domain) DO UPDATE SET
      ceo_name=EXCLUDED.ceo_name, ceo_email=EXCLUDED.ceo_email,
      company_name=EXCLUDED.company_name, industry=EXCLUDED.industry,
      description=EXCLUDED.description, sent_at=NOW(), follow_up_sent_at=NULL
  `, [domain.toLowerCase(), ceoName||null, ceoEmail||null, companyName||null, industry||null, description||null]);
}

// Save Affinity IDs for a domain
async function saveTracking(domain, { priorityFieldValueId, connectedOptionId, orgId, priorityContext }) {
  if (!domain || !priorityFieldValueId || !connectedOptionId) return;
  await ensureInit();
  const db = getPool();
  await db.query(`
    INSERT INTO outreach (domain, priority_field_value_id, connected_option_id, org_id, priority_context)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (domain) DO UPDATE SET
      priority_field_value_id=EXCLUDED.priority_field_value_id,
      connected_option_id=EXCLUDED.connected_option_id,
      org_id=EXCLUDED.org_id,
      priority_context=EXCLUDED.priority_context
  `, [domain.toLowerCase(), priorityFieldValueId, connectedOptionId, orgId||null, priorityContext ? JSON.stringify(priorityContext) : null]);
}

// Cache org ID
async function learnOrgId(domain, orgId) {
  if (!domain || !orgId) return;
  await ensureInit();
  const db = getPool();
  await db.query(`
    INSERT INTO outreach (domain, org_id, learned_at)
    VALUES ($1,$2,NOW())
    ON CONFLICT (domain) DO UPDATE SET org_id=EXCLUDED.org_id, learned_at=NOW()
  `, [domain.toLowerCase(), orgId]);
  console.log(`[tracker] Learned Affinity org mapping: ${domain} → ${orgId}`);
}

async function getCachedOrgId(domain) {
  if (!domain) return null;
  const row = await getTracking(domain);
  return row?.orgId || null;
}

async function getTracking(domain) {
  if (!domain) return null;
  await ensureInit();
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM outreach WHERE domain=$1', [domain.toLowerCase()]);
  return rows[0] ? rowToObj(rows[0]) : null;
}

async function markFollowUpSent(domain) {
  if (!domain) return;
  await ensureInit();
  const db = getPool();
  await db.query('UPDATE outreach SET follow_up_sent_at=NOW() WHERE domain=$1', [domain.toLowerCase()]);
}

async function getFollowUpsDue() {
  await ensureInit();
  const db = getPool();
  const cutoff = new Date(Date.now() - FOLLOWUP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await db.query(
    'SELECT * FROM outreach WHERE sent_at IS NOT NULL AND follow_up_sent_at IS NULL AND sent_at <= $1 ORDER BY sent_at ASC',
    [cutoff]
  );
  return rows.map(rowToObj);
}

async function getAllOutreach() {
  await ensureInit();
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM outreach WHERE sent_at IS NOT NULL ORDER BY sent_at DESC');
  return rows.map(rowToObj);
}

async function deleteOutreach(domain) {
  if (!domain) return;
  await ensureInit();
  const db = getPool();
  await db.query('DELETE FROM outreach WHERE domain=$1', [domain.toLowerCase()]);
}

function rowToObj(r) {
  return {
    domain: r.domain,
    ceoName: r.ceo_name,
    ceoEmail: r.ceo_email,
    companyName: r.company_name,
    industry: r.industry,
    description: r.description,
    sentAt: r.sent_at,
    followUpSentAt: r.follow_up_sent_at,
    orgId: r.org_id,
    priorityFieldValueId: r.priority_field_value_id,
    connectedOptionId: r.connected_option_id,
    priorityContext: r.priority_context,
  };
}

module.exports = { saveTracking, getTracking, learnOrgId, getCachedOrgId, logOutreach, markFollowUpSent, getFollowUpsDue, getAllOutreach, deleteOutreach };
