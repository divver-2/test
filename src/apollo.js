const axios = require('axios');

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

function getHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  };
}

// Look up a person by email and enrich their data + company
async function enrichContact(email, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    { email, reveal_personal_emails: true },
    { headers: getHeaders(apiKey) }
  );
  return res.data.person || null;
}

// Enrich the organization to find details by domain.
// Falls back to mixed_companies/search on 403 (free plan).
async function enrichOrganization(domain, apiKey) {
  try {
    const res = await axios.post(
      `${APOLLO_BASE}/organizations/enrich`,
      { domain },
      { headers: getHeaders(apiKey) }
    );
    return res.data.organization || null;
  } catch (e) {
    if (e.response?.status !== 403) throw e;
    console.log('[Apollo] organizations/enrich not available, falling back to mixed_companies/search');
    const res = await axios.post(
      `${APOLLO_BASE}/mixed_companies/search`,
      { q_organization_name: domain, per_page: 1 },
      { headers: getHeaders(apiKey) }
    );
    return (res.data.organizations || [])[0] || null;
  }
}

// Find CEO via org chart IDs (free-plan fallback): look up company, then enrich each root person.
async function findCEOViaOrgChart(domain, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/mixed_companies/search`,
    { q_organization_name: domain, per_page: 1 },
    { headers: getHeaders(apiKey) }
  );
  const org = (res.data.organizations || [])[0];
  const personIds = org?.org_chart_root_people_ids || [];
  if (!personIds.length) {
    console.log('[Apollo] org chart fallback: no root person IDs found');
    return null;
  }
  for (const id of personIds.slice(0, 3)) {
    try {
      const person = await enrichPersonById(id, apiKey);
      if (person) {
        console.log('[Apollo] org chart fallback found:', person.first_name, person.last_name, person.title);
        return person;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// Find the CEO of a company by domain.
// Tries targeted title search first, then broad domain search, then org chart.
async function findCEO(domain, apiKey) {
  try {
    // Pass 1: targeted c-suite title search
    const res = await axios.post(
      `${APOLLO_BASE}/mixed_people/api_search`,
      {
        q_organization_domains_list: [domain],
        person_seniorities: ['c_suite'],
        person_titles: [
          'CEO', 'Chief Executive Officer', 'Founder & CEO', 'Co-Founder & CEO',
          'Founder and CEO', 'Co-founder and CEO', 'Founder', 'Co-Founder',
          'Managing Director', 'President', 'Owner',
        ],
        per_page: 5,
      },
      { headers: getHeaders(apiKey) }
    );
    const people = res.data.people || [];
    const ceo = people.find(p => /ceo|chief executive|founder/i.test(p.title || '')) || people[0] || null;
    if (ceo) {
      console.log('[Apollo] findCEO result:', { id: ceo.id, name: `${ceo.first_name} ${ceo.last_name}`, title: ceo.title });
      return ceo;
    }

    // Pass 2: broad domain search — pick most senior person
    console.log('[Apollo] findCEO: no c-suite match, trying broad domain search');
    const broad = await axios.post(
      `${APOLLO_BASE}/mixed_people/api_search`,
      { q_organization_domains_list: [domain], per_page: 10 },
      { headers: getHeaders(apiKey) }
    );
    const broadPeople = broad.data.people || [];
    const broadCeo = broadPeople.find(p => /ceo|founder|president|director/i.test(p.title || '')) || broadPeople[0] || null;
    if (broadCeo) {
      // Normalize: Apollo broad search sometimes omits last_name
      if (!broadCeo.last_name && broadCeo.name) {
        const parts = broadCeo.name.trim().split(/\s+/);
        broadCeo.first_name = broadCeo.first_name || parts[0];
        broadCeo.last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
      }
      broadCeo.last_name = broadCeo.last_name || '';
    }
    console.log('[Apollo] findCEO result:', broadCeo
      ? { id: broadCeo.id, name: `${broadCeo.first_name} ${broadCeo.last_name}`.trim(), title: broadCeo.title }
      : 'null');
    return broadCeo;
  } catch (e) {
    if (e.response?.status !== 403) throw e;
    console.log('[Apollo] mixed_people/search not available, trying org chart fallback');
    return findCEOViaOrgChart(domain, apiKey);
  }
}

// Search or find existing contact in Apollo CRM
async function upsertContact(contactData, apiKey) {
  if (contactData.email) {
    const searchRes = await axios.post(
      `${APOLLO_BASE}/contacts/search`,
      { q_keywords: contactData.email, per_page: 1 },
      { headers: getHeaders(apiKey) }
    );
    const existing = (searchRes.data.contacts || [])[0];
    if (existing) return { contact: existing, created: false };
  }

  const createRes = await axios.post(
    `${APOLLO_BASE}/contacts`,
    contactData,
    { headers: getHeaders(apiKey) }
  );
  return { contact: createRes.data.contact, created: true };
}

// Search for sequences (emailer campaigns)
async function searchSequences(name, apiKey) {
  const res = await axios.get(
    `${APOLLO_BASE}/emailer_campaigns/search`,
    {
      params: { name, per_page: 10 },
      headers: getHeaders(apiKey),
    }
  );
  return res.data.emailer_campaigns || [];
}

// Create a new Apollo sequence (campaign shell only — steps added separately)
async function createSequence(sequenceName, emailAccountId, apiKey) {
  const payload = {
    name: sequenceName,
    permissions: 'private',
  };
  if (emailAccountId) payload.send_email_from_email_account_id = emailAccountId;

  const campaignRes = await axios.post(
    `${APOLLO_BASE}/emailer_campaigns`,
    payload,
    { headers: getHeaders(apiKey) }
  );
  return campaignRes.data.emailer_campaign;
}

// Add a single email step to an existing sequence
async function addSequenceStep(campaignId, { subject, body, delayDays, stepName }, emailAccountId, apiKey) {
  const bodyHtml = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const payload = {
    emailer_campaign_id: campaignId,
    emailer_step_type: 'auto_email',
    wait_mode: 'day',
    wait_time: delayDays || 0,
    emailer_template: {
      name: stepName || subject.slice(0, 50),
      subject,
      body_html: bodyHtml,
      body_text: body,
    },
  };
  if (emailAccountId) payload.send_email_from_email_account_id = emailAccountId;

  const res = await axios.post(
    `${APOLLO_BASE}/emailer_campaigns/${campaignId}/emailer_steps`,
    payload,
    { headers: getHeaders(apiKey) }
  );
  return res.data;
}

// Create a new sequence and add all email steps from the provided sequence array
async function createSequenceWithSteps(sequenceName, emailSequence, emailAccountId, apiKey) {
  const campaign = await createSequence(sequenceName, emailAccountId, apiKey);
  const stepResults = [];

  for (const email of emailSequence) {
    try {
      const step = await addSequenceStep(
        campaign.id,
        {
          subject: email.subject,
          body: email.body,
          delayDays: email.delayDays,
          stepName: `${email.type}`,
        },
        emailAccountId,
        apiKey
      );
      stepResults.push({ ok: true, step });
    } catch (e) {
      console.error('[Apollo] addSequenceStep failed:', e.response?.data || e.message);
      stepResults.push({ ok: false, error: e.response?.data?.message || e.message });
    }
  }

  return { campaign, stepResults };
}

// Get all steps for a sequence, ordered by position
async function getSequenceSteps(sequenceId, apiKey) {
  const res = await axios.get(
    `${APOLLO_BASE}/emailer_campaigns/${sequenceId}/emailer_steps`,
    { headers: getHeaders(apiKey) }
  );
  return res.data.emailer_steps || [];
}

// Add a contact to a sequence (enrolls them — triggers sending)
// Pass startingStepId to enroll at a specific step rather than step 1
async function addContactToSequence(sequenceId, contactId, emailAccountId, apiKey, startingStepId = null) {
  const payload = {
    contact_ids: [contactId],
    emailer_campaign_id: sequenceId,
  };
  if (emailAccountId) payload.send_email_from_email_account_id = emailAccountId;
  if (startingStepId) payload.starting_emailer_step_id = startingStepId;

  const res = await axios.post(
    `${APOLLO_BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`,
    payload,
    { headers: getHeaders(apiKey) }
  );
  return res.data;
}

// Search for a company by name
async function searchCompanyByName(name, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/mixed_companies/search`,
    { q_organization_name: name, per_page: 1 },
    { headers: getHeaders(apiKey) }
  );
  return (res.data.organizations || [])[0] || null;
}

// Enrich a person by their Apollo ID to get full email
async function enrichPersonById(apolloId, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    { id: apolloId, reveal_personal_emails: true },
    { headers: getHeaders(apiKey) }
  );
  return res.data.person || null;
}

// Enrich a person by name + domain (free-plan compatible)
async function enrichPersonByNameAndDomain(firstName, lastName, domain, apiKey, apolloId = null, orgName = null) {
  const payload = { first_name: firstName, domain, reveal_personal_emails: true };
  if (orgName) payload.organization_name = orgName;
  if (apolloId) payload.id = apolloId;
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    payload,
    { headers: getHeaders(apiKey) }
  );
  return res.data.person || null;
}

// Get connected email accounts in Apollo
async function getEmailAccounts(apiKey) {
  const res = await axios.get(
    `${APOLLO_BASE}/email_accounts`,
    { headers: getHeaders(apiKey) }
  );
  // Apollo returns { email_accounts: [...] } or just an array
  if (Array.isArray(res.data)) return res.data;
  return res.data.email_accounts || [];
}

// Get email activity for a company domain — searches contacts and returns emails sent + last email date
async function getCompanyEmailActivity(domain, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/contacts/search`,
    {
      q_organization_domains_list: [domain],
      sort_by_field: 'last_activity_date',
      sort_ascending: false,
      per_page: 25,
    },
    { headers: getHeaders(apiKey) }
  );
  const contacts = res.data.contacts || [];
  const contacted = contacts.filter(c => c.last_activity_date);
  const emailsSent = contacts.reduce((sum, c) => sum + (c.num_contacted || 0), 0);
  const rawDate = contacted[0]?.last_activity_date || null;
  // Normalize: Unix seconds → ISO string; ISO strings pass through
  let lastEmailDate = null;
  if (rawDate) {
    if (typeof rawDate === 'number') {
      lastEmailDate = new Date(rawDate < 1e12 ? rawDate * 1000 : rawDate).toISOString();
    } else {
      lastEmailDate = rawDate;
    }
  }
  return { emailsSent, lastEmailDate };
}

// Create an account (company) in Apollo CRM
async function upsertAccount(orgData, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/accounts`,
    {
      name: orgData.name,
      domain: orgData.primary_domain || orgData.domain,
      website_url: orgData.website_url,
      industry: orgData.industry,
      employee_count: orgData.num_employees || orgData.estimated_num_employees,
    },
    { headers: getHeaders(apiKey) }
  );
  return res.data.account;
}

// Get contacts enrolled in a sequence with a specific status (e.g. "replied")
async function getSequenceContacts(sequenceId, apiKey, statusFilter = null) {
  const params = { per_page: 100 };
  if (statusFilter) params['contact_email_campaign_statuses[]'] = statusFilter;

  const res = await axios.get(
    `${APOLLO_BASE}/emailer_campaigns/${sequenceId}/emailer_contacts`,
    { params, headers: getHeaders(apiKey) }
  );
  // Apollo returns { emailer_contacts: [...] } each with contact + emailer_contact_status
  return res.data.emailer_contacts || [];
}

// Poll all CEO Outreach sequences for replied contacts
// Returns array of { email, domain, sequenceId, sequenceName, repliedAt }
async function pollForReplies(apiKey) {
  const sequences = await searchSequences('CEO Outreach', apiKey);
  const replied = [];

  for (const seq of sequences) {
    try {
      const contacts = await getSequenceContacts(seq.id, apiKey);
      for (const ec of contacts) {
        const status = (ec.emailer_contact_status || ec.status || '').toLowerCase();
        if (status === 'replied') {
          const email =
            ec.contact?.email ||
            ec.contact?.work_email ||
            ec.email ||
            null;
          if (email) {
            replied.push({
              email,
              domain: email.split('@')[1]?.toLowerCase() || null,
              sequenceId: seq.id,
              sequenceName: seq.name,
              repliedAt: ec.replied_at || ec.updated_at || null,
            });
          }
        }
      }
    } catch (e) {
      console.warn(`[Apollo] pollForReplies: failed to get contacts for sequence ${seq.id}:`, e.response?.data?.message || e.message);
    }
  }

  return replied;
}

module.exports = {
  enrichContact,
  enrichOrganization,
  findCEO,
  searchCompanyByName,
  enrichPersonById,
  enrichPersonByNameAndDomain,
  upsertContact,
  upsertAccount,
  searchSequences,
  createSequence,
  createSequenceWithSteps,
  addSequenceStep,
  getSequenceSteps,
  addContactToSequence,
  getEmailAccounts,
  getCompanyEmailActivity,
  getSequenceContacts,
  pollForReplies,
};
