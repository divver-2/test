const { Pool } = require('pg');

const FOLLOWUP_DAYS = 30;

let pool;
let initialized = false;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const isInternal = url.includes('.railway.internal') || url.includes('localhost') || url.includes('127.0.0.1');
    pool = new Pool({ connectionString: url, ssl: isInternal ? false : { rejectUnauthorized: false } });
  }
  return pool;
}

async function init() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS outreach (
      domain TEXT NOT NULL,
      user_email TEXT NOT NULL DEFAULT 'shared',
      ceo_name TEXT,
      ceo_email TEXT,
      company_name TEXT,
      industry TEXT,
      description TEXT,
      sent_at TIMESTAMPTZ,
      follow_up_sent_at TIMESTAMPTZ,
      follow_up_count INT DEFAULT 0,
      org_id TEXT,
      priority_field_value_id TEXT,
      connected_option_id TEXT,
      priority_context JSONB,
      learned_at TIMESTAMPTZ,
      PRIMARY KEY (domain, user_email)
    )
  `);
  await db.query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS follow_up_count INT DEFAULT 0`);
}

async function ensureInit() {
  if (initialized) return;
  try { await init(); initialized = true; } catch(e) { console.error('[tracker] DB init error:', e.message || e.code || String(e)); }
}

async function logOutreach(domain, userEmail, { ceoName, ceoEmail, companyName, industry, description }) {
  if (!domain) return;
  const ue = userEmail || 'shared';
  await ensureInit();
  const db = getPool();
  await db.query(`
    INSERT INTO outreach (domain, user_email, ceo_name, ceo_email, company_name, industry, description, sent_at, follow_up_sent_at, follow_up_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NULL,0)
    ON CONFLICT (domain, user_email) DO UPDATE SET
      ceo_name=EXCLUDED.ceo_name, ceo_email=EXCLUDED.ceo_email,
      company_name=EXCLUDED.company_name, industry=EXCLUDED.industry,
      description=EXCLUDED.description, sent_at=NOW(), follow_up_sent_at=NULL, follow_up_count=0
  `, [domain.toLowerCase(), ue, ceoName||null, ceoEmail||null, companyName||null, industry||null, description||null]);
}

// Affinity tracking — shared across users (uses '_system' slot)
async function saveTracking(domain, { priorityFieldValueId, connectedOptionId, orgId, priorityContext }) {
  if (!domain || !priorityFieldValueId || !connectedOptionId) return;
  await ensureInit();
  const db = getPool();
  await db.query(`
    INSERT INTO outreach (domain, user_email, priority_field_value_id, connected_option_id, org_id, priority_context)
    VALUES ($1,'_system',$2,$3,$4,$5)
    ON CONFLICT (domain, user_email) DO UPDATE SET
      priority_field_value_id=EXCLUDED.priority_field_value_id,
      connected_option_id=EXCLUDED.connected_option_id,
      org_id=EXCLUDED.org_id,
      priority_context=EXCLUDED.priority_context
  `, [domain.toLowerCase(), priorityFieldValueId, connectedOptionId, orgId||null, priorityContext ? JSON.stringify(priorityContext) : null]);
}

// Cache org ID — shared across users
async function learnOrgId(domain, orgId) {
  if (!domain || !orgId) return;
  await ensureInit();
  const db = getPool();
  await db.query(`
    INSERT INTO outreach (domain, user_email, org_id, learned_at)
    VALUES ($1,'_system',$2,NOW())
    ON CONFLICT (domain, user_email) DO UPDATE SET org_id=EXCLUDED.org_id, learned_at=NOW()
  `, [domain.toLowerCase(), orgId]);
  console.log(`[tracker] Learned Affinity org mapping: ${domain} → ${orgId}`);
}

async function getCachedOrgId(domain) {
  if (!domain) return null;
  await ensureInit();
  const db = getPool();
  const { rows } = await db.query('SELECT org_id FROM outreach WHERE domain=$1 AND org_id IS NOT NULL LIMIT 1', [domain.toLowerCase()]);
  return rows[0]?.org_id || null;
}

async function getTracking(domain) {
  if (!domain) return null;
  await ensureInit();
  const db = getPool();
  const { rows } = await db.query("SELECT * FROM outreach WHERE domain=$1 AND user_email='_system'", [domain.toLowerCase()]);
  return rows[0] ? rowToObj(rows[0]) : null;
}

async function markFollowUpSent(domain, userEmail) {
  if (!domain) return;
  const ue = userEmail || 'shared';
  await ensureInit();
  const db = getPool();
  await db.query('UPDATE outreach SET follow_up_sent_at=NOW(), follow_up_count=COALESCE(follow_up_count,0)+1 WHERE domain=$1 AND user_email=$2', [domain.toLowerCase(), ue]);
}

async function getFollowUpsDue(userEmail) {
  const ue = userEmail || 'shared';
  await ensureInit();
  const db = getPool();
  const cutoff = new Date(Date.now() - FOLLOWUP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await db.query(
    'SELECT * FROM outreach WHERE user_email=$1 AND sent_at IS NOT NULL AND follow_up_sent_at IS NULL AND sent_at <= $2 ORDER BY sent_at ASC',
    [ue, cutoff]
  );
  return rows.map(rowToObj);
}

async function getAllOutreach(userEmail) {
  const ue = userEmail || 'shared';
  await ensureInit();
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM outreach WHERE user_email=$1 AND sent_at IS NOT NULL ORDER BY sent_at DESC', [ue]);
  return rows.map(rowToObj);
}

async function deleteOutreach(domain, userEmail) {
  if (!domain) return;
  const ue = userEmail || 'shared';
  await ensureInit();
  const db = getPool();
  await db.query('DELETE FROM outreach WHERE domain=$1 AND user_email=$2', [domain.toLowerCase(), ue]);
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
    followUpCount: r.follow_up_count || 0,
    orgId: r.org_id,
    priorityFieldValueId: r.priority_field_value_id,
    connectedOptionId: r.connected_option_id,
    priorityContext: r.priority_context,
  };
}

module.exports = { saveTracking, getTracking, learnOrgId, getCachedOrgId, logOutreach, markFollowUpSent, getFollowUpsDue, getAllOutreach, deleteOutreach };
