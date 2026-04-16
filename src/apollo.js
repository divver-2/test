const axios = require('axios');

const BASE = 'https://api.apollo.io/v1';

function client() {
  const key = process.env.APOLLO_API_KEY;
  return axios.create({
    baseURL: BASE,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    timeout: 30000,
  });
}

async function enrichContact(email) {
  const res = await client().post('/people/match', { email, reveal_personal_emails: true });
  return res.data.person || null;
}

async function enrichOrganization(domain) {
  const res = await client().post('/organizations/enrich', { domain });
  return res.data.organization || null;
}

async function findCEO(domain) {
  const res = await client().post('/mixed_people/search', {
    q_organization_domains_list: [domain],
    person_seniorities: ['c_suite'],
    person_titles: ['CEO', 'Chief Executive Officer', 'Founder & CEO', 'Co-Founder & CEO',
      'Founder and CEO', 'Co-founder and CEO', 'Founder', 'Co-Founder',
      'Managing Director', 'President', 'Owner'],
    per_page: 5,
  });
  const people = res.data.people || [];
  const ceo = people.find(p => /ceo|chief executive|founder/i.test(p.title || '')) || people[0] || null;
  console.log('[Apollo] findCEO:', ceo ? `${ceo.first_name} ${ceo.last_name} (${ceo.title})` : 'null');
  return ceo;
}

async function searchCompanyByName(name) {
  const res = await client().post('/mixed_companies/search', { q_organization_name: name, per_page: 1 });
  return (res.data.organizations || [])[0] || null;
}

async function enrichPersonById(apolloId) {
  const res = await client().post('/people/match', { id: apolloId, reveal_personal_emails: true });
  return res.data.person || null;
}

async function enrichPersonByNameAndDomain(firstName, lastName, domain, _apiKey, apolloId = null, orgName = null) {
  const payload = { first_name: firstName, domain, reveal_personal_emails: true };
  if (orgName) payload.organization_name = orgName;
  if (apolloId) payload.id = apolloId;
  const res = await client().post('/people/match', payload);
  return res.data.person || null;
}

async function upsertContact(contactData) {
  try {
    const search = await client().post('/contacts/search', { q_keywords: contactData.email, per_page: 1 });
    const existing = (search.data.contacts || [])[0];
    if (existing) return { contact: existing, created: false };
  } catch {}
  try {
    const create = await client().post('/contacts', contactData);
    return { contact: create.data.contact, created: true };
  } catch {
    return { contact: null, created: false };
  }
}

async function upsertAccount(orgData) {
  try {
    const res = await client().post('/accounts', {
      name: orgData.name,
      domain: orgData.primary_domain || orgData.domain,
      website_url: orgData.website_url,
      industry: orgData.industry,
      employee_count: orgData.num_employees,
    });
    return res.data.account;
  } catch {
    return null;
  }
}

async function searchSequences(name) {
  try {
    const res = await client().get('/emailer_campaigns/search', { params: { name, per_page: 10 } });
    return res.data.emailer_campaigns || [];
  } catch {
    return [];
  }
}

async function createSequence(sequenceName) {
  const res = await client().post('/emailer_campaigns', { name: sequenceName, permissions: 'private' });
  return res.data.emailer_campaign;
}

async function addContactToSequence(sequenceId, contactId) {
  return {};
}

async function getEmailAccounts() {
  try {
    const res = await client().get('/email_accounts');
    return res.data.email_accounts || [];
  } catch {
    return [];
  }
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
