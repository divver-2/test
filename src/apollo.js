const axios = require('axios');

const APOLLO_BASE = 'http://localhost:3001/v1';

function getHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function enrichContact(email) {
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    { email, reveal_personal_emails: true },
    { headers: getHeaders() }
  );
  return res.data.person || null;
}

async function enrichOrganization(domain) {
  const res = await axios.post(
    `${APOLLO_BASE}/organizations/enrich`,
    { domain },
    { headers: getHeaders() }
  );
  return res.data.organization || null;
}

async function findCEO(domain) {
  const res = await axios.post(
    `${APOLLO_BASE}/mixed_people/search`,
    {
      q_organization_domains_list: [domain],
      person_seniorities: ['c_suite'],
      person_titles: ['CEO', 'Chief Executive Officer', 'Founder & CEO', 'Co-Founder & CEO',
        'Founder and CEO', 'Co-founder and CEO', 'Founder', 'Co-Founder',
        'Managing Director', 'President', 'Owner'],
      per_page: 5,
    },
    { headers: getHeaders() }
  );
  const people = res.data.people || [];
  const ceo = people.find(p => /ceo|chief executive|founder/i.test(p.title || '')) || people[0] || null;
  console.log('[Apollo] findCEO result:', ceo ? { id: ceo.id, name: `${ceo.first_name} ${ceo.last_name}`, title: ceo.title } : 'null');
  return ceo;
}

async function upsertContact(contactData) {
  const searchRes = await axios.post(
    `${APOLLO_BASE}/contacts/search`,
    { q_keywords: contactData.email, per_page: 1 },
    { headers: getHeaders() }
  );
  const existing = (searchRes.data.contacts || [])[0];
  if (existing) return { contact: existing, created: false };

  const createRes = await axios.post(
    `${APOLLO_BASE}/contacts`,
    contactData,
    { headers: getHeaders() }
  );
  return { contact: createRes.data.contact, created: true };
}

async function searchSequences(name) {
  const res = await axios.get(
    `${APOLLO_BASE}/emailer_campaigns/search`,
    { params: { name, per_page: 10 }, headers: getHeaders() }
  );
  return res.data.emailer_campaigns || [];
}

async function createSequence(sequenceName) {
  const campaignRes = await axios.post(
    `${APOLLO_BASE}/emailer_campaigns`,
    { name: sequenceName, permissions: 'private' },
    { headers: getHeaders() }
  );
  return campaignRes.data.emailer_campaign;
}

async function addContactToSequence(sequenceId, contactId) {
  // stub — sequences managed directly in Apollo UI
  return {};
}

async function searchCompanyByName(name) {
  const res = await axios.post(
    `${APOLLO_BASE}/mixed_companies/search`,
    { q_organization_name: name, per_page: 1 },
    { headers: getHeaders() }
  );
  return (res.data.organizations || [])[0] || null;
}

async function enrichPersonById(apolloId) {
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    { id: apolloId, reveal_personal_emails: true },
    { headers: getHeaders() }
  );
  return res.data.person || null;
}

async function enrichPersonByNameAndDomain(firstName, lastName, domain, _apiKey, apolloId = null, orgName = null) {
  const payload = { first_name: firstName, domain, reveal_personal_emails: true };
  if (orgName) payload.organization_name = orgName;
  if (apolloId) payload.id = apolloId;
  const res = await axios.post(
    `${APOLLO_BASE}/people/match`,
    payload,
    { headers: getHeaders() }
  );
  return res.data.person || null;
}

async function getEmailAccounts() {
  const res = await axios.get(`${APOLLO_BASE}/email_accounts`, { headers: getHeaders() });
  return res.data.email_accounts || [];
}

async function upsertAccount(orgData) {
  const res = await axios.post(
    `${APOLLO_BASE}/accounts`,
    {
      name: orgData.name,
      domain: orgData.primary_domain || orgData.domain,
      website_url: orgData.website_url,
      industry: orgData.industry,
      employee_count: orgData.num_employees,
    },
    { headers: getHeaders() }
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
  addContactToSequence,
  getEmailAccounts,
};
