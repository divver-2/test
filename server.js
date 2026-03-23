require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { runOutreachSequence, runOutreachByCompany, launchEmailOutreach } = require('./src/sequenceManager');
const { buildEmailSequence } = require('./src/emailGenerator');
const apollo = require('./src/apollo');
const affinity = require('./src/affinity');
const tracker = require('./src/outreachTracker');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Company/domain lookup — enrich by name or domain, find CEO, lookup Affinity
app.post('/api/company', async (req, res) => {
  const { companyName, apiKey: bodyKey } = req.body;
  if (!companyName) return res.status(400).json({ error: 'companyName is required' });

  const apiKey = bodyKey || process.env.APOLLO_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Apollo API key is required — enter it in Settings' });

  const affinityKey = req.body.affinityKey || process.env.AFFINITY_API_KEY;

  try {
    const result = await runOutreachByCompany({ companyName, apiKey, affinityKey });
    res.json(result);
  } catch (err) {
    console.error('[/api/company] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send outreach — create Apollo CRM records, build sequence with email steps, enroll contact
app.post('/api/send-outreach', async (req, res) => {
  const { companyData, ceoData, emailSequence, apiKey: bodyKey } = req.body;
  if (!ceoData?.email) return res.status(400).json({ error: 'ceoData.email is required' });

  const apiKey = bodyKey || process.env.APOLLO_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Apollo API key is required' });

  try {
    const result = await launchEmailOutreach({ companyData, ceoData, emailSequence, apiKey });
    res.json(result);
  } catch (err) {
    console.error('[/api/send-outreach] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Preview endpoint — enriches data and generates emails without touching Apollo sequences
app.post('/api/preview', async (req, res) => {
  const { email, senderName, apiKey } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const usedApiKey = apiKey || process.env.APOLLO_API_KEY;
  if (!usedApiKey) return res.status(400).json({ error: 'Apollo API key is required' });

  try {
    const domain = email.split('@')[1];
    const [contact, org, ceo] = await Promise.allSettled([
      apollo.enrichContact(email, usedApiKey),
      apollo.enrichOrganization(domain, usedApiKey),
      apollo.findCEO(domain, usedApiKey),
    ]);

    const organization = org.status === 'fulfilled' ? org.value : null;
    const ceoData = ceo.status === 'fulfilled' ? ceo.value : null;
    const contactData = contact.status === 'fulfilled' ? contact.value : null;

    const orgName = organization?.name || contactData?.organization?.name || domain;
    const ceoName = ceoData
      ? `${ceoData.first_name || ''} ${ceoData.last_name || ''}`.trim()
      : null;

    const emailSequence = buildEmailSequence({
      ceoName,
      companyName: orgName,
      industry: organization?.industry || '',
      senderName: senderName || 'Your Name',
    });

    res.json({
      success: true,
      ceo: {
        name: ceoName,
        email: ceoData?.email || ceoData?.personal_emails?.[0] || null,
        title: ceoData?.title || 'CEO',
        linkedinUrl: ceoData?.linkedin_url || null,
      },
      company: {
        name: orgName,
        domain,
        industry: organization?.industry,
        website: organization?.website_url,
        employees: organization?.num_employees,
        logo: organization?.logo_url,
      },
      emailSequence,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full launch from email — enrich, upsert CRM, create Apollo sequence
app.post('/api/launch', async (req, res) => {
  const { email, senderName, apiKey } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const usedApiKey = apiKey || process.env.APOLLO_API_KEY;
  if (!usedApiKey) return res.status(400).json({ error: 'Apollo API key is required' });

  try {
    const result = await runOutreachSequence({
      email,
      senderName: senderName || 'Your Name',
      apiKey: usedApiKey,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch company list from Affinity sourcing list (no per-company detail calls)
app.get('/api/affinity/sourcing-companies', async (req, res) => {
  const affinityKey = req.headers['x-affinity-key'] || process.env.AFFINITY_API_KEY;
  if (!affinityKey) return res.status(400).json({ error: 'Affinity API key required — add it in Settings (⚙)' });
  try {
    const result = await affinity.getSourcingListCompanies(affinityKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch owner + last email for a single company (called per-row after list loads)
app.get('/api/affinity/company-details', async (req, res) => {
  const affinityKey = req.headers['x-affinity-key'] || process.env.AFFINITY_API_KEY;
  if (!affinityKey) return res.status(400).json({ error: 'Affinity API key required' });
  const { orgId } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId is required' });
  try {
    const result = await affinity.getCompanyDetails(orgId, affinityKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark a company as Connected in Affinity
app.post('/api/affinity/mark-connected', async (req, res) => {
  const { priorityFieldValueId, connectedOptionId } = req.body;
  const affinityKey = process.env.AFFINITY_API_KEY;
  if (!affinityKey) return res.status(400).json({ error: 'Affinity API key not configured' });
  if (!priorityFieldValueId || !connectedOptionId) {
    return res.status(400).json({ error: 'priorityFieldValueId and connectedOptionId are required' });
  }
  try {
    await affinity.markConnected({ priorityFieldValueId, connectedOptionId }, affinityKey);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apollo webhook — fired when a contact replies to a sequence email
// Configure in Apollo: Settings → Webhooks → add URL: <your-host>/api/webhooks/apollo
// Event type to subscribe to: emailer_message.replied (or similar — verify in Apollo's webhook docs)
app.post('/api/webhooks/apollo', async (req, res) => {
  // Acknowledge immediately so Apollo doesn't retry
  res.json({ received: true });

  try {
    const payload = req.body;
    const eventType = payload?.event_type || payload?.type || '';
    console.log('[Apollo Webhook] event:', eventType);

    // Only act on reply events
    const isReply =
      eventType.includes('replied') ||
      eventType.includes('reply') ||
      eventType === 'emailer_message.replied';

    if (!isReply) return;

    // Extract the contact email from the webhook payload (Apollo may nest it differently)
    const contactEmail =
      payload?.contact?.email ||
      payload?.emailer_message?.contact?.email ||
      payload?.data?.contact?.email ||
      null;

    if (!contactEmail) {
      console.warn('[Apollo Webhook] Reply event received but no contact email found in payload');
      return;
    }

    const domain = contactEmail.split('@')[1]?.toLowerCase();
    if (!domain) return;

    console.log(`[Apollo Webhook] Reply from ${contactEmail} (domain: ${domain}) — looking up Affinity IDs`);

    const tracked = tracker.getTracking(domain);
    if (!tracked) {
      console.warn(`[Apollo Webhook] No Affinity tracking data found for domain: ${domain}`);
      return;
    }

    const affinityKey = process.env.AFFINITY_API_KEY;
    if (!affinityKey) {
      console.error('[Apollo Webhook] AFFINITY_API_KEY not set — cannot update status');
      return;
    }

    await affinity.markConnected({
      priorityFieldValueId: tracked.priorityFieldValueId,
      connectedOptionId: tracked.connectedOptionId,
    }, affinityKey);

    console.log(`[Apollo Webhook] Affinity status updated to Connected for domain: ${domain} (orgId: ${tracked.orgId})`);
  } catch (e) {
    console.error('[Apollo Webhook] Error processing reply event:', e.message);
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCEO Outreach Tool running at http://localhost:${PORT}\n`);
});
