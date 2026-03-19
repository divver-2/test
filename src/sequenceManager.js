const apollo = require('./apollo');
const { buildEmailSequence, FOLLOWUP_DELAY_DAYS } = require('./emailGenerator');

const SEQUENCE_NAME_PREFIX = 'CEO Outreach —';

// Main orchestration: look up contact, generate emails, create sequence in Apollo CRM
async function runOutreachSequence({ email, senderName, apiKey }) {
  const results = {
    contact: null,
    ceo: null,
    organization: null,
    emailSequence: [],
    apolloSequence: null,
    crmAccount: null,
    crmContact: null,
    errors: [],
  };

  // 1. Enrich the contact from the provided email
  try {
    results.contact = await apollo.enrichContact(email, apiKey);
  } catch (e) {
    results.errors.push(`Contact enrichment failed: ${e.message}`);
  }

  // 2. Determine the company domain
  const domain = email.split('@')[1];
  const companyName =
    results.contact?.organization?.name ||
    results.contact?.employment_history?.[0]?.organization_name ||
    domain;

  // 3. Enrich organization data
  try {
    results.organization = await apollo.enrichOrganization(domain, apiKey);
  } catch (e) {
    results.errors.push(`Organization enrichment failed: ${e.message}`);
  }

  const orgName = results.organization?.name || companyName;
  const industry = results.organization?.industry || '';

  // 4. Find the CEO
  try {
    results.ceo = await apollo.findCEO(domain, apiKey);
  } catch (e) {
    results.errors.push(`CEO lookup failed: ${e.message}`);
  }

  const ceoName = results.ceo
    ? `${results.ceo.first_name || ''} ${results.ceo.last_name || ''}`.trim()
    : null;
  const ceoEmail = results.ceo?.email || results.ceo?.personal_emails?.[0] || null;

  // 5. Generate the email sequence
  results.emailSequence = buildEmailSequence({
    ceoName,
    companyName: orgName,
    industry,
    senderName,
  });

  // 6. Upsert account in Apollo CRM
  if (results.organization) {
    try {
      results.crmAccount = await apollo.upsertAccount(results.organization, apiKey);
    } catch (e) {
      results.errors.push(`CRM account creation failed: ${e.message}`);
    }
  }

  // 7. Upsert CEO as a contact in Apollo CRM
  if (results.ceo) {
    try {
      const contactPayload = {
        first_name: results.ceo.first_name,
        last_name: results.ceo.last_name,
        email: ceoEmail,
        title: results.ceo.title,
        organization_name: orgName,
        account_id: results.crmAccount?.id,
      };
      const { contact, created } = await apollo.upsertContact(contactPayload, apiKey);
      results.crmContact = { ...contact, wasCreated: created };
    } catch (e) {
      results.errors.push(`CRM contact creation failed: ${e.message}`);
    }
  }

  // 8. Find or create the Apollo sequence
  try {
    const sequenceName = `${SEQUENCE_NAME_PREFIX} ${orgName}`;
    const existing = await apollo.searchSequences(sequenceName, apiKey);
    if (existing.length > 0) {
      results.apolloSequence = { ...existing[0], alreadyExisted: true };
    } else {
      const emailAccounts = await apollo.getEmailAccounts(apiKey);
      const emailAccountId = emailAccounts[0]?.id || null;
      results.apolloSequence = await apollo.createSequence(sequenceName, emailAccountId, apiKey);
    }
  } catch (e) {
    results.errors.push(`Sequence creation failed: ${e.message}`);
  }

  // 9. Add CEO contact to the sequence
  if (results.apolloSequence && results.crmContact) {
    try {
      const emailAccounts = await apollo.getEmailAccounts(apiKey);
      const emailAccountId = emailAccounts[0]?.id || null;
      await apollo.addContactToSequence(
        results.apolloSequence.id,
        results.crmContact.id,
        emailAccountId,
        apiKey
      );
      results.apolloSequence.contactAdded = true;
    } catch (e) {
      results.errors.push(`Adding contact to sequence failed: ${e.message}`);
      results.apolloSequence.contactAdded = false;
    }
  }

  return {
    success: results.errors.length === 0,
    ceo: {
      name: ceoName,
      email: ceoEmail,
      title: results.ceo?.title,
    },
    company: {
      name: orgName,
      domain,
      industry,
      website: results.organization?.website_url,
      employees: results.organization?.num_employees,
    },
    emailSequence: results.emailSequence,
    apollo: {
      sequenceId: results.apolloSequence?.id,
      sequenceName: results.apolloSequence?.name,
      sequenceAlreadyExisted: results.apolloSequence?.alreadyExisted || false,
      contactAdded: results.apolloSequence?.contactAdded || false,
      crmContactId: results.crmContact?.id,
      crmAccountId: results.crmAccount?.id,
    },
    errors: results.errors,
  };
}

// Full flow from company name: enrich → CEO → CRM → sequence
async function runOutreachByCompany({ companyName, senderName, apiKey }) {
  const results = {
    organization: null,
    ceo: null,
    emailSequence: [],
    apolloSequence: null,
    crmAccount: null,
    crmContact: null,
    errors: [],
  };

  // 1. Search for company to get domain
  let domain = null;
  try {
    const found = await apollo.searchCompanyByName(companyName, apiKey);
    if (found) {
      results.organization = found;
      domain = found.primary_domain || found.domain;
    }
  } catch (e) {
    results.errors.push(`Company search failed: ${e.message}`);
  }

  // 2. Enrich org for full details (description, funding, etc.)
  if (domain) {
    try {
      const enriched = await apollo.enrichOrganization(domain, apiKey);
      if (enriched) results.organization = enriched;
    } catch (e) {
      results.errors.push(`Organization enrichment failed: ${e.message}`);
    }
  }

  const orgName = results.organization?.name || companyName;
  const industry = results.organization?.industry || '';

  // 3. Find CEO, then enrich to get verified email
  if (domain) {
    try {
      const ceoBasic = await apollo.findCEO(domain, apiKey);
      if (ceoBasic?.id) {
        results.ceo = await apollo.enrichPersonById(ceoBasic.id, apiKey) || ceoBasic;
      } else {
        results.ceo = ceoBasic;
      }
    } catch (e) {
      results.errors.push(`CEO lookup failed: ${e.message}`);
    }
  }

  const ceoName = results.ceo
    ? `${results.ceo.first_name || ''} ${results.ceo.last_name || ''}`.trim()
    : null;
  const ceoEmail = results.ceo?.email || results.ceo?.personal_emails?.[0] || null;

  // 4. Generate email sequence
  results.emailSequence = buildEmailSequence({
    ceoName,
    companyName: orgName,
    industry,
    senderName: senderName || 'Your Name',
  });

  // 5. Upsert account in CRM
  if (results.organization) {
    try {
      results.crmAccount = await apollo.upsertAccount(results.organization, apiKey);
    } catch (e) {
      results.errors.push(`CRM account creation failed: ${e.message}`);
    }
  }

  // 6. Upsert CEO contact in CRM
  if (results.ceo) {
    try {
      const contactPayload = {
        first_name: results.ceo.first_name,
        last_name: results.ceo.last_name,
        email: ceoEmail,
        title: results.ceo.title,
        organization_name: orgName,
        account_id: results.crmAccount?.id,
      };
      const { contact, created } = await apollo.upsertContact(contactPayload, apiKey);
      results.crmContact = { ...contact, wasCreated: created };
    } catch (e) {
      results.errors.push(`CRM contact creation failed: ${e.message}`);
    }
  }

  // 7. Find or create sequence
  try {
    const sequenceName = `${SEQUENCE_NAME_PREFIX} ${orgName}`;
    const existing = await apollo.searchSequences(sequenceName, apiKey);
    if (existing.length > 0) {
      results.apolloSequence = { ...existing[0], alreadyExisted: true };
    } else {
      const emailAccounts = await apollo.getEmailAccounts(apiKey);
      const emailAccountId = emailAccounts[0]?.id || null;
      results.apolloSequence = await apollo.createSequence(sequenceName, emailAccountId, apiKey);
    }
  } catch (e) {
    results.errors.push(`Sequence creation failed: ${e.message}`);
  }

  // 8. Add CEO to sequence
  if (results.apolloSequence && results.crmContact) {
    try {
      const emailAccounts = await apollo.getEmailAccounts(apiKey);
      const emailAccountId = emailAccounts[0]?.id || null;
      await apollo.addContactToSequence(
        results.apolloSequence.id,
        results.crmContact.id,
        emailAccountId,
        apiKey
      );
      results.apolloSequence.contactAdded = true;
    } catch (e) {
      results.errors.push(`Adding contact to sequence failed: ${e.message}`);
      results.apolloSequence.contactAdded = false;
    }
  }

  return {
    success: results.errors.length === 0,
    ceo: {
      name: ceoName,
      email: ceoEmail,
      title: results.ceo?.title,
      emailVerified: results.ceo?.email_status === 'verified',
    },
    company: {
      name: orgName,
      domain,
      industry,
      website: results.organization?.website_url,
      employees: results.organization?.estimated_num_employees,
      logo: results.organization?.logo_url,
      description: results.organization?.short_description,
      funding: results.organization?.total_funding_printed,
      fundingStage: results.organization?.latest_funding_stage,
    },
    emailSequence: results.emailSequence,
    apollo: {
      sequenceId: results.apolloSequence?.id,
      sequenceName: results.apolloSequence?.name,
      sequenceAlreadyExisted: results.apolloSequence?.alreadyExisted || false,
      contactAdded: results.apolloSequence?.contactAdded || false,
      crmContactId: results.crmContact?.id,
      crmContactNew: results.crmContact?.wasCreated || false,
      crmAccountId: results.crmAccount?.id,
    },
    errors: results.errors,
  };
}

module.exports = { runOutreachSequence, runOutreachByCompany };
