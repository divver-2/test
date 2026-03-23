// Generates personalized CEO outreach emails based on enriched company/person data

const Anthropic = require('@anthropic-ai/sdk');

const FOLLOWUP_DELAY_DAYS = 35; // 5 weeks

function getDomain(email) {
  return email.split('@')[1];
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getThemeLine(industry) {
  const themes = {
    'Technology': "I've been spending time in enterprise software and believe the next wave of infrastructure is still being built",
    'SaaS': "I've been spending time in SaaS and find the opportunity to drive operational leverage through software particularly compelling",
    'Financial Services': "I've been spending time in fintech and believe there is a significant opportunity to modernise how financial services are delivered",
    'Healthcare': "I've been spending time in healthtech and find the opportunity to bring technology to essential healthcare services particularly compelling",
    'E-Commerce': "I've been spending time in e-commerce and believe the infrastructure layer powering modern commerce is still maturing",
    'Marketing': "I've been spending time in marketing technology and believe AI will fundamentally change how brands acquire and retain customers",
    'Artificial Intelligence': "I've been spending time in AI and believe it will become a key point of data capture and competitive differentiation going forward",
    'Data Analytics': "I've been spending time in data and analytics and believe companies that turn data into action will define the next era of software",
    'Cybersecurity': "I've been spending time in cybersecurity and find the opportunity to bring modern, AI-native security to enterprises particularly compelling",
    'Developer Tools': "I've been spending time in developer tools and believe the way software is built is undergoing a fundamental shift",
  };
  return themes[industry] || `I've been spending time in ${industry ? industry.toLowerCase() : 'this space'} and find the opportunity here particularly compelling`;
}

async function generateEmailLines({ companyName, industry, description }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = {
    themeLine: getThemeLine(industry),
    productLine: `I've heard strong feedback on what you are building.`,
  };
  if (!apiKey) return fallback;

  try {
    const client = new Anthropic({ apiKey });
    const context = [
      companyName && `Company: ${companyName}`,
      industry && `Industry: ${industry}`,
      description && `Description: ${description}`,
    ].filter(Boolean).join('\n');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are helping a VC investor at NewView Capital write a short, personalized outreach email to a founder.

Write two lines in exactly this format:
THEME: [one sentence completing "I wanted to reach out as ..."]
PRODUCT: [one sentence completing "I've heard strong feedback on ..."]

THEME rules: Specific investing angle that led to this company. Sound like a thoughtful investor — e.g. "I've been spending time in voice AI and believe it will become a key point of data capture" or "I find the opportunity to bring AI to essential service industries particularly compelling". Never use generic industry labels like "information technology". Max 25 words.

PRODUCT rules: One concrete sentence about what makes this company's product valuable or what problem they uniquely solve. Not a company overview. Max 20 words.

${context}

Reply with exactly two lines starting with THEME: and PRODUCT:`,
      }],
    });

    const text = msg.content[0].text.trim();
    const themeMatch = text.match(/^THEME:\s*(.+)$/m);
    const productMatch = text.match(/^PRODUCT:\s*(.+)$/m);
    return {
      themeLine: themeMatch ? themeMatch[1].trim() : fallback.themeLine,
      productLine: productMatch ? productMatch[1].trim() : fallback.productLine,
    };
  } catch (e) {
    console.error('[Claude] email line generation failed:', e.message);
    return fallback;
  }
}

async function generateInitialEmail({ ceoName, companyName, industry, description, senderName }) {
  const senderFirst = senderName ? senderName.split(' ')[0] : 'David';
  const firstName = ceoName ? ceoName.split(' ')[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  const { themeLine, productLine } = await generateEmailLines({ companyName, industry, description });

  return {
    subject: `Connecting from NewView Capital`,
    body: `${greeting}

Hope all is well. I'm an investor at NewView Capital, a $3.1B venture growth fund.

I wanted to reach out as ${themeLine}. ${companyName || 'Your company'} is a great example of that and ${productLine}

I'm excited about what you are building and wanted to see if it was a good time to connect.

Thanks,
${senderFirst}`,
  };
}

function generateFollowUps({ ceoName, companyName, senderName, followUpIndex }) {
  const firstName = ceoName ? ceoName.split(' ')[0] : 'there';

  const templates = [
    {
      subject: `Following up — ${companyName || 'your team'}`,
      body: `Hi ${firstName},

Just wanted to bump this to the top of your inbox. I know things get busy, so keeping this brief.

We help companies like ${companyName || 'yours'} with [CORE BENEFIT]. Happy to share a quick case study if that would be helpful.

Worth a 15-min chat?

${senderName || 'Your Name'}`,
    },
    {
      subject: `One more thought for ${companyName || 'you'}`,
      body: `Hi ${firstName},

I'll keep this short — I wanted to share one thing that might be relevant for ${companyName || 'your team'}: [SPECIFIC INSIGHT OR STAT RELEVANT TO THEIR INDUSTRY].

We've helped similar companies tackle this exact challenge. Would love to show you how.

Up for a quick call?

${senderName || 'Your Name'}`,
    },
    {
      subject: `Still thinking about ${companyName || 'your growth'}`,
      body: `Hi ${firstName},

I've reached out a couple of times and haven't heard back — totally understand if the timing isn't right.

If there's a better time to reconnect, or if someone else on your team would be a better fit for this conversation, I'm happy to follow their lead.

Either way, I'd love to stay in touch.

${senderName || 'Your Name'}`,
    },
    {
      subject: `Last note from me, ${firstName}`,
      body: `Hi ${firstName},

I promise this is my last follow-up for now. I genuinely believe we could add real value for ${companyName || 'your company'}, but I don't want to be a nuisance.

If anything changes and you'd like to chat, my door is always open. Feel free to reach out whenever the time is right.

Best,
${senderName || 'Your Name'}`,
    },
  ];

  return templates[Math.min(followUpIndex, templates.length - 1)];
}

async function buildEmailSequence({ ceoName, companyName, industry, description, senderName }) {
  const emails = [];

  // Email 1: Initial outreach (day 0)
  const initial = await generateInitialEmail({ ceoName, companyName, industry, description, senderName });
  emails.push({ ...initial, delayDays: 0, type: 'initial' });

  // Emails 2-5: Follow-ups every 35 days (5 weeks)
  for (let i = 0; i < 4; i++) {
    const followUp = generateFollowUps({ ceoName, companyName, senderName, followUpIndex: i });
    emails.push({ ...followUp, delayDays: FOLLOWUP_DELAY_DAYS * (i + 1), type: `followup_${i + 1}` });
  }

  return emails;
}

module.exports = { buildEmailSequence, generateInitialEmail, getDomain, FOLLOWUP_DELAY_DAYS };
