const { enqueue } = require('./apolloQueue');

async function enrichContact(email) {
  const res = await enqueue('people_match', { email, reveal_personal_emails: true });
  return res.person || null;
}

async function enrichOrganization(domain) {
  const res = await enqueue('org_enrich', { domain });
  return res.organization || null;
}

async function findCEO(domain) {
  const res = await enqueue('ceo_search', {
    q_organization_domains_list: [domain],
    person_seniorities: ['c_suite'],
    person_titles: ['CEO', 'Chief Executive Officer', 'Founder & CEO', 'Co-Founder & CEO',
      'Founder and CEO', 'Co-founder and CEO', 'Founder', 'Co-Founder',
      'Managing Director', 'President', 'Owner'],
    per_page: 5,
  });
  const people = res.people || [];
  const ceo = people.find(p => /ceo|chief executive|founder/i.test(p.title || '')) || people[0] || null;
  console.log('[Apollo] findCEO:', ceo ? `${ceo.first_name} ${ceo.last_name} (${ceo.title})` : 'null');
  return ceo;
}

async function searchCompanyByName(name) {
  const res = await enqueue('company_search', { q_organization_name: name, per_page: 1 });
  return (res.organizations || [])[0] || null;
}

async function enrichPersonById(apolloId) {
  const res = await enqueue('people_match', { id: apolloId, reveal_personal_emails: true });
  return res.person || null;
}

async function enrichPersonByNameAndDomain(firstName, lastName, domain, _apiKey, apolloId = null, orgName = null) {
  const payload = { first_name: firstName, domain, reveal_personal_emails: true };
  if (orgName) payload.organization_name = orgName;
  if (apolloId) payload.id = apolloId;
  const res = await enqueue('people_match', payload);
  return res.person || null;
}

async function upsertContact(contactData) {
  const search = await enqueue('contacts_search', { q_keywords: contactData.email, per_page: 1 });
  const existing = (search.contacts || [])[0];
  if (existing) return { contact: existing, created: false };
  const create = await enqueue('contacts_create', contactData);
  return { contact: create.contact, created: true };
}

async function upsertAccount(orgData) {
  const res = await enqueue('accounts_create', {
    name: orgData.name,
    domain: orgData.primary_domain || orgData.domain,
    website_url: orgData.website_url,
    industry: orgData.industry,
    employee_count: orgData.num_employees,
  });
  return res.account;
}

async function searchSequences(name) {
  const res = await enqueue('sequences_search', { name, per_page: 10 });
  return res.emailer_campaigns || [];
}

async function createSequence(sequenceName) {
  const res = await enqueue('sequences_create', { name: sequenceName, permissions: 'private' });
  return res.emailer_campaign;
}

async function addContactToSequence(sequenceId, contactId) {
  return {};
}

async function getEmailAccounts() {
  const res = await enqueue('email_accounts', {});
  return res.email_accounts || [];
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
