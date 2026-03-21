const axios = require('axios');

const HUNTER_BASE = 'https://api.hunter.io/v2';

// Domain search — returns company name + all found emails for a domain
async function domainSearch(domain, apiKey) {
  const res = await axios.get(`${HUNTER_BASE}/domain-search`, {
    params: { domain, api_key: apiKey, limit: 10 },
  });
  return res.data.data || null;
}

// Find the CEO/founder from a Hunter domain search result
function extractCEO(data) {
  if (!data?.emails?.length) return null;

  const CEO_PATTERN = /ceo|chief executive|founder|co-founder|managing director|president|owner/i;

  // Prefer someone whose position matches CEO titles
  const byTitle = data.emails.find(e => CEO_PATTERN.test(e.position || ''));
  // Fall back to most senior executive
  const byDept = data.emails.find(
    e => e.seniority === 'executive' && e.department === 'management'
  );
  const person = byTitle || byDept || data.emails[0];
  if (!person) return null;

  return {
    first_name: person.first_name || '',
    last_name: person.last_name || '',
    email: person.value || null,
    title: person.position || 'CEO',
    linkedin_url: person.linkedin || null,
    email_status: person.confidence >= 80 ? 'verified' : 'unverified',
    confidence: person.confidence,
    source: 'hunter',
  };
}

// Extract company info from a Hunter domain search result
function extractCompany(data, domain) {
  if (!data) return null;
  return {
    name: data.organization || domain,
    primary_domain: data.domain || domain,
    domain: data.domain || domain,
    website_url: `https://${data.domain || domain}`,
    industry: null, // Hunter doesn't return industry
    num_employees: null,
    logo_url: null,
    short_description: data.description || null,
    source: 'hunter',
  };
}

// Main: look up company + CEO by domain
async function lookupDomain(domain, apiKey) {
  const data = await domainSearch(domain, apiKey);
  return {
    company: extractCompany(data, domain),
    ceo: extractCEO(data),
  };
}

module.exports = { lookupDomain };
