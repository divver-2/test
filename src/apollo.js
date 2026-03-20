const axios = require('axios');

const APOLLO_BASE = 'https://api.apollo.io/v1';

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

// Enrich the organization to find the CEO
async function enrichOrganization(domain, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/organizations/enrich`,
    { domain },
    { headers: getHeaders(apiKey) }
  );
  return res.data.organization || null;
}

// Find the CEO of a company by domain
async function findCEO(domain, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/mixed_people/search`,
    {
      q_organization_domains_list: [domain],
      person_titles: [
        'CEO', 'Chief Executive Officer', 'Founder & CEO', 'Co-Founder & CEO',
        'Founder and CEO', 'Co-founder and CEO', 'Founder', 'Co-Founder',
        'Managing Director', 'President', 'Owner', 'Founder/CEO',
      ],
      per_page: 1,
      reveal_personal_emails: true,
    },
    { headers: getHeaders(apiKey) }
  );
  const people = res.data.people || [];
  return people[0] || null;
}

// Search or create a contact in Apollo CRM
async function upsertContact(contactData, apiKey) {
  // Try to find existing contact first
  const searchRes = await axios.post(
    `${APOLLO_BASE}/contacts/search`,
    { q_keywords: contactData.email, per_page: 1 },
    { headers: getHeaders(apiKey) }
  );
  const existing = (searchRes.data.contacts || [])[0];
  if (existing) return { contact: existing, created: false };

  // Create new contact
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

// Create a new Apollo sequence with 5 follow-ups spaced 45 days apart (~1.5 months)
async function createSequence(sequenceName, emailAccountId, apiKey) {
  // Create the sequence (campaign)
  const campaignRes = await axios.post(
    `${APOLLO_BASE}/emailer_campaigns`,
    {
      name: sequenceName,
      emailer_schedule_id: null, // uses default schedule
      permissions: 'private',
    },
    { headers: getHeaders(apiKey) }
  );
  const campaign = campaignRes.data.emailer_campaign;
  return campaign;
}

// Add a contact to a sequence
async function addContactToSequence(sequenceId, contactId, emailAccountId, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`,
    {
      contact_ids: [contactId],
      emailer_campaign_id: sequenceId,
      send_email_from_email_account_id: emailAccountId,
    },
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

// Enrich a person by their Apollo ID to get email
async function enrichPersonById(apolloId, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    { id: apolloId, reveal_personal_emails: true },
    { headers: getHeaders(apiKey) }
  );
  return res.data.person || null;
}

// Get connected email accounts
async function getEmailAccounts(apiKey) {
  const res = await axios.get(
    `${APOLLO_BASE}/email_accounts`,
    { headers: getHeaders(apiKey) }
  );
  return res.data.email_accounts || [];
}

// Create an account (company) in Apollo CRM if it doesn't exist
async function upsertAccount(orgData, apiKey) {
  const res = await axios.post(
    `${APOLLO_BASE}/accounts`,
    {
      name: orgData.name,
      domain: orgData.primary_domain || orgData.domain,
      website_url: orgData.website_url,
      industry: orgData.industry,
      employee_count: orgData.num_employees,
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
  upsertContact,
  upsertAccount,
  searchSequences,
  createSequence,
  addContactToSequence,
  getEmailAccounts,
};
