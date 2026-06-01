require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
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
  const { companyData, ceoData, emailSequence, apiKey: bodyKey, affinityKey: bodyAffinityKey, senderName } = req.body;
  if (!ceoData?.email) return res.status(400).json({ error: 'ceoData.email is required' });

  const apiKey = bodyKey || process.env.APOLLO_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Apollo API key is required' });

  const affinityKey = bodyAffinityKey || process.env.AFFINITY_API_KEY;

  try {
    const result = await launchEmailOutreach({ companyData, ceoData, emailSequence, apiKey, affinityKey, senderName });
    res.json(result);
  } catch (err) {
    console.error('[/api/send-outreach] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Improve email — rewrites the current draft based on a plain-english instruction
app.post('/api/improve-email', async (req, res) => {
  const { subject, body, instruction, companyName, ceoName, industry } = req.body;
  if (!body || !instruction) return res.status(400).json({ error: 'body and instruction are required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const client = new Anthropic({ apiKey });
    const context = [
      companyName && `Company: ${companyName}`,
      industry && `Industry: ${industry}`,
      ceoName && `CEO: ${ceoName}`,
    ].filter(Boolean).join('\n');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Rewrite this investor outreach email following the instruction below. Keep the exact same format — only change the investing space and the company-specific detail.

Current email:
${body}

Instruction: ${instruction}

${context}

Required format (do not change any fixed lines):
Line 1: greeting (e.g. "Hi Bruno,")
Line 2: "Hope all is well, I'm an investor at NewView Capital - a $3.1bn venture growth fund."
[blank line]
Line 3: "I wanted to reach out as I've been spending time in [SPACE]. I've heard positive feedback on [company], specifically around [WHAT_THEY_BUILD], and am very impressed with what you are building."
[blank line]
Line 4: "I'm excited about what you are doing and wanted to see if it was a good time to connect."
[blank line]
Line 5: "Thanks," then the sender name on a new line.

Reply with only the rewritten email, nothing else.`,
      }],
    });

    res.json({ subject: subject || 'Connecting from NewView Capital', body: msg.content[0].text.trim().replace(/\[([^\]]+)\]/g, '$1').replace(/—/g, '-') });
  } catch (err) {
    console.error('[/api/improve-email] Error:', err.message);
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

// Poll Apollo for replies and update Affinity status to Connected
// Call this manually or it runs automatically every hour
async function syncRepliesFromApollo() {
  const apiKey = process.env.APOLLO_API_KEY;
  const affinityKey = process.env.AFFINITY_API_KEY;
  if (!apiKey || !affinityKey) return { updated: [], skipped: [], errors: [] };

  const updated = [], skipped = [], errors = [];

  try {
    const replies = await apollo.pollForReplies(apiKey);
    console.log(`[poll-replies] Found ${replies.length} replied contact(s) across CEO Outreach sequences`);

    for (const reply of replies) {
      if (!reply.domain) { skipped.push({ ...reply, reason: 'no domain' }); continue; }

      const tracked = tracker.getTracking(reply.domain);
      if (!tracked) { skipped.push({ ...reply, reason: 'not in tracker' }); continue; }

      try {
        await affinity.markConnected({
          priorityFieldValueId: tracked.priorityFieldValueId,
          priorityContext: tracked.priorityContext || null,
          connectedOptionId: tracked.connectedOptionId,
        }, affinityKey);
        console.log(`[poll-replies] Marked Connected in Affinity: ${reply.domain}`);
        updated.push(reply);
      } catch (e) {
        errors.push({ ...reply, error: e.message });
      }
    }
  } catch (e) {
    console.error('[poll-replies] Failed to poll Apollo:', e.message);
    errors.push({ error: e.message });
  }

  return { updated, skipped, errors };
}

// Manual trigger: POST /api/poll-replies
app.post('/api/poll-replies', async (req, res) => {
  try {
    const result = await syncRepliesFromApollo();
    res.json({ success: true, ...result });
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
      priorityContext: tracked.priorityContext || null,
      connectedOptionId: tracked.connectedOptionId,
    }, affinityKey);

    console.log(`[Apollo Webhook] Affinity status updated to Connected for domain: ${domain} (orgId: ${tracked.orgId})`);
  } catch (e) {
    console.error('[Apollo Webhook] Error processing reply event:', e.message);
  }
});

// Manually set Affinity org ID for a domain — saves to cache so future lookups skip searching
app.post('/api/affinity/set-org-id', (req, res) => {
  const { domain, orgId } = req.body;
  if (!domain || !orgId) return res.status(400).json({ error: 'domain and orgId are required' });
  const cleanDomain = domain.toLowerCase().replace(/^www\./, '');
  tracker.learnOrgId(cleanDomain, orgId);
  res.json({ ok: true, domain: cleanDomain, orgId });
});

// CEO override — look up the correct CEO by LinkedIn URL and regenerate the email draft
app.post('/api/ceo-override', async (req, res) => {
  const { linkedinUrl, domain, companyName, industry, description, apiKey: bodyKey } = req.body;
  if (!linkedinUrl) return res.status(400).json({ error: 'linkedinUrl is required' });

  const apiKey = bodyKey || process.env.APOLLO_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Apollo API key is required' });

  try {
    const person = await apollo.matchPersonByLinkedIn(linkedinUrl, apiKey);
    if (!person) return res.status(404).json({ error: 'Person not found in Apollo for that LinkedIn URL' });

    const ceoName = `${person.first_name || ''} ${person.last_name || ''}`.trim();
    const ceoEmail =
      person.email ||
      person.work_email ||
      person.personal_emails?.[0] ||
      person.contact_emails?.[0]?.email ||
      null;

    const { buildEmailSequence } = require('./src/emailGenerator');
    const emailSequence = await buildEmailSequence({
      ceoName,
      companyName: companyName || domain || '',
      industry: industry || '',
      description: description || '',
      website: domain ? `https://${domain}` : null,
      senderName: 'David Divver',
    });

    res.json({
      ceo: {
        name: ceoName,
        email: ceoEmail,
        title: person.title || null,
        emailVerified: person.email_status === 'verified',
        linkedinUrl: person.linkedin_url || linkedinUrl,
        firstName: person.first_name || null,
        lastName: person.last_name || null,
        apolloId: person.id || null,
      },
      emailDraft: emailSequence[0] || null,
      emailSequence,
    });
  } catch (err) {
    console.error('[/api/ceo-override] Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Debug: test Affinity key — visit /api/affinity-test?key=YOUR_KEY or uses env var
app.get('/api/affinity-test', async (req, res) => {
  const axios = require('axios');
  const key = req.query.key || process.env.AFFINITY_API_KEY || '';
  if (!key) return res.json({ error: 'no key — pass ?key=YOUR_KEY or set AFFINITY_API_KEY env var', envKeyPresent: false });
  try {
    const r = await axios.get('https://api.affinity.co/auth/whoami', {
      auth: { username: '', password: key },
    });
    res.json({ ok: true, user: r.data, keyLength: key.length, envKeyPresent: !!process.env.AFFINITY_API_KEY });
  } catch (e) {
    res.json({ ok: false, status: e.response?.status, error: e.response?.data || e.message, keyLength: key.length, envKeyPresent: !!process.env.AFFINITY_API_KEY });
  }
});

const NEWVIEW_PORTFOLIO = [
  '23andMe','Acquia','Aera','Aerospike','Apollo','Arbor','BenchPrep','Bird','Bloomreach',
  'Boku','Canopy','ClearMotion','CloudBees','CloudWalk','Clumio','Code42','ContentSquare',
  'Coralogix','Coursera','Cyberhaven','Databricks','Datavisor','Demandbase','Desire2Learn',
  'Didi Chuxing','Duolingo','Enable','Eucalyptus','Evernote','FloQast','Farther','Forma',
  'Forter','Gladly','GumGum','Halter','Hearsay','Hibob','Hightouch','Hims','Hinge',
  'Housecall Pro','Human Interest','Huntress','Intercom','Island','LaunchDarkly','Learneo',
  'Legora','Levelpath','Lumin','MasterClass','Mercury','MindTickle','Modern Treasury',
  'NetraDyne','Nium','Node.io','Owner','Paystand','Plaid','Prepared911','Rapyd','Reltio',
  'Sciencelogic','Scopely','Scout','Segment.io','Sigma','Silverfort','Solera','Stord',
  'Topia','Uber','Udemy','Vendia','Verkada','Versusgame','Veryfi','Viewlift','Vitally',
  'Wellhub','Workato','Bubble','EvenUp','Grow Therapy','Horizon3.ai','Monarch Money',
  'Motion','OneSignal','PlanetScale','Ro','Verse Medical',
];

// Parse a customer call transcript (PDF or text) and extract differentiation insights
app.post('/api/parse-transcript', async (req, res) => {
  const { transcript, pdfBase64, companyName } = req.body;
  if (!transcript && !pdfBase64) return res.status(400).json({ error: 'transcript or pdfBase64 is required' });
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = `You are analyzing a customer call transcript for ${companyName || 'a company'}.

Extract 3-5 specific things customers said that highlight why they chose this product and what makes it better than alternatives. Focus on:
- Specific pain points it solves that competitors don't
- Features or capabilities customers specifically praised
- Reasons they switched from or chose over a competitor
- Quantifiable outcomes or results they mentioned

Return ONLY a JSON array of short strings (each under 20 words), like:
["insight one", "insight two", "insight three"]`;

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const content = pdfBase64
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt },
        ]
      : `${prompt}\n\nTranscript:\n${transcript.slice(0, 8000)}`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content }],
    });

    let insights = [];
    try {
      const text = msg.content[0].text.trim();
      const match = text.match(/\[[\s\S]*\]/);
      insights = match ? JSON.parse(match[0]) : [];
    } catch { insights = []; }

    res.json({ insights });
  } catch (err) {
    console.error('[/api/parse-transcript] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a detailed research-backed email using Claude + NewView portfolio context
app.post('/api/research-email', async (req, res) => {
  const { companyName, domain, industry, description, funding, fundingStage, employees, ceoName, ceoFirstName, customerInsights } = req.body;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const firstName = ceoFirstName || (ceoName || '').split(' ')[0] || 'there';
    const hasInsights = Array.isArray(customerInsights) && customerInsights.length > 0;
    const insightsBlock = hasInsights
      ? `\nCustomer feedback from calls (weave into the differentiation sentence naturally — attribute it as "we've spoken with customers who highlight..."):
${customerInsights.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
      : '';

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `You are David Divver, a partner at NewView Capital, a $3.1bn venture growth fund. Write a concise investor outreach email to the CEO of ${companyName}.

Company context:
- Name: ${companyName}
- Domain: ${domain || ''}
- Industry: ${industry || ''}
- Description: ${description || ''}
- Funding raised: ${funding || 'undisclosed'}
- Stage: ${fundingStage || ''}
- Employees: ${employees || 'unknown'}
- CEO: ${ceoName || ''}
${insightsBlock}
NewView Capital portfolio (pick 1-2 most relevant/adjacent companies to reference):
${NEWVIEW_PORTFOLIO.join(', ')}

Write the email with exactly this 3-paragraph structure — concise, warm, not a research report:

"Hi ${firstName},"
[blank line]
Paragraph 1 — Introduction: "Hope all is well, I'm an investor at NewView Capital - a $3.1bn venture growth fund. We've been spending a lot of time in [the specific space ${companyName} operates in] and have made investments in [name the specific sub-spaces or categories, e.g. 'observability, data infrastructure, and developer tooling'], including [1-2 most relevant NewView portfolio companies]."
[blank line]
Paragraph 2 — Conviction + thesis: Start with "We have a lot of conviction about what you are building." Then ${hasInsights
  ? `build the thesis using the customer insights provided — explain what ${companyName} does better than competitors (name 1-2) and weave in the customer voice naturally, e.g. "customers highlight [insight] as a key reason they chose ${companyName}." Keep it to 2-3 sentences.`
  : `explain in 2-3 sentences why ${companyName} is differentiated vs competitors (name 1-2) and why this market matters now.`}
[blank line]
Paragraph 3 — CTA: "We would love to find a way to partner together and have a lot of conviction in the space. Would you be open to a call?"
[blank line]
"Thanks,"
"David"

Reply with only the email body. Keep it tight — 3 paragraphs only.`,
      }],
    });
    res.json({ body: msg.content[0].text.trim().replace(/—/g, '-') });
  } catch (err) {
    console.error('[/api/research-email] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get full outreach log (all Mark as Sent entries)
app.get('/api/outreach-log', (req, res) => {
  res.json(tracker.getAllOutreach());
});

// Get all follow-ups due (outreach sent 30+ days ago, no follow-up yet)
app.get('/api/follow-ups', (req, res) => {
  res.json(tracker.getFollowUpsDue());
});

// Mark a follow-up as sent
app.post('/api/follow-ups/mark-sent', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  tracker.markFollowUpSent(domain);
  res.json({ ok: true });
});

// Generate a follow-up email draft for a company
app.post('/api/follow-up-draft', async (req, res) => {
  const { ceoName, ceoEmail, companyName, industry, description, daysSince } = req.body;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const firstName = (ceoName || '').split(' ')[0] || 'there';
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are David Divver, a partner at NewView Capital. Write a short, warm follow-up email to ${ceoName} (CEO of ${companyName}) sent ${daysSince} days after the initial outreach.

Company: ${companyName}
Industry: ${industry || ''}
Description: ${description || ''}

Structure:
"Hi ${firstName},"
[blank line]
One sentence: a warm, brief follow-up — mention you wanted to resurface your note from a few weeks ago and reiterate your interest in ${companyName}.
[blank line]
One sentence: "Would you be open to a quick call to connect?"
[blank line]
"Thanks,"
"David"

Reply with only the email. Keep it to 3-4 lines — short and direct.`,
      }],
    });
    res.json({
      subject: `Following up - NewView Capital`,
      body: msg.content[0].text.trim().replace(/—/g, '-'),
      to: ceoEmail,
    });
  } catch (err) {
    console.error('[/api/follow-up-draft] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear cached org ID for a domain (use when Affinity org was deleted/changed)
app.post('/api/cache/clear', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const tracker = require('./src/outreachTracker');
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, 'data/outreach-tracker.json');
  try {
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const key = domain.toLowerCase();
    if (data[key]) { delete data[key]; fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    res.json({ ok: true, cleared: key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
  console.log(`\nCEO Outreach Tool running at http://localhost:${PORT}\n`);

  // Poll Apollo for replies every hour and sync Affinity status automatically
  const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  setInterval(async () => {
    console.log('[auto-poll] Checking Apollo for replies...');
    const result = await syncRepliesFromApollo();
    if (result.updated.length > 0) {
      console.log(`[auto-poll] Updated ${result.updated.length} Affinity record(s) to Connected`);
    }
  }, POLL_INTERVAL_MS);
});
