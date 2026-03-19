// Affinity CRM integration
// Uses Basic Auth: empty username, API key as password
const axios = require('axios');

const BASE_URL = 'https://api.affinity.co';

function getClient(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    auth: { username: '', password: apiKey },
    headers: { 'Content-Type': 'application/json' },
  });
}

// Find an organization in Affinity by name, return first match or null
async function findOrganization(name, apiKey) {
  const client = getClient(apiKey);
  const res = await client.get('/organizations', { params: { term: name, page_size: 5 } });
  const orgs = res.data?.organizations || [];
  // Match by exact name first, then fallback to first result
  const exact = orgs.find(o => o.name?.toLowerCase() === name.toLowerCase());
  return exact || orgs[0] || null;
}

// Create a new organization in Affinity
async function createOrganization({ name, domain }, apiKey) {
  const client = getClient(apiKey);
  const payload = { name };
  if (domain) payload.domain_names = [domain];
  const res = await client.post('/organizations', payload);
  return res.data;
}

// Find or create an organization — returns { org, created }
async function upsertOrganization({ name, domain }, apiKey) {
  const existing = await findOrganization(name, apiKey);
  if (existing) return { org: existing, created: false };
  const org = await createOrganization({ name, domain }, apiKey);
  return { org, created: true };
}

// Find a person in Affinity by name, return first match or null
async function findPerson(firstName, lastName, apiKey) {
  const client = getClient(apiKey);
  const term = `${firstName || ''} ${lastName || ''}`.trim();
  const res = await client.get('/persons', { params: { term, page_size: 5 } });
  const people = res.data?.persons || [];
  const exact = people.find(p =>
    p.first_name?.toLowerCase() === (firstName || '').toLowerCase() &&
    p.last_name?.toLowerCase() === (lastName || '').toLowerCase()
  );
  return exact || people[0] || null;
}

// Create a new person in Affinity, optionally linked to an org
async function createPerson({ firstName, lastName, email, organizationId }, apiKey) {
  const client = getClient(apiKey);
  const payload = {
    first_name: firstName,
    last_name: lastName,
  };
  if (email) payload.emails = [email];
  if (organizationId) payload.organization_ids = [organizationId];
  const res = await client.post('/persons', payload);
  return res.data;
}

// Find or create a person — returns { person, created }
async function upsertPerson({ firstName, lastName, email, organizationId }, apiKey) {
  const existing = await findPerson(firstName, lastName, apiKey);
  if (existing) return { person: existing, created: false };
  const person = await createPerson({ firstName, lastName, email, organizationId }, apiKey);
  return { person, created: true };
}

module.exports = { upsertOrganization, upsertPerson };
