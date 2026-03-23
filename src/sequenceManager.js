const apollo = require('./apollo');
const affinity = require('./affinity');
const hunter = require('./hunter');
const { buildEmailSequence, FOLLOWUP_DELAY_DAYS } = require('./emailGenerator');
const tracker = require('./outreachTracker');

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
    affinityOrg: null,
    affinityPerson: null,
    affinityList: null,
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
  const ceoEmail = results.ceo?.email || results.ceo?.work_email || results.ceo?.personal_emails?.[0] || null;

  // 5. Generate the email sequence
  results.emailSequence = await buildEmailSequence({
    ceoName,
    companyName: orgName,
    industry,
    description: results.organization?.short_description || '',
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

      // Add to sourcing list, set global owner + priority = Chasing
      results.affinityList = await affinity.addToSourcingList(
        { orgId: org.id, senderName },
        affinityKey
      );

      // Persist IDs so the Apollo reply webhook can flip status to Connected
      if (results.affinityList?.priorityFieldValueId && results.affinityList?.connectedOptionId) {
        tracker.saveTracking(domain, {
          priorityFieldValueId: results.affinityList.priorityFieldValueId,
          connectedOptionId: results.affinityList.connectedOptionId,
          orgId: org.id,
        });
      }
    } catch (e) {
      results.errors.push(`Affinity sync failed: ${e.message}`);
    }
  }

  // 9. Find or create the Apollo sequence (with email steps)
  try {
    const sequenceName = `${SEQUENCE_NAME_PREFIX} ${orgName}`;
    const emailAccounts = await apollo.getEmailAccounts(apiKey);
    const emailAccountId = emailAccounts[0]?.id || null;
    const existing = await apollo.searchSequences(sequenceName, apiKey);
    if (existing.length > 0) {
      results.apolloSequence = { ...existing[0], alreadyExisted: true };
    } else {
      const { campaign } = await apollo.createSequenceWithSteps(sequenceName, results.emailSequence, emailAccountId, apiKey);
      results.apolloSequence = campaign;
    }
  } catch (e) {
    results.errors.push(`Sequence creation failed: ${e.message}`);
  }

  // 10. Add CEO contact to the sequence (enrolls — triggers sending)
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
      linkedinUrl: results.ceo?.linkedin_url || null,
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

// Enrich company by name/domain: get CEO + company info from Apollo, owner + emails from Affinity
async function runOutreachByCompany({ companyName, apiKey, affinityKey }) {
  const results = { organization: null, ceo: null, affinityData: null, errors: [], usedHunter: false };

  // 1. If input looks like a domain, use it directly
  const looksLikeDomain = companyName.includes('.') && !companyName.includes(' ');
  let domain = looksLikeDomain ? companyName.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') : null;

  if (looksLikeDomain) {
    console.log('[Step 1] Input looks like domain, using directly:', domain);
  } else {
    try {
      console.log('[Step 1] Searching company:', companyName);
      const found = await apollo.searchCompanyByName(companyName, apiKey);
      if (found) {
        results.organization = found;
        domain = found.primary_domain || found.domain;
        console.log('[Step 1] Found:', found.name, '| domain:', domain);
      } else {
        console.log('[Step 1] No company found');
      }
    } catch (e) {
      const status = e.response?.status;
      if (status === 403 && !domain) {
        // Apollo search unavailable and we have no domain — nothing more to try
        console.log('[Step 1] Apollo search not available on this plan');
      } else {
        console.error('[Step 1] FAILED:', status, e.response?.data || e.message);
        results.errors.push(`Company search failed: ${e.response?.data?.message || e.message}`);
      }
    }
  }

  // 2. Enrich org for full details via Apollo; fall back to Hunter.io
  if (domain) {
    try {
      console.log('[Step 2] Enriching org for domain:', domain);
      const enriched = await apollo.enrichOrganization(domain, apiKey);
      if (enriched) results.organization = enriched;
      console.log('[Step 2] Done');
    } catch (e) {
      const status = e.response?.status;
      if (status === 403 && hunterKey) {
        console.log('[Step 2] Apollo not available, trying Hunter.io');
        try {
          const hunterData = await hunter.lookupDomain(domain, hunterKey);
          if (hunterData.company) results.organization = hunterData.company;
          if (hunterData.ceo) results.ceo = hunterData.ceo;
          results.usedHunter = true;
          console.log('[Step 2] Hunter.io done:', results.organization?.name, '| CEO:', results.ceo?.first_name, results.ceo?.last_name);
        } catch (he) {
          console.error('[Step 2] Hunter.io FAILED:', he.response?.data || he.message);
          results.errors.push(`Hunter.io lookup failed: ${he.message}`);
        }
      } else {
        console.error('[Step 2] FAILED:', status, e.response?.data || e.message);
        results.errors.push(`Organization enrichment failed: ${e.response?.data?.message || e.message}`);
      }
    }
  }

  const orgName = results.organization?.name || companyName;

  // 3. Find CEO via Apollo (skip if Hunter already found one)
  if (domain && !results.ceo) {
    try {
      console.log('[Step 3] Finding CEO for domain:', domain);
      const ceoBasic = await apollo.findCEO(domain, apiKey);
      if (ceoBasic?.first_name) {
        console.log('[Step 3] CEO found:', ceoBasic.first_name, ceoBasic.last_name, '— enriching for email');
        const enriched = await apollo.enrichPersonByNameAndDomain(
          ceoBasic.first_name, ceoBasic.last_name, domain, apiKey, ceoBasic.id, orgName
        );
        results.ceo = enriched || ceoBasic;
      } else {
        results.ceo = ceoBasic;
      }
      console.log('[Step 3] Done');
    } catch (e) {
      const status = e.response?.status;
      if (status === 403 && hunterKey && !results.usedHunter) {
        console.log('[Step 3] Apollo not available, trying Hunter.io for CEO');
        try {
          const hunterData = await hunter.lookupDomain(domain, hunterKey);
          if (hunterData.company && !results.organization) results.organization = hunterData.company;
          if (hunterData.ceo) results.ceo = hunterData.ceo;
          results.usedHunter = true;
          console.log('[Step 3] Hunter.io CEO:', results.ceo?.first_name, results.ceo?.last_name);
        } catch (he) {
          console.error('[Step 3] Hunter.io FAILED:', he.response?.data || he.message);
          results.errors.push(`CEO lookup failed (Hunter.io): ${he.message}`);
        }
      } else if (status !== 403) {
        console.error('[Step 3] FAILED:', status, e.response?.data || e.message);
        results.errors.push(`CEO lookup failed: ${e.response?.data?.message || e.message}`);
      }
    }
  }

  if (results.ceo) {
    console.log('[CEO raw]', JSON.stringify({
      id: results.ceo.id,
      name: `${results.ceo.first_name} ${results.ceo.last_name}`,
      title: results.ceo.title,
      email: results.ceo.email,
      work_email: results.ceo.work_email,
      personal_emails: results.ceo.personal_emails,
      linkedin_url: results.ceo.linkedin_url,
      email_status: results.ceo.email_status,
    }, null, 2));
  } else {
    console.log('[CEO raw] null — no CEO found for domain:', domain);
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
  const emailSequence = await buildEmailSequence({
    ceoName,
    companyName: orgName,
    industry: results.organization?.industry || '',
    description: results.organization?.short_description || '',
    senderName: 'David Divver',
  });

  // 5. Lookup in Affinity — read-only: get Global Owner
  const usedAffinityKey = affinityKey || process.env.AFFINITY_API_KEY;
  if (usedAffinityKey) {
    try {
      results.affinityData = await affinity.lookupCompanyInAffinity(companyName, usedAffinityKey, domain, ceoEmail);
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
      emailVerified: results.ceo?.email_status === 'verified',
      linkedinUrl: results.ceo?.linkedin_url || null,
      firstName: results.ceo?.first_name || null,
      lastName: results.ceo?.last_name || null,
      apolloId: results.ceo?.id || null,
    },
    company: {
      name: orgName,
      domain,
      industry: results.organization?.industry || '',
      website: results.organization?.website_url,
      employees: results.organization?.estimated_num_employees || results.organization?.num_employees,
      logo: results.organization?.logo_url,
      description: results.organization?.short_description,
      funding: results.organization?.total_funding_printed,
      fundingStage: results.organization?.latest_funding_stage,
    },
    affinity: results.affinityData ? {
      inAffinity: true,
      owner: results.affinityData.owner,
      owners: results.affinityData.owners || [],
      emailsSent: results.affinityData.emailsSent,
      lastEmailDate: results.affinityData.lastEmailDate,
    } : { inAffinity: false, owner: null, owners: [], emailsSent: 0, lastEmailDate: null },
    emailDraft: emailSequence[0] || null,
    emailSequence,
    errors: results.errors,
  };
}

// Launch full email outreach: create Apollo CRM records, build sequence with steps, enroll contact
async function launchEmailOutreach({ companyData, ceoData, emailSequence, apiKey }) {
  const results = { contact: null, account: null, sequence: null, enrolled: false, errors: [] };

  // 1. Get email accounts (required for sending)
  let emailAccountId = null;
  try {
    const accounts = await apollo.getEmailAccounts(apiKey);
    emailAccountId = accounts[0]?.id || null;
  } catch (e) {
    results.errors.push(`Email accounts: ${e.response?.data?.message || e.message}`);
  }

  if (!emailAccountId) {
    results.errors.push('No connected email account found in Apollo — connect an inbox in Apollo Settings first.');
    return { success: false, ...results };
  }

  // 2. Upsert account
  if (companyData?.name) {
    try {
      results.account = await apollo.upsertAccount(companyData, apiKey);
    } catch (e) {
      results.errors.push(`Account: ${e.response?.data?.message || e.message}`);
    }
  }

  // 3. Upsert contact
  if (!ceoData?.email) {
    results.errors.push('CEO email is required to send outreach.');
    return { success: false, ...results };
  }

  try {
    const { contact } = await apollo.upsertContact({
      first_name: ceoData.firstName,
      last_name: ceoData.lastName,
      email: ceoData.email,
      title: ceoData.title,
      organization_name: companyData?.name,
      account_id: results.account?.id,
    }, apiKey);
    results.contact = contact;
  } catch (e) {
    results.errors.push(`Contact: ${e.response?.data?.message || e.message}`);
    return { success: false, ...results };
  }

  // 4. Create sequence with all email steps (or find existing)
  const sequenceName = `${SEQUENCE_NAME_PREFIX} ${companyData?.name || 'Unknown'}`;
  try {
    const existing = (await apollo.searchSequences(sequenceName, apiKey)).filter(s => s.name === sequenceName);
    if (existing.length > 0) {
      console.log('[launchEmailOutreach] Found existing sequence:', existing[0].id, existing[0].name);
      results.sequence = { ...existing[0], _existingSequence: true };
    } else {
      const { campaign, stepResults } = await apollo.createSequenceWithSteps(
        sequenceName, emailSequence, emailAccountId, apiKey
      );
      results.sequence = campaign;
      console.log('[launchEmailOutreach] Created new sequence:', campaign.id, campaign.name);
      const failedSteps = stepResults.filter(s => !s.ok);
      if (failedSteps.length > 0) {
        results.errors.push(`${failedSteps.length} email step(s) failed to create: ${failedSteps.map(s => s.error).join(', ')}`);
      }
    }
  } catch (e) {
    results.errors.push(`Sequence: ${e.response?.data?.message || e.message}`);
    return { success: false, ...results };
  }

  // 5. Enroll contact in sequence starting at step 2 (initial email already sent manually)
  // Brief delay after fresh sequence creation — Apollo needs a moment to commit steps before enrollment
  if (!results.sequence._existingSequence) {
    await new Promise(r => setTimeout(r, 2000));
  }
  try {
    const steps = await apollo.getSequenceSteps(results.sequence.id, apiKey);
    console.log('[launchEmailOutreach] Steps fetched:', steps.map(s => ({ id: s.id, position: s.position, type: s.type })));
    const startingStepId = steps[1]?.id;
    if (!startingStepId) throw new Error('Step 2 not found in sequence — cannot enroll without risking sending email 1 again');
    console.log('[launchEmailOutreach] Enrolling — sequenceId:', results.sequence.id, 'contactId:', results.contact.id, 'emailAccountId:', emailAccountId, 'startingStepId:', startingStepId);
    await apollo.addContactToSequence(results.sequence.id, results.contact.id, emailAccountId, apiKey, startingStepId);
    results.enrolled = true;
  } catch (e) {
    console.error('[launchEmailOutreach] Enrollment error — status:', e.response?.status, 'data:', JSON.stringify(e.response?.data));
    results.errors.push(`Enrollment: ${e.response?.data?.message || e.message}`);
  }

  // 6. Sync to Affinity
  const affinityKey = process.env.AFFINITY_API_KEY;
  if (affinityKey && companyData?.name) {
    try {
      const { org } = await affinity.upsertOrganization(
        { name: companyData.name, domain: companyData.domain },
        affinityKey
      );
      if (ceoData?.firstName) {
        await affinity.upsertPerson({
          firstName: ceoData.firstName,
          lastName: ceoData.lastName,
          email: ceoData.email,
          organizationId: org.id,
        }, affinityKey);
      }
      const listResult = await affinity.addToSourcingList({ orgId: org.id, senderName: 'David Divver' }, affinityKey);

      // Persist IDs so the Apollo reply webhook can flip status to Connected
      if (listResult?.priorityFieldValueId && listResult?.connectedOptionId && companyData?.domain) {
        tracker.saveTracking(companyData.domain, {
          priorityFieldValueId: listResult.priorityFieldValueId,
          connectedOptionId: listResult.connectedOptionId,
          orgId: org.id,
        });
      }
    } catch (e) {
      results.errors.push(`Affinity sync: ${e.message}`);
    }
  }

  return {
    success: results.enrolled,
    sequenceId: results.sequence?.id,
    sequenceName: results.sequence?.name,
    contactId: results.contact?.id,
    enrolled: results.enrolled,
    errors: results.errors,
  };
}

module.exports = { runOutreachSequence, runOutreachByCompany, launchEmailOutreach };
