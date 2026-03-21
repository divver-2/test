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
// Tries mixed_people/search (paid) first, falls back to org chart (free).
async function findCEO(domain, apiKey) {
  try {
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
    console.log('[Apollo] findCEO result:', ceo
      ? { id: ceo.id, name: `${ceo.first_name} ${ceo.last_name}`, title: ceo.title }
      : 'null');
    return ceo;
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

// Add a contact to a sequence (enrolls them — triggers sending)
async function addContactToSequence(sequenceId, contactId, emailAccountId, apiKey) {
  const payload = {
    contact_ids: [contactId],
    emailer_campaign_id: sequenceId,
  };
  if (emailAccountId) payload.send_email_from_email_account_id = emailAccountId;

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
  const lastEmailDate = contacted[0]?.last_activity_date || null;
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
  addContactToSequence,
  getEmailAccounts,
  getCompanyEmailActivity,
};
