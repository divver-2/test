// Generates personalized CEO outreach emails based on enriched company/person data

const FOLLOWUP_DELAY_DAYS = 35; // 5 weeks

function getDomain(email) {
  return email.split('@')[1];
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getIndustryLine(industry) {
  if (!industry) return '';
  const lines = {
    'Technology': 'the fast-moving tech landscape',
    'SaaS': 'the SaaS space',
    'Financial Services': 'financial services',
    'Healthcare': 'the healthcare sector',
    'E-Commerce': 'e-commerce',
    'Marketing': 'the marketing world',
  };
  return lines[industry] || `the ${industry.toLowerCase()} industry`;
}

function generateInitialEmail({ ceoName, companyName, industry, senderName }) {
  const industryLine = getIndustryLine(industry);
  const greeting = ceoName ? `Hi ${ceoName.split(' ')[0]},` : 'Hi,';

  return {
    subject: `Quick question for you, ${ceoName ? ceoName.split(' ')[0] : 'there'}`,
    body: `${greeting}

I came across ${companyName || 'your company'} and was impressed by what you're building${industryLine ? ` in ${industryLine}` : ''}.

I'm reaching out because I think there's a real opportunity for us to work together — specifically around [YOUR VALUE PROP HERE]. Companies like yours have seen [SPECIFIC RESULT, e.g., 30% faster pipeline, 2x conversion] after working with us.

Would you be open to a 15-minute call this week or next to see if there's a fit?

Looking forward to your thoughts,
${senderName || 'Your Name'}`,
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

function buildEmailSequence({ ceoName, companyName, industry, senderName }) {
  const emails = [];

  // Email 1: Initial outreach (day 0)
  const initial = generateInitialEmail({ ceoName, companyName, industry, senderName });
  emails.push({ ...initial, delayDays: 0, type: 'initial' });

  // Emails 2-5: Follow-ups every 35 days (5 weeks)
  for (let i = 0; i < 4; i++) {
    const followUp = generateFollowUps({ ceoName, companyName, senderName, followUpIndex: i });
    emails.push({ ...followUp, delayDays: FOLLOWUP_DELAY_DAYS * (i + 1), type: `followup_${i + 1}` });
  }

  return emails;
}

module.exports = { buildEmailSequence, generateInitialEmail, getDomain, FOLLOWUP_DELAY_DAYS };
