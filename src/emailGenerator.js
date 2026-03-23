// Generates personalized CEO outreach emails based on enriched company/person data

const FOLLOWUP_DELAY_DAYS = 35; // 5 weeks

function getDomain(email) {
  return email.split('@')[1];
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getSpaceLine(industry) {
  const spaces = {
    'Technology': 'enterprise technology',
    'SaaS': 'SaaS',
    'Financial Services': 'fintech',
    'Healthcare': 'healthtech',
    'E-Commerce': 'e-commerce',
    'Marketing': 'marketing technology',
    'Artificial Intelligence': 'AI',
    'Data Analytics': 'data and analytics',
    'Cybersecurity': 'cybersecurity',
    'Developer Tools': 'developer tools',
  };
  return spaces[industry] || (industry ? industry.toLowerCase() : 'this space');
}

function generateInitialEmail({ ceoName, companyName, industry, description, senderName }) {
  const space = getSpaceLine(industry);
  const senderFirst = senderName ? senderName.split(' ')[0] : 'David';

  const companyLine = description
    ? `I've heard a lot of positive feedback on ${companyName || 'your company'}, specifically around ${description.charAt(0).toLowerCase() + description.slice(1).replace(/\.$/, '')}, and am very impressed with what you are building.`
    : `I've heard a lot of positive feedback on ${companyName || 'your company'} and am very impressed with what you are building.`;

  return {
    subject: `Connecting from NewView Capital`,
    body: `Hope all is well, I'm an investor at NewView Capital - a $3.1bn venture growth fund.
I wanted to reach out as I've been spending time in ${space} and believe it will become a key point of differentiation going forward. ${companyLine}
I'm excited about what you are doing and wanted to see if it was a good time to connect.
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

function buildEmailSequence({ ceoName, companyName, industry, description, senderName }) {
  const emails = [];

  // Email 1: Initial outreach (day 0)
  const initial = generateInitialEmail({ ceoName, companyName, industry, description, senderName });
  emails.push({ ...initial, delayDays: 0, type: 'initial' });

  // Emails 2-5: Follow-ups every 35 days (5 weeks)
  for (let i = 0; i < 4; i++) {
    const followUp = generateFollowUps({ ceoName, companyName, senderName, followUpIndex: i });
    emails.push({ ...followUp, delayDays: FOLLOWUP_DELAY_DAYS * (i + 1), type: `followup_${i + 1}` });
  }

  return emails;
}

module.exports = { buildEmailSequence, generateInitialEmail, getDomain, FOLLOWUP_DELAY_DAYS };
