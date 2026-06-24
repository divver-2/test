const apollo = require('./apollo');
const affinity = require('./affinity');
const { buildEmailSequence, FOLLOWUP_DELAY_DAYS } = require('./emailGenerator');

const SEQUENCE_NAME_PREFIX = 'CEO Outreach —';

// Main orchestration: look up contact, generate emails, create sequence in Apollo CRM
async function runOutreachSequence({ email, senderName }) {
  const results = {
    contact: null,
    ceo: null,
    organization: null,
    emailSequence: [],
    apolloSequence: null,
    crmAccount: null,
    crmContact: null,
    affinityOrg: null,
    affinityPerson: null,
    affinityList: null,
    errors: [],
  };

  // 1. Enrich the contact from the provided email
  try {
    results.contact = await apollo.enrichContact(email);
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
    results.organization = await apollo.enrichOrganization(domain);
  } catch (e) {
    results.errors.push(`Organization enrichment failed: ${e.message}`);
  }

  const orgName = results.organization?.name || companyName;
  const industry = results.organization?.industry || '';

  // 4. Find the CEO
  try {
    results.ceo = await apollo.findCEO(domain);
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
      results.crmAccount = await apollo.upsertAccount(results.organization);
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
      const { contact, created } = await apollo.upsertContact(contactPayload);
      results.crmContact = { ...contact, wasCreated: created };
    } catch (e) {
      results.errors.push(`CRM contact creation failed: ${e.message}`);
    }
  }

  // 8. Sync to Affinity CRM
  const affinityKey = process.env.AFFINITY_API_KEY;
  if (affinityKey && results.organization) {
    try {
      const { org, created: orgCreated } = await affinity.upsertOrganization(
        { name: orgName, domain },
        affinityKey
      );
      results.affinityOrg = { ...org, wasCreated: orgCreated };

      if (results.ceo) {
        const { person, created: personCreated } = await affinity.upsertPerson(
          {
            firstName: results.ceo.first_name,
            lastName: results.ceo.last_name,
            email: ceoEmail,
            organizationId: org.id,
          },
          affinityKey
        );
        results.affinityPerson = { ...person, wasCreated: personCreated };
      }

      results.affinityList = await affinity.addToSourcingList(
        { orgId: org.id, senderName },
        affinityKey
      );
    } catch (e) {
      results.errors.push(`Affinity sync failed: ${e.message}`);
    }
  }

  // 9. Find or create the Apollo sequence
  try {
    const sequenceName = `${SEQUENCE_NAME_PREFIX} ${orgName}`;
    const existing = await apollo.searchSequences(sequenceName);
    if (existing.length > 0) {
      results.apolloSequence = { ...existing[0], alreadyExisted: true };
    } else {
      results.apolloSequence = await apollo.createSequence(sequenceName);
    }
  } catch (e) {
    results.errors.push(`Sequence creation failed: ${e.message}`);
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
      crmContactId: results.crmContact?.id,
      crmAccountId: results.crmAccount?.id,
    },
    affinityCrm: {
      orgId: results.affinityOrg?.id,
      orgName: results.affinityOrg?.name,
      orgCreated: results.affinityOrg?.wasCreated || false,
      personId: results.affinityPerson?.id,
      personCreated: results.affinityPerson?.wasCreated || false,
      listId: results.affinityList?.list?.id || null,
      listName: results.affinityList?.list?.name || null,
      listEntryId: results.affinityList?.listEntry?.id || null,
      ownerSet: results.affinityList?.ownerSet || false,
      priorityFieldValueId: results.affinityList?.priorityFieldValueId || null,
      connectedOptionId: results.affinityList?.connectedOptionId || null,
      sourcingErrors: results.affinityList?.errors || [],
    },
    errors: results.errors,
  };
}

// Enrich company by domain: get CEO + company info via MCP proxy, owner + emails from Affinity
async function runOutreachByCompany({ companyName }) {
  const results = { organization: null, ceo: null, affinityData: null, errors: [] };

  const looksLikeDomain = companyName.includes('.') && !companyName.includes(' ');
  let domain = looksLikeDomain ? companyName.toLowerCase() : null;

  if (!looksLikeDomain) {
    try {
      console.log('[Step 1] Searching company:', companyName);
      const found = await apollo.searchCompanyByName(companyName);
      if (found) {
        results.organization = found;
        domain = found.primary_domain || found.domain;
        console.log('[Step 1] Found:', found.name, '| domain:', domain);
      }
    } catch (e) {
      console.error('[Step 1] FAILED:', e.message);
      results.errors.push(`Company search failed: ${e.message}`);
    }
  }

  // 2. Enrich org for full details
  if (domain) {
    try {
      console.log('[Step 2] Enriching org for domain:', domain);
      const enriched = await apollo.enrichOrganization(domain);
      if (enriched) results.organization = enriched;
    } catch (e) {
      console.error('[Step 2] FAILED:', e.message);
      results.errors.push(`Organization enrichment failed: ${e.message}`);
    }
  }

  const orgName = results.organization?.name || companyName;

  // 3. Find CEO by domain, then enrich for email
  if (domain) {
    try {
      console.log('[Step 3] Finding CEO for domain:', domain);
      const ceoBasic = await apollo.findCEO(domain);
      if (ceoBasic?.first_name) {
        console.log('[Step 3] CEO found:', ceoBasic.first_name, ceoBasic.last_name, '— enriching for email');
        const enriched = await apollo.enrichPersonByNameAndDomain(
          ceoBasic.first_name, ceoBasic.last_name, domain, null, ceoBasic.id, orgName
        );
        results.ceo = enriched || ceoBasic;
      } else {
        results.ceo = ceoBasic;
      }
    } catch (e) {
      console.error('[Step 3] FAILED:', e.message);
      results.errors.push(`CEO lookup failed: ${e.message}`);
    }
  }

  if (results.ceo) {
    console.log('[CEO raw]', JSON.stringify({
      id: results.ceo.id,
      name: `${results.ceo.first_name} ${results.ceo.last_name}`,
      title: results.ceo.title,
      email: results.ceo.email,
      linkedin_url: results.ceo.linkedin_url,
      personal_emails: results.ceo.personal_emails,
      email_status: results.ceo.email_status,
    }, null, 2));
  }

  const ceoName = results.ceo
    ? `${results.ceo.first_name || ''} ${results.ceo.last_name || ''}`.trim()
    : null;
  const ceoEmail =
    results.ceo?.email ||
    results.ceo?.work_email ||
    results.ceo?.personal_emails?.[0] ||
    results.ceo?.contact_emails?.[0]?.email ||
    null;

  // 4. Generate proposed email
  const emailSequence = buildEmailSequence({
    ceoName,
    companyName: orgName,
    industry: results.organization?.industry || '',
    senderName: 'David Divver',
  });

  // 5. Lookup in Affinity (read-only, no owner override)
  const affinityKey = process.env.AFFINITY_API_KEY;
  if (affinityKey) {
    try {
      results.affinityData = await affinity.lookupCompanyInAffinity(orgName, affinityKey);
    } catch (e) {
      results.errors.push(`Affinity lookup failed: ${e.message}`);
    }
  }

  return {
    success: results.errors.length === 0,
    ceo: {
      name: ceoName,
      email: ceoEmail,
      title: results.ceo?.title,
      linkedinUrl: results.ceo?.linkedin_url || null,
      emailVerified: results.ceo?.email_status === 'verified',
    },
    company: {
      name: orgName,
      domain,
      industry: results.organization?.industry || '',
      website: results.organization?.website_url,
      employees: results.organization?.estimated_num_employees,
      logo: results.organization?.logo_url,
      description: results.organization?.short_description,
      funding: results.organization?.total_funding_printed,
      fundingStage: results.organization?.latest_funding_stage,
    },
    affinity: results.affinityData ? {
      inAffinity: true,
      owner: results.affinityData.owner,
      emailsSent: results.affinityData.emailsSent,
      lastEmailDate: results.affinityData.lastEmailDate,
    } : { inAffinity: false, owner: null, emailsSent: 0, lastEmailDate: null },
    emailDraft: emailSequence[0] || null,
    errors: results.errors,
  };
}

module.exports = { runOutreachSequence, runOutreachByCompany };
