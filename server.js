require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { runOutreachSequence, runOutreachByCompany, launchEmailOutreach } = require('./src/sequenceManager');
const { buildEmailSequence } = require('./src/emailGenerator');
const apollo = require('./src/apollo');
const affinity = require('./src/affinity');

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

  const hunterKey = req.body.hunterKey || process.env.HUNTER_API_KEY;

  try {
    const result = await runOutreachByCompany({ companyName, apiKey, hunterKey });
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

// Fetch all companies from Affinity sourcing list
app.get('/api/affinity/sourcing-companies', async (req, res) => {
  const affinityKey = process.env.AFFINITY_API_KEY;
  if (!affinityKey) return res.status(400).json({ error: 'AFFINITY_API_KEY not set in .env' });
  try {
    const result = await affinity.getSourcingListWithDetails(affinityKey);
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

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCEO Outreach Tool running at http://localhost:${PORT}\n`);
});
