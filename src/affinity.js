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

// ── Organizations ─────────────────────────────────────────────────────────────

async function findOrganization(name, apiKey) {
  const client = getClient(apiKey);
  const res = await client.get('/organizations', { params: { term: name, page_size: 5 } });
  const orgs = res.data?.organizations || (Array.isArray(res.data) ? res.data : []);
  console.log(`[Affinity] findOrganization("${name}") → ${orgs.length} results:`, orgs.map(o => o.name));
  const exact = orgs.find(o => o.name?.toLowerCase() === name.toLowerCase());
  return exact || orgs[0] || null;
}

async function createOrganization({ name, domain }, apiKey) {
  const client = getClient(apiKey);
  const payload = { name };
  if (domain) payload.domain_names = [domain];
  const res = await client.post('/organizations', payload);
  return res.data;
}

async function upsertOrganization({ name, domain }, apiKey) {
  const existing = await findOrganization(name, apiKey);
  if (existing) return { org: existing, created: false };
  const org = await createOrganization({ name, domain }, apiKey);
  return { org, created: true };
}

// ── Persons ───────────────────────────────────────────────────────────────────

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

// Get all users in the Affinity workspace
async function getUsers(apiKey) {
  const client = getClient(apiKey);
  try {
    const res = await client.get('/users');
    return res.data || [];
  } catch {
    // Fall back to whoami if /users isn't available
    const me = await getClient(apiKey).get('/auth/whoami');
    return me.data ? [me.data] : [];
  }
}

// Find user whose name matches the sender (fuzzy)
async function findUserByName(name, apiKey) {
  if (!name) return null;
  const users = await getUsers(apiKey);
  const needle = name.toLowerCase().trim();
  return (
    users.find(u => {
      const full = `${u.first_name || ''} ${u.last_name || ''}`.trim().toLowerCase();
      return full === needle || full.startsWith(needle) || needle.startsWith(full);
    }) || null
  );
}

// ── Lists ─────────────────────────────────────────────────────────────────────

async function getLists(apiKey) {
  const client = getClient(apiKey);
  const res = await client.get('/lists');
  return res.data || [];
}

// Find the sourcing list — looks for a list whose name contains "sourcing"
async function getSourcingList(apiKey) {
  const lists = await getLists(apiKey);
  return (
    lists.find(l => l.name?.toLowerCase().includes('sourcing')) ||
    lists.find(l => l.type === 8) || // type 8 = companies list in Affinity
    lists[0] ||
    null
  );
}

// Add an organization to a list, returns the new list entry
async function addOrgToList(listId, orgId, apiKey) {
  const client = getClient(apiKey);
  const res = await client.post('/list-entries', {
    list_id: listId,
    entity_id: orgId,
    entity_type: ENTITY_TYPE.ORGANIZATION,
  });
  return res.data;
}

// ── Fields & Field Values ─────────────────────────────────────────────────────

async function getListFields(listId, apiKey) {
  const client = getClient(apiKey);
  const res = await client.get('/fields', { params: { list_id: listId } });
  return res.data || [];
}

async function setFieldValue({ fieldId, entityId, listEntryId, value }, apiKey) {
  const client = getClient(apiKey);
  const res = await client.post('/field-values', {
    field_id: fieldId,
    entity_id: entityId,
    list_entry_id: listEntryId,
    value,
  });
  return res.data;
}

async function updateFieldValue(fieldValueId, value, apiKey) {
  const client = getClient(apiKey);
  const res = await client.patch(`/field-values/${fieldValueId}`, { value });
  return res.data;
}

// ── High-level: add to sourcing list + set owner & priority ───────────────────

async function addToSourcingList({ orgId, senderName }, apiKey) {
  const out = {
    list: null,
    listEntry: null,
    ownerSet: false,
    priorityFieldValueId: null,
    connectedOptionId: null,
    errors: [],
  };

  // 1. Find the sourcing list
  out.list = await getSourcingList(apiKey);
  if (!out.list) {
    out.errors.push('No sourcing list found in Affinity');
    return out;
  }

  // 2. Add org to the list
  try {
    out.listEntry = await addOrgToList(out.list.id, orgId, apiKey);
  } catch (e) {
    // Might already be in the list — try to continue
    out.errors.push(`Add to list: ${e.response?.data?.message || e.message}`);
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

  const ownerField = fields.find(f => f.name?.toLowerCase().includes('owner'));
  const priorityField = fields.find(f =>
    f.name?.toLowerCase().includes('priority') ||
    f.name?.toLowerCase().includes('status')
  );

  // 4. Set global owner from senderName
  if (ownerField && senderName) {
    try {
      const user = await findUserByName(senderName, apiKey);
      if (user) {
        await setFieldValue({
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

    if (chasingOption) {
      try {
        const fv = await setFieldValue({
          fieldId: priorityField.id,
          entityId: orgId,
          listEntryId: out.listEntry.id,
          value: chasingOption.id,
        }, apiKey);
        out.priorityFieldValueId = fv?.id || null;
      } catch (e) {
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

async function markConnected({ priorityFieldValueId, connectedOptionId }, apiKey) {
  if (!priorityFieldValueId) throw new Error('No priority field value ID stored');
  if (!connectedOptionId) throw new Error('No "Connected" option ID stored');
  return updateFieldValue(priorityFieldValueId, connectedOptionId, apiKey);
}

// ── Set global owner on an organization ───────────────────────────────────────

async function setGlobalOwner(orgId, ownerName, apiKey) {
  const client = getClient(apiKey);
  let globalFields = [];
  try {
    const res = await client.get('/fields', { params: { value_type: 0 } });
    globalFields = Array.isArray(res.data) ? res.data : [];
  } catch { return false; }

  const ownerField = globalFields.find(f =>
    f.name?.toLowerCase() === 'owner' ||
    f.name?.toLowerCase().includes('global owner') ||
    f.name?.toLowerCase().includes('owner')
  );
  if (!ownerField) return false;

  const user = await findUserByName(ownerName, apiKey);
  if (!user) return false;

  try {
    await setFieldValue({ fieldId: ownerField.id, entityId: orgId, listEntryId: null, value: user.id }, apiKey);
    return `${user.first_name || ''} ${user.last_name || ''}`.trim();
  } catch { return false; }
}

// ── Lookup company: owner + email history (read-only) ─────────────────────────

async function lookupCompanyInAffinity(companyName, apiKey) {
  const client = getClient(apiKey);

  const org = await findOrganization(companyName, apiKey);
  if (!org) return null;

  const result = {
    orgId: org.id,
    orgName: org.name,
    owner: null,
    emailsSent: 0,
    lastEmailDate: null,
  };

  // Get global field definitions
  let globalFields = [];
  try {
    const res = await client.get('/fields', { params: { value_type: 0 } });
    globalFields = Array.isArray(res.data) ? res.data : [];
  } catch { /* ok */ }

  // Get field values for this org
  let fieldValues = [];
  try {
    const res = await client.get('/field-values', { params: { organization_id: org.id } });
    fieldValues = Array.isArray(res.data) ? res.data : [];
  } catch { /* ok */ }

  // Resolve owner field
  const ownerField = globalFields.find(f =>
    f.name?.toLowerCase() === 'owner' ||
    f.name?.toLowerCase().includes('global owner') ||
    f.name?.toLowerCase().includes('owner')
  );
  if (ownerField) {
    const ownerFV = fieldValues.find(fv => fv.field_id === ownerField.id);
    if (ownerFV?.value != null) {
      const raw = ownerFV.value;
      if (typeof raw === 'object' && raw !== null) {
        // Affinity returned the user object directly
        result.owner = raw.name ||
          `${raw.first_name || ''} ${raw.last_name || ''}`.trim() ||
          String(raw.id || raw);
      } else {
        // raw is a user ID — look it up
        try {
          const users = await getUsers(apiKey);
          const user = users.find(u => u.id === raw);
          result.owner = user
            ? `${user.first_name || ''} ${user.last_name || ''}`.trim()
            : String(raw);
        } catch { result.owner = String(raw); }
      }
    }
  }

  // Get email interactions
  try {
    const res = await client.get('/interactions', {
      params: { organization_id: org.id },
    });
    const interactions = res.data?.interactions || (Array.isArray(res.data) ? res.data : []);
    const emails = interactions.filter(i =>
      !i.interaction_type || i.interaction_type === 'email'
    );
    result.emailsSent = emails.length;
    if (emails.length > 0) result.lastEmailDate = emails[0]?.date || null;
  } catch { /* interactions endpoint may not exist */ }

  return result;
}

module.exports = {
  upsertOrganization,
  upsertPerson,
  addToSourcingList,
  markConnected,
  lookupCompanyInAffinity,
  setGlobalOwner,
};
