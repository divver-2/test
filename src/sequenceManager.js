const apollo = require('./apollo');
const affinity = require('./affinity');
const hunter = require('./hunter');
const { buildEmailSequence, FOLLOWUP_DELAY_DAYS } = require('./emailGenerator');
const tracker = require('./outreachTracker');

const SEQUENCE_NAME = 'CEO Outreach';

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
          priorityContext: results.affinityList.priorityContext || null,
        });
      }
    } catch (e) {
      results.errors.push(`Affinity sync failed: ${e.message}`);
    }
  }

  // 9. Find or create the Apollo sequence (with email steps)
  try {
    const emailAccounts = await apollo.getEmailAccounts(apiKey);
    const emailAccountId = emailAccounts[0]?.id || null;
    const existing = (await apollo.searchSequences(SEQUENCE_NAME, apiKey)).filter(s => s.name === SEQUENCE_NAME);
    if (existing.length > 0) {
      results.apolloSequence = { ...existing[0], alreadyExisted: true };
    } else {
      const { campaign } = await apollo.createSequenceWithSteps(SEQUENCE_NAME, results.emailSequence, emailAccountId, apiKey);
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
async function runOutreachByCompany({ companyName, apiKey, affinityKey, claudeKey }) {
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

  // 2+3. Enrich org and find CEO in parallel — both only need domain
  if (domain) {
    console.log('[Step 2+3] Enriching org + finding CEO in parallel for domain:', domain);
    const [enrichErr, ceoErr] = [null, null];
    await Promise.all([
      // Org enrichment
      apollo.enrichOrganization(domain, apiKey).then(enriched => {
        if (enriched) results.organization = enriched;
        console.log('[Step 2] Org enriched:', enriched?.name);
      }).catch(async e => {
        const status = e.response?.status;
        if (status === 403 && hunterKey) {
          try {
            const hunterData = await hunter.lookupDomain(domain, hunterKey);
            if (hunterData.company) results.organization = hunterData.company;
            if (hunterData.ceo) results.ceo = hunterData.ceo;
            results.usedHunter = true;
          } catch (he) { results.errors.push(`Hunter.io lookup failed: ${he.message}`); }
        } else {
          results.errors.push(`Organization enrichment failed: ${e.response?.data?.message || e.message}`);
        }
      }),
      // CEO lookup (basic)
      !results.ceo ? apollo.findCEO(domain, apiKey).then(ceo => {
        results._ceoBasic = ceo;
        console.log('[Step 3] CEO basic:', ceo?.first_name, ceo?.last_name);
      }).catch(async e => {
        const status = e.response?.status;
        if (status === 403 && hunterKey && !results.usedHunter) {
          try {
            const hunterData = await hunter.lookupDomain(domain, hunterKey);
            if (hunterData.company && !results.organization) results.organization = hunterData.company;
            if (hunterData.ceo) results.ceo = hunterData.ceo;
            results.usedHunter = true;
          } catch (he) { results.errors.push(`CEO lookup failed (Hunter.io): ${he.message}`); }
        } else if (status !== 403) {
          results.errors.push(`CEO lookup failed: ${e.response?.data?.message || e.message}`);
        }
      }) : Promise.resolve(),
    ]);
  }

  const orgName = results.organization?.name || companyName;

  // 3b. Enrich CEO for email (needs basic CEO data from above)
  if (domain && !results.ceo && results._ceoBasic) {
    const ceoBasic = results._ceoBasic;
    if (ceoBasic?.first_name) {
      try {
        console.log('[Step 3b] Enriching CEO for email:', ceoBasic.first_name, ceoBasic.last_name);
        const enriched = await apollo.enrichPersonByNameAndDomain(
          ceoBasic.first_name, ceoBasic.last_name, domain, apiKey, ceoBasic.id, orgName
        );
        results.ceo = enriched || ceoBasic;
      } catch (e) {
        results.ceo = ceoBasic;
      }
    } else {
      results.ceo = ceoBasic;
    }
  }
  delete results._ceoBasic;

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

  // 4+5. Generate email and look up Affinity in parallel
  const usedAffinityKey = affinityKey || process.env.AFFINITY_API_KEY;
  const [emailSequence] = await Promise.all([
    buildEmailSequence({
      ceoName,
      companyName: orgName,
      industry: results.organization?.industry || '',
      description: results.organization?.short_description || '',
      website: results.organization?.website_url || (domain ? `https://${domain}` : null),
      senderName: 'David Divver',
      claudeKey,
    }),
    usedAffinityKey
      ? affinity.lookupCompanyInAffinity(companyName, usedAffinityKey, domain, ceoEmail)
          .then(data => { results.affinityData = data; })
          .catch(e => { results.errors.push(`Affinity lookup failed: ${e.message}`); })
      : Promise.resolve(),
  ]);

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
      orgId: results.affinityData.orgId || null,
      owner: results.affinityData.owner,
      owners: results.affinityData.owners || [],
      emailsSent: results.affinityData.emailsSent,
      lastEmailDate: results.affinityData.lastEmailDate,
    } : { inAffinity: false, orgId: null, owner: null, owners: [], emailsSent: 0, lastEmailDate: null },
    emailDraft: emailSequence[0] || null,
    emailSequence,
    errors: results.errors,
  };
}

// Log outreach and sync to Affinity — no Apollo sequencing
async function launchEmailOutreach({ companyData, ceoData, emailSequence, apiKey, affinityKey: passedAffinityKey, senderName, userEmail }) {
  const cleanDomain = companyData?.domain ? companyData.domain.toLowerCase().replace(/^www\./, '') : null;

  // 1. Log to DB immediately — this is all the user needs confirmed
  if (cleanDomain) {
    try {
      await tracker.logOutreach(cleanDomain, userEmail, {
        ceoName: ceoData?.name || `${ceoData?.firstName || ''} ${ceoData?.lastName || ''}`.trim() || null,
        ceoEmail: ceoData?.email || null,
        companyName: companyData?.name || null,
        industry: companyData?.industry || null,
        description: companyData?.description || null,
      });
    } catch (e) {
      console.error('[tracker] logOutreach failed:', e.message);
    }
  }

  // 2. Fire Affinity sync in the background — don't block the response
  const affinityKey = passedAffinityKey || process.env.AFFINITY_API_KEY;
  if (affinityKey && (companyData?.name || cleanDomain)) {
    setImmediate(async () => {
      try {
        const orgName = companyData.name || cleanDomain;
        const cachedOrgId = companyData?.affinityOrgId || await tracker.getCachedOrgId(cleanDomain);
        const { org, created } = await affinity.upsertOrganization(
          { name: orgName, domain: cleanDomain, affinityOrgId: cachedOrgId, ceoEmail: ceoData?.email, ceoFirstName: ceoData?.firstName, ceoLastName: ceoData?.lastName },
          affinityKey
        );
        if (!org) { console.log('[Affinity] org not found — skipping sourcing list sync'); return; }
        if (cleanDomain && !created?.foundByNameOnly) await tracker.learnOrgId(cleanDomain, org.id);
        const [listResult] = await Promise.all([
          affinity.addToSourcingList({ orgId: org.id, senderName }, affinityKey),
          affinity.setGlobalOwner(org.id, senderName, affinityKey),
          ceoData?.firstName ? affinity.upsertPerson({
            firstName: ceoData.firstName, lastName: ceoData.lastName,
            email: ceoData.email, organizationId: org.id,
          }, affinityKey) : Promise.resolve(),
        ]);
        if (listResult?.priorityFieldValueId && listResult?.connectedOptionId && cleanDomain) {
          await tracker.saveTracking(cleanDomain, {
            priorityFieldValueId: listResult.priorityFieldValueId,
            connectedOptionId: listResult.connectedOptionId,
            orgId: org.id,
            priorityContext: listResult.priorityContext || null,
          });
        }
        console.log('[Affinity] background sync complete for', cleanDomain);
      } catch (e) {
        console.error('[Affinity] background sync error:', e.response?.status, e.response?.data || e.message);
      }
    });
  }

  // 3. Return immediately
  return { success: true, enrolled: true, affinity: { addedToList: true }, errors: [] };
}

module.exports = { runOutreachSequence, runOutreachByCompany, launchEmailOutreach };
