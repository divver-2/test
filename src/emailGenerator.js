// Generates personalized CEO outreach emails based on enriched company/person data

const Anthropic = require('@anthropic-ai/sdk');

const FOLLOWUP_DELAY_DAYS = 42; // 6 weeks

function getDomain(email) {
  return email.split('@')[1];
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getThemeLine(industry) {
  const normalized = (industry || '').toLowerCase().trim();
  const themes = [
    [['saas', 'software as a service'], "I've been spending time in SaaS and find the opportunity to drive operational leverage through software particularly compelling"],
    [['artificial intelligence', 'machine learning', 'ai'], "I've been spending time in AI and believe it will become a key point of data capture and competitive differentiation going forward"],
    [['fintech', 'financial services', 'financial technology', 'banking'], "I've been spending time in fintech and believe there is a significant opportunity to modernise how financial services are delivered"],
    [['healthcare', 'health tech', 'healthtech', 'medtech', 'medical'], "I've been spending time in healthtech and find the opportunity to bring technology to essential healthcare services particularly compelling"],
    [['e-commerce', 'ecommerce', 'retail', 'consumer'], "I've been spending time in e-commerce and believe the infrastructure layer powering modern commerce is still maturing"],
    [['marketing', 'adtech', 'advertising'], "I've been spending time in marketing technology and believe AI will fundamentally change how brands acquire and retain customers"],
    [['data', 'analytics', 'data analytics', 'business intelligence'], "I've been spending time in data and analytics and believe companies that turn data into action will define the next era of software"],
    [['cybersecurity', 'security', 'infosec'], "I've been spending time in cybersecurity and find the opportunity to bring modern, AI-native security to enterprises particularly compelling"],
    [['developer tools', 'devtools', 'developer platform', 'infrastructure'], "I've been spending time in developer tools and believe the way software is built is undergoing a fundamental shift"],
    [['logistics', 'supply chain', 'transportation'], "I've been spending time in logistics technology and believe the opportunity to bring intelligence to physical supply chains is still largely untapped"],
    [['climate', 'cleantech', 'energy', 'sustainability'], "I've been spending time in climate tech and believe the next decade will produce some of the most important infrastructure companies we've ever seen"],
    [['real estate', 'proptech', 'construction'], "I've been spending time in proptech and believe real estate is one of the last industries to be meaningfully transformed by software"],
    [['hrtech', 'hr tech', 'human resources', 'future of work', 'workforce'], "I've been spending time in workforce technology and believe the way companies hire, manage and retain talent is being fundamentally redesigned"],
    [['edtech', 'education', 'e-learning'], "I've been spending time in edtech and believe the opportunity to personalise learning at scale is still in its early innings"],
    [['information technology', 'information technology & services', 'it services', 'enterprise software', 'technology'], "I've been spending time in enterprise software and believe the next wave of B2B infrastructure is still being built"],
  ];

  for (const [keywords, line] of themes) {
    if (keywords.some(k => normalized.includes(k))) return line;
  }

  return "I've been spending time in enterprise software and believe the next wave of B2B infrastructure is still being built";
}

async function generateInitialEmail({ ceoName, companyName, industry, description, senderName }) {
  const senderFirst = senderName ? senderName.split(' ')[0] : 'David';
  const firstName = ceoName ? ceoName.split(' ')[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    try {
      const client = new Anthropic({ apiKey });
      const context = [
        companyName && `Company: ${companyName}`,
        industry && `Industry: ${industry}`,
        description && `Description: ${description}`,
      ].filter(Boolean).join('\n');

      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Write a 4-sentence cold investor outreach email from ${senderFirst} at NewView Capital to the founder of ${companyName || 'this company'}.

Follow this exact structure — one sentence per point, no more:

1. "I'm ${senderFirst} from NewView Capital, a $3.1B venture growth fund that backs category-defining companies at the growth stage."
2. "I've been following ${companyName} closely and what stands out to me is [ONE specific product or architectural insight — something concrete that shows real research, e.g. a technical decision, business model choice, or market positioning, not generic praise]."
3. "[One sentence on why this positions them well right now — name a specific market dynamic, customer pain point, or competitive shift. Be direct and sharp.]"
4. "We've been actively investing in [specific space] and believe there's a significant opportunity for ${companyName} to [specific outcome]. Would you be open to a brief call to get to know each other?"

Rules:
- Sentences 2 and 3 must be specific to this company — no generic statements
- Sound like a smart investor, not a salesperson
- No subject line, no greeting, no sign-off — just the 4 sentences
- No fluff, no "excited about what you're building"
- Total email: 4 sentences only

${context}

Reply with only the 4 sentences, nothing else.`,
        }],
      });

      return {
        subject: `Connecting from NewView Capital`,
        body: msg.content[0].text.trim(),
      };
    } catch (e) {
      console.error('[Claude] email generation failed:', e.message);
    }
  }

  // Fallback if no API key or Claude fails
  const themeLine = getThemeLine(industry);
  // Extract core capability from description (strip company name, location, founding info)
  let productDescriptor = null;
  if (description) {
    const first = description.split('.')[0];
    const match = first.match(/\bis\s+(?:an?\s+)?([^,]+?)(?:\s+(?:company\s+)?(?:based|founded|located|headquartered)|,|$)/i);
    productDescriptor = match ? match[1].trim() : null;
  }
  const specificThing = productDescriptor || 'what you are building';
  return {
    subject: `Connecting from NewView Capital`,
    body: `${greeting}
Hope all is well, I'm an investor at NewView Capital - a $3.1bn venture growth fund.
I wanted to reach out as ${themeLine}. I've heard positive feedback on ${companyName || 'your company'}, particularly around ${specificThing}, and am very impressed with what you are building.
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
    {
      subject: `Still here if the timing is ever right`,
      body: `Hi ${firstName},

Just leaving the door open — no pressure at all. If there's ever a moment where connecting makes sense, you know where to find me.

Wishing ${companyName || 'you and the team'} continued success.

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

  // Emails 2-6: Follow-ups every 42 days (6 weeks)
  for (let i = 0; i < 5; i++) {
    const followUp = generateFollowUps({ ceoName, companyName, senderName, followUpIndex: i });
    emails.push({ ...followUp, delayDays: FOLLOWUP_DELAY_DAYS * (i + 1), type: `followup_${i + 1}` });
  }

  return emails;
}

module.exports = { buildEmailSequence, generateInitialEmail, getDomain, FOLLOWUP_DELAY_DAYS };
