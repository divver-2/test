// Affinity CRM integration
// Uses Basic Auth: empty username, API key as password
const axios = require('axios');

const BASE_URL = 'https://api.affinity.co';

// Affinity entity type codes
const ENTITY_TYPE = { ORGANIZATION: 0, PERSON: 1 };

function getClient(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    auth: { username: '', password: apiKey },
    headers: { 'Content-Type': 'application/json' },
  });
}

function getClientV2(apiKey) {
  // v2 uses Bearer token — may be a separate token from the v1 API key
  const v2Token = process.env.AFFINITY_V2_TOKEN || apiKey;
  return axios.create({
    baseURL: 'https://api.affinity.co/v2',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${v2Token}` },
  });
}

// ── Organizations ─────────────────────────────────────────────────────────────

// Single-page name search — fast, used for read-only lookups where speed matters
async function findOrganizationFast(name, apiKey) {
  if (!name) return null;
  const client = getClient(apiKey);
  const nameLower = name.toLowerCase();
  try {
    const res = await client.get('/organizations', { params: { term: name, page_size: 100, with_interaction_dates: true } });
    const orgs = res.data?.organizations || (Array.isArray(res.data) ? res.data : []);
    const matches = orgs.filter(o => o.name?.toLowerCase() === nameLower);
    if (matches.length) {
      return (
        matches.find(o => !o.global && (o.interaction_dates?.last_email_date || o.interaction_dates?.last_interaction_date)) ||
        matches.find(o => !o.global) ||
        matches[0]
      );
    }
    return orgs[0] || null;
  } catch (e) {
    console.log('[Affinity] findOrganizationFast error:', e.response?.status, e.message);
    return null;
  }
}

async function findOrganization(name, apiKey) {
  const client = getClient(apiKey);
  const nameLower = name.toLowerCase();
  let allOrgs = [];
  let pageToken = null;
  // Paginate through ALL results — org may be on page 2+
  do {
    const params = { term: name, page_size: 100, with_interaction_dates: true };
    if (pageToken) params.page_token = pageToken;
    const res = await client.get('/organizations', { params });
    const orgs = res.data?.organizations || (Array.isArray(res.data) ? res.data : []);
    allOrgs = allOrgs.concat(orgs);
    pageToken = res.data?.next_page_token || null;
  } while (pageToken);
  console.log(`[Affinity] findOrganization("${name}") → ${allOrgs.length} total results`);
  const matches = allOrgs.filter(o => o.name?.toLowerCase() === nameLower);
  if (!matches.length) return allOrgs[0] || null;
  // Prefer: non-global with interaction > non-global > global with interaction > global
  return (
    matches.find(o => !o.global && (o.interaction_dates?.last_email_date || o.interaction_dates?.last_interaction_date)) ||
    matches.find(o => !o.global) ||
    matches.find(o => o.interaction_dates?.last_email_date || o.interaction_dates?.last_interaction_date) ||
    matches[0]
  );
}

async function findOrganizationByDomain(domain, apiKey) {
  if (!domain) return null;
  const client = getClient(apiKey);
  try {
    const res = await client.get('/organizations', { params: { domain, page_size: 10, with_interaction_dates: true } });
    const orgs = res.data?.organizations || (Array.isArray(res.data) ? res.data : []);
    // Only return an org whose domain_names actually contains this domain (Affinity search is loose)
    const domainLower = domain.toLowerCase();
    const match = orgs.find(o => {
      const names = o.domain_names || o.domains || [];
      return names.some(d => d.toLowerCase() === domainLower) || o.domain?.toLowerCase() === domainLower;
    });
    console.log(`[Affinity] findOrganizationByDomain("${domain}") → match:`, match?.name || 'none');
    return match || null;
  } catch (e) {
    console.log('[Affinity] findOrganizationByDomain error:', e.response?.status, e.message);
    return null;
  }
}

async function createOrganization({ name, domain }, apiKey) {
  const client = getClient(apiKey);
  const payload = { name };
  if (domain) payload.domain_names = [domain];
  console.log('[Affinity] createOrganization payload:', JSON.stringify(payload));
  const res = await client.post('/organizations', payload);
  // Affinity sometimes omits domain from the POST response — patch it in so downstream code can cache it
  if (domain && res.data && !res.data.domain_names?.length) {
    res.data.domain_names = [domain];
    res.data.domains = [domain];
  }
  return res.data;
}


function normalizeDomain(d) {
  return (d || '').toLowerCase().replace(/^www\./, '');
}

// Exhaustive scan through ALL organizations — matches by domain OR name, prefers workspace (non-global) orgs
async function findOrganizationExhaustive(domain, name, apiKey) {
  if (!domain && !name) return null;
  const client = getClient(apiKey);
  const domainNorm = domain ? normalizeDomain(domain) : null;
  // Build multiple name variants to match against (Apollo adds "(YC S25)" etc that Affinity won't have)
  const nameVariants = [];
  if (name) {
    const n = name.toLowerCase();
    nameVariants.push(n);
    // Strip parenthetical suffixes: "Alter (YC S25)" → "alter"
    const stripped = n.replace(/\s*\(.*?\)\s*/g, '').trim();
    if (stripped && stripped !== n) nameVariants.push(stripped);
    // First word only: "alter"
    const firstWord = n.split(/\s+/)[0];
    if (firstWord && firstWord.length > 3 && !nameVariants.includes(firstWord)) nameVariants.push(firstWord);
  }
  const MAX_PAGES = 100;
  console.log(`[Affinity] exhaustive scan — domain:"${domain}" nameVariants:${JSON.stringify(nameVariants)}...`);
  let workspaceMatch = null;
  let globalMatch = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const res = await client.get('/organizations', { params: { page_size: 100, page } });
      const orgs = res.data?.organizations || (Array.isArray(res.data) ? res.data : []);
      if (!orgs.length) break;
      for (const o of orgs) {
        const isGlobal = !!o.global;
        const oNameLower = o.name?.toLowerCase() || '';
        // Domain match — workspace wins immediately, global stored as fallback
        if (domainNorm) {
          const domains = o.domain_names || o.domains || [];
          const domainMatch = domains.some(d => normalizeDomain(d) === domainNorm) || normalizeDomain(o.domain) === domainNorm;
          if (domainMatch) {
            if (!isGlobal) { console.log(`[Affinity] exhaustive: workspace domain match "${o.name}"(${o.id})`); return o; }
            if (!globalMatch) { globalMatch = o; console.log(`[Affinity] exhaustive: global domain match "${o.name}"(${o.id})`); }
          }
        }
        // Name match — exact or stripped variant
        if (nameVariants.length && !workspaceMatch) {
          const nameMatches = nameVariants.some(v => oNameLower === v || oNameLower.startsWith(v + ' ') || oNameLower.includes(v));
          if (nameMatches) {
            if (!isGlobal) { workspaceMatch = o; console.log(`[Affinity] exhaustive: workspace name match "${o.name}"(${o.id})`); }
            else if (!globalMatch) { globalMatch = o; console.log(`[Affinity] exhaustive: global name match "${o.name}"(${o.id})`); }
          }
        }
      }
      if (orgs.length < 100) break;
    } catch (e) {
      console.log('[Affinity] exhaustive scan error:', e.response?.status, e.message);
      break;
    }
  }
  const result = workspaceMatch || globalMatch || null;
  console.log(`[Affinity] exhaustive scan done → ${result ? `${result.name}(${result.id})` : 'not found'}`);
  return result;
}

// Search Affinity v2 API for a company by domain — finds network/shared orgs that v1 search misses
async function findOrganizationV2ByDomain(domain, apiKey) {
  if (!domain) return null;
  const domainNorm = normalizeDomain(domain);

  const client = getClientV2(apiKey);
  for (const params of [{ domain: domainNorm }, { term: domainNorm }]) {
    try {
      const res = await client.get('/companies', { params: { ...params, page_size: 10 } });
      const companies = res.data?.data || res.data?.companies || (Array.isArray(res.data) ? res.data : []);
      console.log(`[Affinity v2] search(${JSON.stringify(params)}) → ${companies.length} results:`, companies.map(c => `${c.name}(${c.id})`));
      const match = companies.find(c => {
        const domains = c.domain_names || c.domains || (c.domain ? [c.domain] : []);
        return domains.some(d => normalizeDomain(d) === domainNorm);
      });
      if (match) {
        console.log(`[Affinity v2] matched: ${match.name}(${match.id})`);
        return { id: match.id, name: match.name, domain_names: match.domain_names || match.domains || [] };
      }
      break; // got a valid response, no need to try term search
    } catch (e) {
      console.log(`[Affinity v2] search error (${JSON.stringify(params)}):`, e.response?.status, JSON.stringify(e.response?.data));
    }
  }
  return null;
}

// Search by CEO email — find the person in Affinity, then get their org
async function findOrganizationByCeoEmail(ceoEmail, apiKey) {
  if (!ceoEmail) return null;
  const client = getClient(apiKey);
  try {
    const res = await client.get('/persons', { params: { term: ceoEmail, page_size: 10 } });
    const people = res.data?.persons || (Array.isArray(res.data) ? res.data : []);
    const emailLower = ceoEmail.toLowerCase();
    for (const person of people) {
      const emails = [person.primary_email, ...(person.emails || [])].filter(Boolean);
      if (!emails.some(e => e.toLowerCase() === emailLower)) continue;
      const orgId = person.organization_ids?.[0];
      if (!orgId) continue;
      const orgRes = await client.get(`/organizations/${orgId}`);
      const org = orgRes.data;
      console.log(`[Affinity] findOrgByCeoEmail("${ceoEmail}") → found org: ${org?.name}(${org?.id})`);
      return org;
    }
    console.log(`[Affinity] findOrgByCeoEmail("${ceoEmail}") → no match`);
    return null;
  } catch (e) {
    console.log('[Affinity] findOrgByCeoEmail error:', e.response?.status, e.message);
    return null;
  }
}

// Search Affinity for a person by name, then return their linked org
async function findOrganizationByCeoName(firstName, lastName, apiKey) {
  if (!firstName && !lastName) return null;
  const client = getClient(apiKey);
  const term = `${firstName || ''} ${lastName || ''}`.trim();
  try {
    const res = await client.get('/persons', { params: { term, page_size: 10 } });
    const people = res.data?.persons || (Array.isArray(res.data) ? res.data : []);
    const fLower = (firstName || '').toLowerCase();
    const lLower = (lastName || '').toLowerCase();
    for (const person of people) {
      const pFirst = (person.first_name || '').toLowerCase();
      const pLast = (person.last_name || '').toLowerCase();
      if (pFirst !== fLower || pLast !== lLower) continue;
      const orgId = person.organization_ids?.[0];
      if (!orgId) continue;
      const orgRes = await client.get(`/organizations/${orgId}`);
      const org = orgRes.data;
      console.log(`[Affinity] findOrgByCeoName("${term}") → found org: ${org?.name}(${org?.id})`);
      return org;
    }
    console.log(`[Affinity] findOrgByCeoName("${term}") → no match`);
    return null;
  } catch (e) {
    console.log('[Affinity] findOrgByCeoName error:', e.response?.status, e.message);
    return null;
  }
}
async function getOrganizationById(orgId, apiKey) {
  if (!orgId) return null;
  try {
    const res = await getClient(apiKey).get(`/organizations/${orgId}`);
    return res.data || null;
  } catch (e) {
    console.log('[Affinity] getOrganizationById error:', e.response?.status, e.message);
    return null;
  }
}

async function upsertOrganization({ name, domain, affinityOrgId, ceoEmail, ceoFirstName, ceoLastName }, apiKey) {
  // 0. Manual Affinity org ID override
  if (affinityOrgId) {
    const org = await getOrganizationById(affinityOrgId, apiKey);
    if (org) { console.log(`[Affinity] using manual org ID ${affinityOrgId} → ${org.name}`); return { org, created: false }; }
  }
  // 1. Run all fast searches in parallel
  const [v2Result, v1Result, emailResult, nameResult] = await Promise.all([
    domain ? findOrganizationV2ByDomain(domain, apiKey) : Promise.resolve(null),
    domain ? findOrganizationByDomain(domain, apiKey) : Promise.resolve(null),
    ceoEmail ? findOrganizationByCeoEmail(ceoEmail, apiKey) : Promise.resolve(null),
    (ceoFirstName || ceoLastName) ? findOrganizationByCeoName(ceoFirstName, ceoLastName, apiKey) : Promise.resolve(null),
  ]);
  let existing = v2Result || v1Result || emailResult || nameResult;
  // 2. Exhaustive scan only if all fast searches failed (slow — last resort)
  if (!existing) existing = await findOrganizationExhaustive(domain, name, apiKey);
  // 3. Name search as absolute last resort
  if (!existing) existing = await findOrganization(name, apiKey);
  const foundByNameOnly = !!(existing && !affinityOrgId && !v2Result && !v1Result && !emailResult && !nameResult && !domain);
  if (existing) {
    console.log(`[Affinity] upsertOrganization("${name}") → found: ${existing.name}(${existing.id})`);
    return { org: existing, created: false, foundByNameOnly };
  }
  // Not found — create it so it gets added to the sourcing list
  console.log(`[Affinity] upsertOrganization("${name}") → not found, creating new org`);
  try {
    const created = await createOrganization({ name, domain }, apiKey);
    console.log(`[Affinity] created new org: ${created.name}(${created.id})`);
    return { org: created, created: true };
  } catch (e) {
    console.log('[Affinity] createOrganization error:', e.response?.status, e.message);
    return { org: null, created: false };
  }
}

// ── Persons ───────────────────────────────────────────────────────────────────

async function findPerson(firstName, lastName, apiKey) {
  const client = getClient(apiKey);
  const term = `${firstName || ''} ${lastName || ''}`.trim();
  const res = await client.get('/persons', { params: { term, page_size: 5 } });
  const people = res.data?.persons || (Array.isArray(res.data) ? res.data : []);
  const exact = people.find(p =>
    p.first_name?.toLowerCase() === (firstName || '').toLowerCase() &&
    p.last_name?.toLowerCase() === (lastName || '').toLowerCase()
  );
  return exact || people[0] || null;
}

async function createPerson({ firstName, lastName, email, organizationId }, apiKey) {
  const client = getClient(apiKey);
  const payload = { first_name: firstName, last_name: lastName };
  if (email) payload.emails = [email];
  if (organizationId) payload.organization_ids = [organizationId];
  const res = await client.post('/persons', payload);
  return res.data;
}

async function upsertPerson({ firstName, lastName, email, organizationId }, apiKey) {
  const existing = await findPerson(firstName, lastName, apiKey);
  if (existing) return { person: existing, created: false };
  const person = await createPerson({ firstName, lastName, email, organizationId }, apiKey);
  return { person, created: true };
}

// ── Users ─────────────────────────────────────────────────────────────────────

// Get current user from Affinity workspace (Affinity v1 /users doesn't exist)
async function getUsers(apiKey) {
  try {
    const me = await getClient(apiKey).get('/auth/whoami');
    const user = me.data?.user || me.data;
    return user ? [user] : [];
  } catch (e) {
    console.log('[Affinity] /auth/whoami error:', e.response?.status, e.message);
    return [];
  }
}

// Extract display name from an Affinity user object (handles camelCase and snake_case)
function userName(u) {
  if (!u) return null;
  if (u.name) return u.name;
  const first = u.firstName || u.first_name || '';
  const last = u.lastName || u.last_name || '';
  return `${first} ${last}`.trim() || null;
}

// Resolve a raw owner value (user ID or object) to a display name
// Fallback map for team member IDs that can't be fetched via the API
const KNOWN_USERS = {
  16057750: 'Ankit Sud',
  26040138: 'Christina Fa',
  32445700: 'Nick Bunick',
  87482981: 'David Divver',
  100285871: 'Chetan Chaudhary',
  173877398: 'Cormac Dunn',
  182265366: 'Nazanin Soltan',
  199216885: 'Ed Peterson',
};

async function resolveOwnerValue(raw, apiKey, cachedUsers) {
  if (!raw) return null;
  if (typeof raw === 'object') return userName(raw);
  // Check hardcoded fallback first
  if (raw in KNOWN_USERS && KNOWN_USERS[raw]) return KNOWN_USERS[raw];
  // raw is a user ID — search cached list first (use == for type safety)
  const users = cachedUsers || await getUsers(apiKey);
  console.log('[Affinity] resolveOwner: looking for', raw, 'in', users.length, 'users, IDs:', users.map(u => u.id));
  // eslint-disable-next-line eqeqeq
  const user = users.find(u => u.id == raw);
  if (user) return userName(user);
  // Last resort: fetch the specific user by ID
  try {
    const res = await getClient(apiKey).get(`/users/${raw}`);
    console.log('[Affinity] /users/:id response:', JSON.stringify(res.data));
    if (res.data) return userName(res.data);
  } catch (e) { console.log('[Affinity] /users/:id error:', e.response?.status, e.message); }
  return null;
}

// Find user whose name matches (fuzzy)
async function findUserByName(name, apiKey) {
  if (!name) return null;
  const needle = name.toLowerCase().trim();

  // Check KNOWN_USERS by name first (works even if /auth/whoami doesn't return all team members)
  const knownEntry = Object.entries(KNOWN_USERS).find(([, n]) => {
    const full = n.toLowerCase();
    return full === needle || full.startsWith(needle) || needle.startsWith(full);
  });
  if (knownEntry) return { id: Number(knownEntry[0]), name: knownEntry[1] };

  const users = await getUsers(apiKey);
  return (
    users.find(u => {
      const full = userName(u)?.toLowerCase() || '';
      return full === needle || full.startsWith(needle) || needle.startsWith(full);
    }) || null
  );
}

// ── Lists ─────────────────────────────────────────────────────────────────────

async function getLists(apiKey) {
  const client = getClient(apiKey);
  const res = await client.get('/lists');
  return Array.isArray(res.data) ? res.data : (res.data?.lists || []);
}

// Find the sourcing list — looks for a list whose name contains "sourcing"
async function getSourcingList(apiKey) {
  const lists = await getLists(apiKey);
  return (
    lists.find(l => l.name?.toLowerCase() === 'sourcing list') ||
    lists.find(l => l.name?.toLowerCase().includes('sourcing')) ||
    lists.find(l => l.type === 8) ||
    lists[0] ||
    null
  );
}

// Add an organization to a list, returns the new list entry
async function addOrgToList(listId, orgId, apiKey) {
  const client = getClient(apiKey);
  const res = await client.post(`/lists/${listId}/list-entries`, {
    entity_id: orgId,
    entity_type: ENTITY_TYPE.ORGANIZATION,
  });
  return res.data;
}

// Find an existing list entry for an org (used when add fails because org is already in list)
async function findListEntry(listId, orgId, apiKey) {
  const client = getClient(apiKey);
  let page = 1;
  while (true) {
    const res = await client.get(`/lists/${listId}/list-entries`, {
      params: { page_size: 100, page },
    });
    const entries = Array.isArray(res.data) ? res.data : (res.data?.list_entries || []);
    const found = entries.find(e => (e.entity_id ?? e.entity?.id) === orgId);
    if (found) return found;
    if (entries.length < 100) return null;
    page++;
  }
}

// ── Fields & Field Values ─────────────────────────────────────────────────────

async function getListFields(listId, apiKey) {
  const client = getClient(apiKey);
  const res = await client.get('/fields', { params: { list_id: listId } });
  return Array.isArray(res.data) ? res.data : [];
}

async function getGlobalFields(apiKey) {
  const client = getClient(apiKey);
  try {
    const res = await client.get('/fields');
    return Array.isArray(res.data) ? res.data : [];
  } catch { return []; }
}

async function setFieldValue({ fieldId, entityId, listEntryId, value }, apiKey) {
  const client = getClient(apiKey);
  // Affinity requires both entity_id + list_entry_id for list fields, entity_id only for global fields
  const payload = listEntryId
    ? { field_id: fieldId, entity_id: entityId, list_entry_id: listEntryId, value }
    : { field_id: fieldId, entity_id: entityId, value };
  const res = await client.post('/field-values', payload);
  return res.data;
}

// POST a new field value; if Affinity rejects (already exists), DELETE + POST
async function upsertFieldValue({ fieldId, entityId, listEntryId, value }, apiKey) {
  try {
    return await setFieldValue({ fieldId, entityId, listEntryId, value }, apiKey);
  } catch (e) {
    const status = e.response?.status;
    if (status === 422 || status === 409) {
      const client = getClient(apiKey);
      const existing = await client.get('/field-values', { params: { organization_id: entityId } })
        .then(r => Array.isArray(r.data) ? r.data : [])
        .catch(() => []);
      const fv = existing.find(f =>
        f.field_id === fieldId &&
        (!listEntryId || f.list_entry_id === listEntryId)
      );
      if (fv) {
        // PATCH is not supported — DELETE the old value and POST the new one
        try { await client.delete(`/field-values/${fv.id}`); } catch (de) {
          console.log('[Affinity] delete field value error (non-fatal):', de.response?.status, de.message);
        }
        return await setFieldValue({ fieldId, entityId, listEntryId, value }, apiKey);
      }
    }
    throw e;
  }
}

// ── High-level: add to sourcing list + set owner & priority ───────────────────

async function addToSourcingList({ orgId, senderName }, apiKey) {
  const out = {
    list: null,
    listEntry: null,
    ownerSet: false,
    priorityFieldValueId: null,
    priorityContext: null,
    connectedOptionId: null,
    errors: [],
  };

  // 1. Find the sourcing list
  out.list = await getSourcingList(apiKey);
  if (!out.list) {
    out.errors.push('No sourcing list found in Affinity');
    return out;
  }

  // 2. Add org to the list (recover existing entry if already there)
  try {
    out.listEntry = await addOrgToList(out.list.id, orgId, apiKey);
  } catch (e) {
    try {
      out.listEntry = await findListEntry(out.list.id, orgId, apiKey);
      if (!out.listEntry) throw new Error('entry not found after add failed');
      console.log('[Affinity] Org already in list — using existing entry:', out.listEntry.id);
    } catch (e2) {
      out.errors.push(`Add to list: ${e.response?.data?.message || e.message}`);
    }
  }

  if (!out.listEntry) return out;

  // 3. Get fields for this list
  let fields = [];
  try {
    fields = await getListFields(out.list.id, apiKey);
  } catch (e) {
    out.errors.push(`Fetch fields: ${e.message}`);
    return out;
  }

  console.log('[Affinity] list fields with options:', fields.map(f => ({
    name: f.name, options: f.dropdown_options?.map(o => o.text)
  })));

  const ownerField = fields.find(f => f.name?.toLowerCase().includes('owner'));

  // Find the field that specifically has a "Chasing" option
  const priorityField = fields.find(f =>
    f.dropdown_options?.some(o => o.text?.toLowerCase().includes('chasing')) ||
    f.allowed_values?.some(o => o.text?.toLowerCase().includes('chasing'))
  );

  console.log('[Affinity] priorityField:', priorityField?.name, '| options:', priorityField?.dropdown_options?.map(o => o.text));

  // 4. Set global owner from senderName
  if (ownerField && senderName) {
    try {
      const user = await findUserByName(senderName, apiKey);
      if (user) {
        await upsertFieldValue({
          fieldId: ownerField.id,
          entityId: orgId,
          listEntryId: out.listEntry.id,
          value: user.id,
        }, apiKey);
        out.ownerSet = true;
      }
    } catch (e) {
      out.errors.push(`Set owner: ${e.message}`);
    }
  }

  // 5. Set priority to "Chasing"
  if (priorityField?.dropdown_options) {
    const chasingOption = priorityField.dropdown_options.find(
      o => o.text?.toLowerCase().includes('chasing')
    );
    const connectedOption = priorityField.dropdown_options.find(
      o => o.text?.toLowerCase().includes('connect')
    );

    console.log('[Affinity] listEntry:', JSON.stringify(out.listEntry));
    console.log('[Affinity] chasingOption:', chasingOption, '| fieldId:', priorityField.id, '| orgId:', orgId);

    if (chasingOption) {
      try {
        const fv = await upsertFieldValue({
          fieldId: priorityField.id,
          entityId: orgId,
          listEntryId: out.listEntry.id,
          value: chasingOption.id,
        }, apiKey);
        out.priorityFieldValueId = fv?.id || null;
        out.priorityContext = { fieldId: priorityField.id, entityId: orgId, listEntryId: out.listEntry.id };
      } catch (e) {
        console.error('[Affinity] set priority error:', e.response?.status, JSON.stringify(e.response?.data));
        out.errors.push(`Set priority: ${e.message}`);
      }
    }

    if (connectedOption) {
      out.connectedOptionId = connectedOption.id;
    }
  }

  return out;
}

// ── Mark as Connected ─────────────────────────────────────────────────────────

async function markConnected({ priorityFieldValueId, priorityContext, connectedOptionId }, apiKey) {
  if (!connectedOptionId) throw new Error('No "Connected" option ID stored');
  const client = getClient(apiKey);

  if (priorityContext?.fieldId) {
    // DELETE existing value (if present), then POST the new "Connected" value
    if (priorityFieldValueId) {
      try { await client.delete(`/field-values/${priorityFieldValueId}`); } catch (de) {
        console.log('[Affinity] markConnected delete error (non-fatal):', de.response?.status, de.message);
      }
    }
    const res = await client.post('/field-values', {
      field_id: priorityContext.fieldId,
      entity_id: priorityContext.entityId,
      list_entry_id: priorityContext.listEntryId,
      value: connectedOptionId,
    });
    return res.data;
  }

  // Legacy fallback (no context stored)
  if (!priorityFieldValueId) throw new Error('No priority field value ID or context stored');
  const res = await client.patch(`/field-values/${priorityFieldValueId}`, { value: connectedOptionId });
  return res.data;
}

// ── Set global owner on an organization ───────────────────────────────────────

async function setGlobalOwner(orgId, ownerName, apiKey) {
  const client = getClient(apiKey);
  const globalFields = await getGlobalFields(apiKey);

  const ownerField =
    globalFields.find(f => f.name?.toLowerCase() === 'global owner') ||
    globalFields.find(f => f.name?.toLowerCase() === 'owner') ||
    globalFields.find(f => f.name?.toLowerCase().includes('owner'));
  console.log('[Affinity] setGlobalOwner — ownerField:', ownerField ? `${ownerField.name}(${ownerField.id})` : 'NOT FOUND');
  if (!ownerField) return false;

  // Check if there's already a global owner set — if so, don't overwrite
  const existingFVs = await client.get('/field-values', { params: { organization_id: orgId } })
    .then(r => Array.isArray(r.data) ? r.data : []).catch(() => []);
  const existingOwnerFV = existingFVs.find(fv => fv.field_id === ownerField.id && fv.value != null);
  if (existingOwnerFV) {
    const users = await getUsers(apiKey);
    const existingOwnerName = await resolveOwnerValue(existingOwnerFV.value, apiKey, users);
    console.log('[Affinity] setGlobalOwner — existing owner found:', existingOwnerName, '— skipping overwrite');
    return existingOwnerName || false;
  }

  const user = await findUserByName(ownerName, apiKey);
  console.log('[Affinity] setGlobalOwner — user resolved:', user ? `${user.name || user.id}(id=${user.id})` : 'NOT FOUND');
  if (!user) return false;

  try {
    await upsertFieldValue({ fieldId: ownerField.id, entityId: orgId, listEntryId: null, value: user.id }, apiKey);
    console.log('[Affinity] setGlobalOwner — success');
    return `${user.first_name || user.name || ''} ${user.last_name || ''}`.trim();
  } catch (e) {
    console.error('[Affinity] setGlobalOwner error:', e.response?.status, JSON.stringify(e.response?.data));
    return false;
  }
}

// ── Lookup company: owner + email history (read-only) ─────────────────────────

async function lookupCompanyInAffinity(companyName, apiKey, domain, ceoEmail) {
  const client = getClient(apiKey);

  // Run all fast searches in parallel — skip exhaustive scan here (read-only lookup, speed matters)
  const [nameResult, domainResult, v2Result, ceoEmailResult] = await Promise.all([
    companyName ? findOrganizationFast(companyName, apiKey) : Promise.resolve(null),
    domain ? findOrganizationByDomain(domain, apiKey) : Promise.resolve(null),
    domain ? findOrganizationV2ByDomain(domain, apiKey) : Promise.resolve(null),
    ceoEmail ? findOrganizationByCeoEmail(ceoEmail, apiKey) : Promise.resolve(null),
  ]);
  let org = nameResult || domainResult || v2Result || ceoEmailResult;
  if (!org) return null;

  const result = {
    orgId: org.id,
    orgName: org.name,
    owner: null,
    owners: [],
    emailsSent: 0,
    lastEmailDate: null,
  };

  // Fetch all field values + global field definitions in parallel
  const [globalFields, fieldValues] = await Promise.all([
    getGlobalFields(apiKey),
    client.get('/field-values', { params: { organization_id: org.id } })
      .then(r => Array.isArray(r.data) ? r.data : [])
      .catch(e => { console.log('[Affinity] field-values error:', e.response?.status, e.message); return []; }),
  ]);

  // ── Global Owner ──────────────────────────────────────────────────────────
  try {
    const ownerField =
      globalFields.find(f => f.name?.toLowerCase() === 'global owner') ||
      globalFields.find(f => f.name?.toLowerCase() === 'owner');
    console.log('[Affinity] ownerField:', ownerField ? `${ownerField.name}(${ownerField.id})` : 'not found');

    if (ownerField) {
      // Affinity ignores the field_id param — filter client-side
      const ownerFVs = fieldValues.filter(fv => fv.field_id === ownerField.id && fv.value != null);
      console.log('[Affinity] owner FVs:', JSON.stringify(ownerFVs));
      // Resolve all FVs newest-first into an owners list
      const sorted = ownerFVs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const users = await getUsers(apiKey);
      for (const fv of sorted) {
        const name = await resolveOwnerValue(fv.value, apiKey, users);
        if (name && !result.owners.includes(name)) result.owners.push(name);
      }
      result.owner = result.owners[0] || null;
    }
  } catch (e) { console.log('[Affinity] owner error:', e.response?.status, e.message); }
  console.log('[Affinity] resolved owner:', result.owner);

  // ── Last contacted ─────────────────────────────────────────────────────────
  // Check org-level interaction dates first (from with_interaction_dates=true on the search)
  const orgDates = org.interaction_dates;
  const orgLastEmail = orgDates?.last_email_date || orgDates?.last_interaction_date || null;
  console.log('[Affinity] org-level last email date:', orgLastEmail);
  result.lastEmailDate = orgLastEmail || await getLastContacted(org.id, client, domain);

  return result;
}

// ── Last contacted ────────────────────────────────────────────────────────────

function _latestTs(items, ...fields) {
  return items.reduce((best, item) => {
    const ts = fields.map(f => item[f]).find(Boolean) || null;
    if (!ts) return best;
    return !best || new Date(ts) > new Date(best) ? ts : best;
  }, null);
}

// Hierarchy: person interaction dates → notes → null
async function getLastContacted(orgId, client, domain) {
  // 1. Fetch persons with interaction dates — only count contacts at the company's own domain
  try {
    const personsRes = await client.get('/persons', {
      params: { organization_id: orgId, with_interaction_dates: true, page_size: 100 },
    });
    const persons = Array.isArray(personsRes.data) ? personsRes.data : (personsRes.data?.persons || []);
    console.log('[Affinity] org persons (with interaction dates):', persons.length);
    console.log('[Affinity] sample emails:', persons.slice(0, 5).map(p => ({ primary: p.primary_email, emails: p.emails })));
    // Filter to only people whose email matches the company domain
    const domainLower = domain?.toLowerCase();
    const domainPersons = domainLower
      ? persons.filter(p => {
          const allEmails = [p.primary_email, ...(p.emails || [])].filter(Boolean).map(e => e.toLowerCase());
          return allEmails.some(e => e.endsWith(`@${domainLower}`));
        })
      : persons;
    console.log('[Affinity] domain-matched persons:', domainPersons.length);
    let best = null;
    for (const p of domainPersons) {
      const d = p.interaction_dates;
      const ts = d?.last_email_date || d?.last_interaction_date || d?.last_event_date || null;
      if (ts && (!best || new Date(ts) > new Date(best))) best = ts;
    }
    if (best) { console.log('[Affinity] last contacted (person interactions):', best); return best; }
  } catch (e) {
    console.log('[Affinity] org persons error:', e.response?.status, e.message);
  }

  // 2. Org notes (manual/sparse fallback)
  try {
    const res = await client.get('/notes', { params: { organization_id: orgId, page_size: 50 } });
    const notes = Array.isArray(res.data) ? res.data : (res.data?.notes || []);
    console.log('[Affinity] notes count:', notes.length);
    const ts = _latestTs(notes, 'created_at', 'updated_at');
    if (ts) { console.log('[Affinity] last contacted (notes):', ts); return ts; }
  } catch (e) {
    console.log('[Affinity] notes error:', e.response?.status, e.message);
  }

  console.log('[Affinity] last contacted: no data found');
  return null;
}

// ── Get all companies from the sourcing list ───────────────────────────────────

async function getSourcingListCompanies(apiKey) {
  const list = await getSourcingList(apiKey);
  if (!list) throw new Error('No sourcing list found in Affinity');

  const client = getClient(apiKey);
  let allEntries = [];
  let page = 1;

  while (true) {
    const res = await client.get(`/lists/${list.id}/list-entries`, {
      params: { page_size: 100, page },
    });
    const entries = Array.isArray(res.data)
      ? res.data
      : (res.data?.list_entries || []);
    allEntries = allEntries.concat(entries);
    if (entries.length < 100) break;
    page++;
  }

  const companies = allEntries
    .filter(e => e.entity && e.entity.name)
    .map(e => ({
      id: e.entity.id,
      name: e.entity.name,
      domain: e.entity.domain_names?.[0] || null,
      listEntryId: e.id,
    }));

  return { list: { id: list.id, name: list.name }, companies };
}

// ── Get owner + last email for a single company ───────────────────────────────

async function getCompanyDetails(orgId, apiKey) {
  const client = getClient(apiKey);
  let owner = null;
  let lastEmailDate = null;
  let emailsSent = 0;

  const [globalFields, users] = await Promise.all([
    getGlobalFields(apiKey),
    getUsers(apiKey),
  ]);

  const ownerField = globalFields.find(f =>
    f.name?.toLowerCase() === 'owner' ||
    f.name?.toLowerCase().includes('global owner') ||
    f.name?.toLowerCase().includes('owner')
  );

  try {
    const fvRes = await client.get('/field-values', { params: { organization_id: orgId } });
    const fieldValues = Array.isArray(fvRes.data) ? fvRes.data : [];
    if (ownerField) {
      const ownerFVs = fieldValues
        .filter(fv => fv.field_id === ownerField.id && fv.value != null)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      for (const fv of ownerFVs) {
        const name = await resolveOwnerValue(fv.value, apiKey, users);
        if (name) { owner = name; break; }
      }
    }
  } catch { /* ok */ }

  lastEmailDate = await getLastContacted(orgId, client);

  return { owner, lastEmailDate, emailsSent };
}

// ── Get sourcing list companies with owner + last email data ──────────────────

async function getSourcingListWithDetails(apiKey) {
  const { list, companies } = await getSourcingListCompanies(apiKey);
  const client = getClient(apiKey);

  // Fetch once: global field definitions + all users
  const [globalFields, users] = await Promise.all([
    getGlobalFields(apiKey),
    getUsers(apiKey),
  ]);

  const ownerField = globalFields.find(f =>
    f.name?.toLowerCase() === 'owner' ||
    f.name?.toLowerCase().includes('global owner') ||
    f.name?.toLowerCase().includes('owner')
  );

  // Enrich each company 5 at a time to avoid rate limits
  const BATCH = 5;
  const enriched = [];
  for (let i = 0; i < companies.length; i += BATCH) {
    const batch = companies.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (company) => {
      let owner = null;
      let lastEmailDate = null;
      let emailsSent = 0;

      try {
        const fvRes = await client.get('/field-values', {
          params: { organization_id: company.id },
        });
        const fieldValues = Array.isArray(fvRes.data) ? fvRes.data : [];
        if (ownerField) {
          const ownerFVs = fieldValues
            .filter(fv => fv.field_id === ownerField.id && fv.value != null)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          for (const fv of ownerFVs) {
            const name = await resolveOwnerValue(fv.value, apiKey, users);
            if (name) { owner = name; break; }
          }
        }
      } catch { /* ok */ }

      lastEmailDate = await getLastContacted(company.id, client);

      return { ...company, owner, lastEmailDate, emailsSent };
    }));
    enriched.push(...results);
  }

  return { list, companies: enriched };
}

module.exports = {
  upsertOrganization,
  upsertPerson,
  addToSourcingList,
  markConnected,
  lookupCompanyInAffinity,
  setGlobalOwner,
  getSourcingListCompanies,
  getSourcingListWithDetails,
  getCompanyDetails,
};
