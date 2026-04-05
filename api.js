'use strict';
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ── Security utilities ────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || '31d5821953611e42f34ad635f8f1e5e37d021624b370107d0e63fa4a2bdcf4e0';
const RATE_LIMIT = new Map(); // ip -> { count, resetAt }

function signToken(username) {
  const payload = Buffer.from(JSON.stringify({ username, iat: Date.now(), exp: Date.now() + 30*24*60*60*1000 })).toString('base64url');
  const sig = require('crypto').createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = require('crypto').createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  if (expected !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function checkRateLimit(ip, max, windowMs) {
  const now = Date.now();
  const key = 'login:' + ip;
  let entry = RATE_LIMIT.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    RATE_LIMIT.set(key, entry);
  }
  entry.count++;
  return entry.count > max;
}

function sanitizeUsername(u) {
  if (!u || typeof u !== 'string') return null;
  const s = u.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (s.length < 2 || s.length > 20) return null;
  return s;
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}


const PORT = process.env.PORT || 3085;
// Railway-compatible DB path
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || 
               (process.env.RAILWAY_ENVIRONMENT ? '/tmp' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DB_DIR, 'db.json');
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch(e) { console.error('DB dir error:', e.message); }
console.log('DB path:', DB_FILE);

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { users: {}, feed: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: {}, feed: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ── Challenge data ──────────────────────────────────────────────────────────
// Challenge pool — 7 rotating daily sets, each with 5 challenges across different pillars
const CHALLENGE_GROUPS = [
  [ // Sunday — Presence & Reset
    { id: 'sun-1', title: 'Presence Upgrade', desc: 'Post one clean fit photo that captures your best look today.', reward: { style: 4, confidence: 3 }, vyve: 7 },
    { id: 'sun-2', title: 'Full Workout', desc: 'Complete a full training session. No shortcuts.', reward: { discipline: 5, confidence: 3 }, vyve: 8 },
    { id: 'sun-3', title: 'Digital Detox Hour', desc: 'One full hour offline. No phone, no screens. Just be present.', reward: { discipline: 4, social: 2 }, vyve: 7 },
    { id: 'sun-4', title: 'Gratitude List', desc: 'Write down 5 things you are genuinely grateful for right now.', reward: { confidence: 3, social: 2 }, vyve: 5 },
    { id: 'sun-5', title: 'Sunday Reset', desc: 'Clean your space, prep your week, and set one intention for tomorrow.', reward: { discipline: 4, confidence: 2 }, vyve: 6 }
  ],
  [ // Monday — Discipline & Intention
    { id: 'mon-1', title: 'Morning Lock-In', desc: 'Wake up on time. No phone for the first hour.', reward: { discipline: 5, confidence: 2 }, vyve: 7 },
    { id: 'mon-2', title: 'Weekly Intention', desc: 'Write your 3 main goals for the week. Be specific, not vague.', reward: { discipline: 4, confidence: 3 }, vyve: 7 },
    { id: 'mon-3', title: 'Cold Shower', desc: 'End your shower cold for at least 30 seconds. Build mental toughness.', reward: { discipline: 5, confidence: 3 }, vyve: 8 },
    { id: 'mon-4', title: 'No Complaints', desc: 'Zero complaints today. Reframe every frustration as a problem to solve.', reward: { confidence: 4, discipline: 3 }, vyve: 7 },
    { id: 'mon-5', title: 'Plan Your Day', desc: 'Write out your top 3 tasks before you touch your phone.', reward: { discipline: 5, confidence: 2 }, vyve: 6 }
  ],
  [ // Tuesday — Social & Connection
    { id: 'tue-1', title: 'Social Arc', desc: "Start 3 real conversations today. At least one with someone new.", reward: { social: 6, confidence: 3 }, vyve: 9 },
    { id: 'tue-2', title: 'Cold Contact', desc: 'Reach out to someone you admire but have never messaged.', reward: { confidence: 6, social: 3 }, vyve: 8 },
    { id: 'tue-3', title: 'No Scroll Block', desc: 'No passive social media scrolling for 4 consecutive hours.', reward: { discipline: 6 }, vyve: 7 },
    { id: 'tue-4', title: 'Check On Someone', desc: 'Send a genuine message to a friend you haven\'t talked to in a while.', reward: { social: 5, confidence: 2 }, vyve: 6 },
    { id: 'tue-5', title: 'Voice Note Instead', desc: 'Send 3 voice notes instead of texts today. More presence, less typing.', reward: { social: 4, confidence: 3 }, vyve: 7 }
  ],
  [ // Wednesday — Style & Appearance
    { id: 'wed-1', title: 'Glow Session', desc: 'Full grooming — hair, skin, nails, outfit. Top to bottom.', reward: { style: 6, confidence: 3 }, vyve: 9 },
    { id: 'wed-2', title: 'Best Fit Wednesday', desc: 'Wear your best outfit today even if you have nowhere important to be.', reward: { style: 5, confidence: 3 }, vyve: 8 },
    { id: 'wed-3', title: 'Posture Check', desc: 'Set a reminder every 2 hours to correct your posture. Shoulders back, chin up.', reward: { confidence: 4, style: 3 }, vyve: 6 },
    { id: 'wed-4', title: 'Skincare Routine', desc: 'Full skincare routine morning and night. Invest in how you show up.', reward: { style: 4, confidence: 2 }, vyve: 5 },
    { id: 'wed-5', title: 'Mirror Moment', desc: 'Spend 3 minutes on presence — eye contact, expression, energy. Own your reflection.', reward: { confidence: 5, style: 2 }, vyve: 6 }
  ],
  [ // Thursday — Focus & Performance
    { id: 'thu-1', title: 'Deep Work Block', desc: 'No social media until 3pm. Two uninterrupted hours on your hardest task.', reward: { discipline: 6, confidence: 2 }, vyve: 8 },
    { id: 'thu-2', title: 'Single Task Mode', desc: 'Pick one thing that matters most. Do only that until it\'s done.', reward: { discipline: 5, confidence: 3 }, vyve: 7 },
    { id: 'thu-3', title: 'Knowledge Stack', desc: 'Read, listen, or watch something that actually teaches you something. 30 min minimum.', reward: { discipline: 4, confidence: 3 }, vyve: 6 },
    { id: 'thu-4', title: 'Phone-Free Meal', desc: 'Eat at least one meal today without your phone. Just the food and your thoughts.', reward: { discipline: 3, social: 2 }, vyve: 5 },
    { id: 'thu-5', title: 'End-of-Day Review', desc: 'Before bed, write 3 things you accomplished today and one thing to improve tomorrow.', reward: { discipline: 4, confidence: 3 }, vyve: 6 }
  ],
  [ // Friday — Energy & Health
    { id: 'fri-1', title: 'Full Body Reset', desc: 'Workout, hydrate 3L, and commit to 8+ hours of sleep tonight.', reward: { discipline: 4, confidence: 3, social: 2 }, vyve: 9 },
    { id: 'fri-2', title: 'Clean Eats', desc: 'No junk, no processed food all day. Eat clean, whole foods only.', reward: { discipline: 5, confidence: 2 }, vyve: 7 },
    { id: 'fri-3', title: 'Active Recovery', desc: 'Walk, stretch, yoga, or light movement for at least 30 minutes.', reward: { discipline: 3, confidence: 2 }, vyve: 5 },
    { id: 'fri-4', title: 'No Alcohol Tonight', desc: 'Go out or stay in but stay completely clear tonight. Your Saturday self will thank you.', reward: { discipline: 5, confidence: 3 }, vyve: 8 },
    { id: 'fri-5', title: 'Wind Down Ritual', desc: 'Create a 20-minute wind-down before bed. No screens, just peace.', reward: { discipline: 3, social: 1 }, vyve: 5 }
  ],
  [ // Saturday — Growth & Social
    { id: 'sat-1', title: 'Level Up Move', desc: 'Do one thing today that makes you slightly uncomfortable. Growth lives there.', reward: { confidence: 7, social: 3 }, vyve: 10 },
    { id: 'sat-2', title: 'Win Review', desc: 'Write down 3 wins from this week — big or small. Acknowledge your progress.', reward: { confidence: 5, discipline: 2 }, vyve: 7 },
    { id: 'sat-3', title: 'Teach Something', desc: 'Share one thing you know with someone else — a tip, a skill, a lesson.', reward: { social: 4, confidence: 4 }, vyve: 7 },
    { id: 'sat-4', title: 'New Environment', desc: 'Work, walk, or hang out somewhere different than usual today.', reward: { social: 3, confidence: 3, discipline: 2 }, vyve: 7 },
    { id: 'sat-5', title: 'Creative Output', desc: 'Make something today — write, draw, build, cook, record. Anything counts.', reward: { confidence: 4, style: 3 }, vyve: 7 }
  ]
];

const BASE_VYVE_NAMES = ['Magnetic Violet','Solar Gold','Mystic Blue','Velvet Violet','Spirit Cyan','Ember Orange','Balance Green','Pulse Pink'];

const ALL_BADGES = {
  'first-glow':'First Glow','flow-3':'3-Day Flow','flow-7':'7-Day Alignment','flow-14':'14-Day Radiance','flow-30':'30-Day Pulse',
  'first-rare':'Rare Vyve Found','all-colors':'Color Collector','first-shift':'First Vyve Shift','emotional-swing':'Emotional Swing',
  'first-share':'First Share','vyve-twin':'Vyve Twin','weekly-story':'Story Unlocked','archetype-unlocked':'Archetype Revealed','monthly-map':'Monthly Map',
  'comeback':'The Return'
};

const RARE_VYVES = [
  { id:'lunar-static', name:'Lunar Static', color:'linear-gradient(135deg,#4B0082,#1a0040)', glow:'rgba(75,0,130,0.6)', glow2:'rgba(26,0,64,0.3)', tagline:'Your energy is compressed and electric. Something is building.', condition: u => u.streak >= 3 && u.traits.discipline >= 70 && u.traits.social <= 45 },
  { id:'solar-bloom', name:'Solar Bloom', color:'linear-gradient(135deg,#FF6B35,#FACC15,#FB923C)', glow:'rgba(255,107,53,0.6)', glow2:'rgba(250,204,21,0.3)', tagline:'Peak radiance. You are at your most magnetic right now.', condition: u => u.traits.confidence >= 80 && u.traits.style >= 75 && u.traits.social >= 70 },
  { id:'ember-surge', name:'Ember Surge', color:'linear-gradient(135deg,#EF4444,#F97316)', glow:'rgba(239,68,68,0.6)', glow2:'rgba(249,115,22,0.3)', tagline:'Raw intensity. Channel this before it fades.', condition: u => u.traits.confidence >= 75 && u.traits.discipline >= 75 && u.traits.social <= 50 },
  { id:'mirror-mist', name:'Mirror Mist', color:'linear-gradient(135deg,#94A3B8,#CBD5E1,#64748B)', glow:'rgba(148,163,184,0.5)', glow2:'rgba(100,116,139,0.3)', tagline:'You are absorbing more than you are giving. Rare reflective state.', condition: u => u.traits.social >= 70 && u.traits.confidence <= 55 && u.traits.style >= 65 },
  { id:'eclipse-violet', name:'Eclipse Violet', color:'linear-gradient(135deg,#1e003a,#8B5CF6,#22D3EE)', glow:'rgba(139,92,246,0.8)', glow2:'rgba(34,211,238,0.4)', tagline:'The rarest alignment. Total clarity meets total intensity.', condition: u => u.traits.confidence >= 85 && u.traits.discipline >= 80 && u.traits.social >= 75 && u.traits.style >= 75 },
  { id:'aurora-split', name:'Aurora Split', color:'linear-gradient(135deg,#22D3EE,#F472B6,#34D399)', glow:'rgba(34,211,238,0.6)', glow2:'rgba(244,114,182,0.3)', tagline:'Your energy is divided between two strong forces. Powerful but unstable.', condition: u => Math.abs(u.traits.confidence - u.traits.social) >= 30 && u.traits.discipline >= 65 }
];

function getRareAura(u) {
  for (const r of RARE_VYVES) { try { if (r.condition(u)) return r; } catch {} }
  return null;
}

// ── Archetypes (Level 4) ────────────────────────────────────────────────────
const ARCHETYPES = [
  { id: 'calm-disruptor', name: 'Calm Disruptor', desc: 'You move quietly but everything shifts around you. Steady on the surface, electric underneath.', traits: { confidence: 'high', social: 'mid', discipline: 'high', style: 'mid' } },
  { id: 'solar-leader', name: 'Solar Leader', desc: 'Naturally magnetic. People orbit your energy without fully understanding why.', traits: { confidence: 'high', social: 'high', discipline: 'mid', style: 'high' } },
  { id: 'velvet-mirror', name: 'Velvet Mirror', desc: 'You reflect what others bring. Deeply intuitive, you absorb and transform energy around you.', traits: { confidence: 'mid', social: 'high', discipline: 'mid', style: 'high' } },
  { id: 'iron-visionary', name: 'Iron Visionary', desc: 'Disciplined and focused, you see angles others miss. Your silence carries weight.', traits: { confidence: 'high', social: 'low', discipline: 'high', style: 'mid' } },
  { id: 'pulse-creator', name: 'Pulse Creator', desc: 'You generate momentum wherever you go. Creative, expressive, and impossible to ignore.', traits: { confidence: 'mid', social: 'high', discipline: 'low', style: 'high' } },
  { id: 'deep-current', name: 'Deep Current', desc: 'Your power runs beneath the surface. Still waters, but the depth is extraordinary.', traits: { confidence: 'mid', social: 'low', discipline: 'high', style: 'mid' } },
  { id: 'ember-spirit', name: 'Ember Spirit', desc: 'Fierce energy that builds slowly and burns long. You outlast everything.', traits: { confidence: 'high', social: 'mid', discipline: 'high', style: 'low' } },
  { id: 'cosmic-free', name: 'Cosmic Free', desc: 'Fluid, unpredictable, and magnetic in ways that defy explanation. Rare vyve signature.', traits: {} }
];

function getArchetype(traits) {
  const rank = k => traits[k] >= 75 ? 'high' : traits[k] >= 50 ? 'mid' : 'low';
  const r = { confidence: rank('confidence'), social: rank('social'), discipline: rank('discipline'), style: rank('style') };
  let best = ARCHETYPES[ARCHETYPES.length - 1], bestMatch = 0;
  for (const a of ARCHETYPES.slice(0, -1)) {
    let m = 0;
    for (const [k, v] of Object.entries(a.traits)) if (r[k] === v) m++;
    if (m > bestMatch) { bestMatch = m; best = a; }
  }
  return best;
}

// ── Weekly story generator ──────────────────────────────────────────────────
function generateWeeklyStory(history) {
  if (!history || history.length < 7) return null;
  const recent = history.slice(-7);
  const avg = k => Math.round(recent.reduce((s, d) => s + (d.traits?.[k] || 70), 0) / recent.length);
  const avgScore = Math.round(recent.reduce((s, d) => s + (d.score || 70), 0) / recent.length);
  const scores = recent.map(d => d.score || 70);
  const trend = scores[scores.length - 1] - scores[0];
  const dominant = ['confidence', 'style', 'discipline', 'social'].sort((a, b) => avg(b) - avg(a))[0];
  const trendWord = trend > 5 ? 'rising' : trend < -5 ? 'shifting down' : 'stable';
  return {
    avgScore,
    trendWord,
    dominant,
    summary: `Your vyve averaged ${avgScore} this week and has been ${trendWord}. Your strongest dimension was ${dominant}. ${trend > 5 ? "You're building momentum." : trend < -5 ? "Something drained you this week. Look at what changed." : "You held your energy steady — that takes more discipline than most people know."}`,
    scores
  };
}

// ── Insight engine ──────────────────────────────────────────────────────────
const SUGGESTIONS = {
  confidence: { low: 'Do one thing today that makes you feel capable. Even something small.', high: 'Your confidence is high — reach out, lead, say the thing.' },
  style: { low: 'Spend 5 minutes on your appearance before anything else today.', high: 'You look and feel sharp. Let people see it.' },
  discipline: { low: 'One task. Start it now. The feeling will catch up.', high: 'Your focus is locked in. Use it for your hardest thing today.' },
  social: { low: 'Send one genuine message to someone today.', high: 'Your social energy is magnetic right now. Use it.' }
};

const DEEP_INSIGHTS = {
  confidence: {
    low: { emotional: "You're playing smaller than usual today.", social: 'Let others lead social situations.', action: "Do one small thing you've been avoiding.", watchout: "Don't make big decisions when confidence is low." },
    high: { emotional: "You're carrying real self-belief right now.", social: 'People will naturally follow your lead today.', action: "Tackle the thing you've been overthinking.", watchout: 'Overconfidence can make you miss good feedback.' }
  },
  style: {
    low: { emotional: "You're less focused on how you show up externally.", social: 'You may feel slightly less visible today.', action: 'Put on something that makes you feel good before anything else.', watchout: 'First impressions may need extra attention.' },
    high: { emotional: "You're presenting your best self right now.", social: 'People notice you more when your style energy is high.', action: 'Show up to something important today.', watchout: "Don't let image distract from substance." }
  },
  discipline: {
    low: { emotional: 'Your mind is a bit scattered today.', social: 'Social interactions may feel draining.', action: 'Start with your smallest task and build momentum.', watchout: 'Avoid starting multiple things without finishing any.' },
    high: { emotional: "You're unusually clear and focused.", social: 'You can handle complex conversations today.', action: 'Use this focus window for your hardest work.', watchout: 'Deep focus can make you seem less available to others.' }
  },
  social: {
    low: { emotional: "You're more inward than usual today.", social: 'Honor your need for quiet without isolating completely.', action: 'One meaningful interaction beats five surface ones.', watchout: "Don't cancel everything — light social contact still helps." },
    high: { emotional: "You're open, warm, and genuinely magnetic right now.", social: "This is a great day to connect, collaborate, or meet someone new.", action: "Reach out to someone you've been meaning to contact.", watchout: 'You may overcommit when social energy is high.' }
  }
};

function getBestMode(traits) {
  const hi = k => traits[k] >= 68, lo = k => traits[k] <= 48;
  if (lo('confidence') && lo('discipline') && lo('social')) return 'Recovery mode. Rest, reflect, and do not force output.';
  if (hi('discipline') && lo('social')) return 'Deep solo work. No meetings if you can help it.';
  if (hi('social') && hi('confidence')) return 'Meetings, pitches, networking, collaboration.';
  if (hi('confidence') && lo('discipline')) return 'Creative work, ideation, big-picture thinking.';
  if (hi('style') && hi('social')) return 'Be seen. Show up to something that matters.';
  return 'Steady execution. Good day for routine and consistency.';
}

function getInsight(traits) {
  const lowest = ['confidence', 'style', 'discipline', 'social'].sort((a, b) => traits[a] - traits[b])[0];
  const highest = ['confidence', 'style', 'discipline', 'social'].sort((a, b) => traits[b] - traits[a])[0];
  const level = traits[lowest] < 55 ? 'low' : 'high';
  const deep = DEEP_INSIGHTS[lowest]?.[level] || {};
  return {
    focus: lowest, strength: highest,
    suggestion: deep.action || SUGGESTIONS[lowest]?.[level] || 'Show up fully today.',
    emotional: deep.emotional,
    social: deep.social,
    watchout: deep.watchout,
    bestMode: getBestMode(traits)
  };
}

function getPatternInsights(history) {
  if (!history || history.length < 7) return null;
  const insights = [];
  const weekday = history.filter(d => { const day = new Date(d.date).getDay(); return day >= 1 && day <= 5; });
  const weekend = history.filter(d => { const day = new Date(d.date).getDay(); return day === 0 || day === 6; });
  if (weekday.length >= 3 && weekend.length >= 2) {
    const wdAvg = Math.round(weekday.reduce((s,d)=>s+(d.score||70),0)/weekday.length);
    const weAvg = Math.round(weekend.reduce((s,d)=>s+(d.score||70),0)/weekend.length);
    if (Math.abs(wdAvg-weAvg) >= 8) insights.push(weAvg > wdAvg ? `Your vyve scores ${weAvg-wdAvg} points higher on weekends.` : `You tend to score ${wdAvg-weAvg} points higher during the week.`);
  }
  const auraNames = history.map(d => getAuraName(d.score||70));
  const freq = {};
  auraNames.forEach(n => freq[n] = (freq[n]||0)+1);
  const dominant = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0];
  if (dominant && dominant[1] >= 3) insights.push(`Your most common vyve is ${dominant[0]}. It appears ${Math.round(dominant[1]/history.length*100)}% of the time.`);
  if (history.length >= 14) {
    const first7avg = history.slice(-14,-7).reduce((s,d)=>s+(d.score||70),0)/7;
    const last7avg = history.slice(-7).reduce((s,d)=>s+(d.score||70),0)/7;
    const diff = Math.round(last7avg - first7avg);
    if (Math.abs(diff) >= 5) insights.push(diff > 0 ? `Your vyve has been rising this month (+${diff} avg over 2 weeks).` : `Your vyve has shifted down ${Math.abs(diff)} points over the past two weeks.`);
  }
  const confHigh = history.filter(d => d.traits?.confidence >= 70).length;
  if (confHigh >= Math.floor(history.length * 0.6)) insights.push("Your confidence has been consistently strong. It's becoming your baseline.");
  return insights.length > 0 ? insights : null;
}

const JOURNAL_KEYWORDS = {
  confidence: { positive: ['confident','bold','strong','powerful','proud','certain','decisive'], negative: ['insecure','anxious','nervous','doubt','unsure','shaky','afraid'] },
  discipline: { positive: ['focused','productive','working','grind','disciplined','locked','clear','motivated'], negative: ['distracted','scattered','lazy','procrastinat','unfocused','tired','drained','exhausted'] },
  social: { positive: ['social','friends','connected','people','fun','out','party','together','laugh','talked'], negative: ['alone','isolated','quiet','antisocial','avoid','withdrew'] },
  style: { positive: ['gym','workout','fit','dressed','clean','look','appearance','groomed','outfit'], negative: ['sloppy','messy'] }
};

function interpretJournal(text) {
  if (!text || text.trim().length < 5) return null;
  const lower = text.toLowerCase();
  const delta = { confidence: 0, discipline: 0, social: 0, style: 0 };
  for (const [trait, words] of Object.entries(JOURNAL_KEYWORDS)) {
    for (const w of words.positive) if (lower.includes(w)) delta[trait] += 2;
    for (const w of words.negative) if (lower.includes(w)) delta[trait] -= 2;
  }
  const signals = [];
  if (delta.confidence > 0) signals.push('confident energy');
  else if (delta.confidence < 0) signals.push('some self-doubt');
  if (delta.discipline > 0) signals.push('focused mind');
  else if (delta.discipline < 0) signals.push('scattered energy');
  if (delta.social > 0) signals.push('open social vibe');
  else if (delta.social < 0) signals.push('inward energy');
  if (delta.style > 0) signals.push('physical presence');
  const interpretation = signals.length > 0 ? `Your words suggest: ${signals.join(', ')}.` : 'Your day sounds complex. Your vyve reflects that.';
  return { delta, interpretation };
}

// ── Check-in questions ──────────────────────────────────────────────────────
const CHECKIN_QUESTIONS = [
  { id: 'mood', label: 'How are you feeling right now?', trait: null, options: ['Drained', 'Low', 'Okay', 'Good', 'Lit'] },
  { id: 'energy', label: 'How is your energy today?', trait: 'discipline', options: ['Empty', 'Slow', 'Steady', 'Flowing', 'Electric'] },
  { id: 'confidence', label: 'How confident do you feel?', trait: 'confidence', options: ['Shaky', 'Quiet', 'Neutral', 'Strong', 'Unstoppable'] },
  { id: 'social', label: 'How social do you feel?', trait: 'social', options: ['Closed off', 'Reserved', 'Open', 'Engaged', 'Magnetic'] },
  { id: 'focus', label: 'How clear is your mind?', trait: 'discipline', options: ['Scattered', 'Foggy', 'Present', 'Clear', 'Locked in'] }
];

// ── Helpers ─────────────────────────────────────────────────────────────────
const STREAK_BADGES = [
  { days: 3, id: 'flow-3', label: '3-Day Flow' },
  { days: 7, id: 'flow-7', label: '7-Day Alignment' },
  { days: 14, id: 'flow-14', label: '14-Day Radiance' },
  { days: 30, id: 'flow-30', label: '30-Day Pulse' }
];

function todayKey() { return new Date().toISOString().split('T')[0]; }
function getDailyChallenges() { return CHALLENGE_GROUPS[new Date().getDay()]; }
function calcScore(traits) { return Math.round((traits.confidence + traits.style + traits.discipline + traits.social) / 4); }
function calcLevel(totalAura) { return Math.min(99, Math.floor(totalAura / 50) + 1); }

function getProgressionLevel(checkInCount) {
  if (checkInCount >= 30) return 5;
  if (checkInCount >= 14) return 4;
  if (checkInCount >= 7) return 3;
  if (checkInCount >= 3) return 2;
  return 1;
}

function getProgressionUnlocks(level) {
  return {
    traitPattern: level >= 2,
    weeklyStory: level >= 3,
    archetype: level >= 4,
    monthlyMap: level >= 5
  };
}

function createUser(username, passwordHash) {
  return {
    id: crypto.randomUUID(),
    username,
    password: passwordHash,
    level: 1,
    totalAura: 0,
    streak: 0,
    longestStreak: 0,
    lastActiveDate: null,
    challengesCompletedToday: [],
    selectedChallenges: [],
    challengesSelectedDate: null,
    lastCompletedDate: null,
    checkInDoneToday: false,
    checkInDate: null,
    checkInCount: 0,
    checkInHistory: [],
    streakShields: 2,
    shieldsResetMonth: new Date().getMonth(),
    traits: { confidence: 50, style: 50, discipline: 50, social: 50 },
    friends: [],
    friendRequests: [],
    badges: [],
    createdAt: Date.now()
  };
}

function sanitize(u) {
  const ci = u.checkInCount || 0;
  const progLevel = getProgressionLevel(ci);
  return {
    id: u.id, username: u.username, level: u.level, totalAura: u.totalAura,
    streak: u.streak, longestStreak: u.longestStreak || 0,
    traits: u.traits, lastActiveDate: u.lastActiveDate,
    challengesCompletedToday: u.challengesCompletedToday || [],
    selectedChallenges: u.challengesSelectedDate === todayKey() ? (u.selectedChallenges || []) : [],
    challengesSelectedDate: u.challengesSelectedDate,
    lastCompletedDate: u.lastCompletedDate,
    checkInDoneToday: u.checkInDoneToday || false,
    checkInCount: ci,
    progressionLevel: progLevel,
    unlocks: getProgressionUnlocks(progLevel),
    friends: u.friends || [],
    friendRequests: u.friendRequests || [],
    badges: u.badges || [],
    streakShields: u.streakShields ?? 2,
    colorsFound: u.colorsFound || [],
    rareAurasFound: u.rareAurasFound || []
  };
}

function getLeaderboard(db) {
  return Object.values(db.users)
    .map(u => ({ username: u.username, score: calcScore(u.traits), level: u.level, streak: u.streak }))
    .sort((a, b) => b.score - a.score).slice(0, 50);
}

function getFriendLeaderboard(db, username) {
  const u = db.users[username];
  if (!u) return [];
  const friends = (u.friends || []).concat([username]);
  return friends.filter(f => db.users[f])
    .map(f => ({ username: f, score: calcScore(db.users[f].traits), level: db.users[f].level, streak: db.users[f].streak }))
    .sort((a, b) => b.score - a.score);
}

function addFeedEvent(db, type, username, data) {
  if (!db.feed) db.feed = [];
  db.feed.unshift({ id: crypto.randomUUID(), type, username, data, timestamp: Date.now() });
  if (db.feed.length > 200) db.feed = db.feed.slice(0, 200);
}

function awardBadge(u, db, id) {
  if (!u.badges) u.badges = [];
  if (u.badges.find(b => b.id === id)) return false;
  const label = ALL_BADGES[id] || id;
  u.badges.push({ id, label, earnedAt: Date.now() });
  addFeedEvent(db, 'badge', u.username, { badge: label });
  return true;
}

function checkBadges(u, db, prevScore) {
  if (!u.badges) u.badges = [];
  if ((u.checkInCount || 0) >= 1) awardBadge(u, db, 'first-glow');
  for (const b of STREAK_BADGES) if (u.streak >= b.days) awardBadge(u, db, b.id);
  if ((u.checkInCount||0) >= 7) awardBadge(u, db, 'weekly-story');
  if ((u.checkInCount||0) >= 14) awardBadge(u, db, 'archetype-unlocked');
  if ((u.checkInCount||0) >= 30) awardBadge(u, db, 'monthly-map');
  if (prevScore !== undefined && Math.abs(calcScore(u.traits) - prevScore) >= 15) awardBadge(u, db, 'emotional-swing');
}

function resetShieldsIfNeeded(u) {
  const month = new Date().getMonth();
  if (u.shieldsResetMonth !== month) {
    u.streakShields = 2;
    u.shieldsResetMonth = month;
  }
}

function parseBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function route(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, method = req.method;
  function json(code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
  const db = loadDB();

  // ── Auth ────────────────────────────────────────────────────────────────
  if (p === '/api/register' && method === 'POST') {
    const { username, password } = await parseBody(req);
    if (!username || username.trim().length < 2) return json(400, { error: 'Username too short' });
    if (!password || password.length < 4) return json(400, { error: 'Password must be 4+ characters' });
    const name = username.trim().toLowerCase();
    if (db.users[name]) return json(400, { error: 'Username taken' });
    const hash = await bcrypt.hash(password, 10);
    const user = createUser(name, hash);
    db.users[name] = user;
    addFeedEvent(db, 'joined', name, {});
    saveDB(db);
    return json(200, { user: sanitize(user) });
  }

  if (p === '/api/login' && method === 'POST') {
    const { username, password } = await parseBody(req);
    const name = username?.trim().toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'User not found' });
    const ok = await bcrypt.compare(password || '', db.users[name].password || '');
    if (!ok) return json(401, { error: 'Wrong password' });
    return json(200, { user: sanitize(db.users[name]) });
  }

  // ── Me ──────────────────────────────────────────────────────────────────
  if (p === '/api/me' && method === 'GET') {
    const name = url.searchParams.get('username')?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    const u = db.users[name];
    const today = todayKey();

    resetShieldsIfNeeded(u);

    // Reset check-in flag for new day
    if (u.checkInDate !== today) u.checkInDoneToday = false;

    if (u.lastActiveDate !== today) {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const yKey = yesterday.toISOString().split('T')[0];
      const completedYesterday = u.lastCompletedDate === yKey || u.checkInDate === yKey;

      if (u.lastActiveDate && u.lastActiveDate !== yKey) {
        // Missed more than one day
        if (u.streakShields > 0) {
          u.streakShields--;
          addFeedEvent(db, 'shield', name, { remaining: u.streakShields });
        } else {
          ['confidence','style','discipline','social'].forEach(k => { u.traits[k] = Math.max(10, (u.traits[k] || 50) - 2); });
          u.streak = 0;
        }
      } else if (!completedYesterday && u.lastActiveDate) {
        if (u.streakShields > 0) {
          u.streakShields--;
        } else {
          ['confidence','style','discipline','social'].forEach(k => { u.traits[k] = Math.max(10, (u.traits[k] || 50) - 2); });
          u.streak = 0;
        }
      } else if (completedYesterday) {
        u.streak = (u.streak || 0) + 1;
        if (u.streak > (u.longestStreak || 0)) u.longestStreak = u.streak;
      }

      checkBadges(u, db);
      u.lastActiveDate = today;
      saveDB(db);
    }

    if (!u.challengesCompletedToday) u.challengesCompletedToday = [];
    if (u.lastCompletedDate !== today) u.challengesCompletedToday = [];

    const progLevel = getProgressionLevel(u.checkInCount || 0);
    const weeklySt = progLevel >= 3 ? generateWeeklyStory(u.checkInHistory || []) : null;
    const archetype = progLevel >= 4 ? getArchetype(u.traits) : null;
    const insight = getInsight(u.traits);

    return json(200, {
      user: sanitize(u),
      score: calcScore(u.traits),
      challenges: getDailyChallenges(),
      challengesCompleted: u.challengesCompletedToday || [],
      checkInQuestions: CHECKIN_QUESTIONS,
      weeklyStory: weeklySt,
      archetype,
      insight
    });
  }

  // ── Daily Check-In ──────────────────────────────────────────────────────
  if (p === '/api/checkin' && method === 'POST') {
    const { username, answers, journalText } = await parseBody(req);
    // answers: { mood: 0-4, energy: 0-4, confidence: 0-4, social: 0-4, focus: 0-4 }
    const name = username?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    const u = db.users[name];
    const today = todayKey();
    if (u.checkInDate === today) return json(400, { error: 'Already checked in today' });

    const delta = v => (v - 2) * 3;
    const event = getCurrentEvent();
    const socialMult = event?.id === 'friday-surge' ? 2 : 1;
    const mondayBonus = event?.id === 'monday-reset' ? 3 : 0;

    if (answers.energy !== undefined) u.traits.discipline = Math.min(99, Math.max(10, u.traits.discipline + delta(answers.energy)));
    if (answers.confidence !== undefined) u.traits.confidence = Math.min(99, Math.max(10, u.traits.confidence + delta(answers.confidence)));
    if (answers.social !== undefined) u.traits.social = Math.min(99, Math.max(10, u.traits.social + delta(answers.social) * socialMult));
    if (answers.focus !== undefined) u.traits.discipline = Math.min(99, Math.max(10, u.traits.discipline + Math.round(delta(answers.focus) / 2)));

    // Mood affects overall confidence subtly
    if (answers.mood !== undefined) u.traits.confidence = Math.min(99, Math.max(10, u.traits.confidence + Math.round(delta(answers.mood) / 3)));

    // Apply journal interpretation
    let journalResult = null;
    if (journalText) {
      journalResult = interpretJournal(journalText);
      if (journalResult?.delta) {
        for (const [k, v] of Object.entries(journalResult.delta)) {
          if (u.traits[k] !== undefined) u.traits[k] = Math.min(99, Math.max(10, u.traits[k] + v));
        }
      }
    }

    const prevScore = calcScore({ confidence: u.traits.confidence, style: u.traits.style, discipline: u.traits.discipline, social: u.traits.social });
    const score = calcScore(u.traits);
    u.totalAura += 5 + mondayBonus;
    u.level = calcLevel(u.totalAura);
    u.checkInDate = today;
    u.checkInDoneToday = true;
    u.checkInCount = (u.checkInCount || 0) + 1;
    u.lastCompletedDate = today;

    // Comeback badge (3+ day absence)
    const lastActive = u.lastActiveDate;
    if (lastActive) {
      const daysSince = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
      if (daysSince >= 3) awardBadge(u, db, 'comeback');
    }

    // Track vyve name for shift badge
    const currentAuraName = getAuraName(score);
    if (!u.colorsFound) u.colorsFound = [];
    if (!u.colorsFound.includes(currentAuraName)) u.colorsFound.push(currentAuraName);
    if (u.lastAuraName && u.lastAuraName !== currentAuraName) awardBadge(u, db, 'first-shift');
    u.lastAuraName = currentAuraName;
    if (u.colorsFound.length >= 8) awardBadge(u, db, 'all-colors');

    // Rare vyve check
    let rareAura = null;
    if (!u.rareAurasFound) u.rareAurasFound = [];
    const rare = getRareAura(u);
    if (rare && !u.rareAurasFound.includes(rare.id)) {
      u.rareAurasFound.push(rare.id);
      rareAura = rare;
      awardBadge(u, db, 'first-rare');
      addFeedEvent(db, 'rare', name, { vyve: rare.name });
    }

    // Store history
    if (!u.checkInHistory) u.checkInHistory = [];
    u.checkInHistory.push({ date: today, score, traits: { ...u.traits }, answers });
    if (u.checkInHistory.length > 90) u.checkInHistory = u.checkInHistory.slice(-90);

    checkBadges(u, db, prevScore);
    addFeedEvent(db, 'checkin', name, { score, vyve: currentAuraName });

    const insight = getInsight(u.traits);
    const progLevel = getProgressionLevel(u.checkInCount);
    const archetype = progLevel >= 4 ? getArchetype(u.traits) : null;

    saveDB(db);
    const patternInsights = getPatternInsights(u.checkInHistory);
    return json(200, {
      user: sanitize(u), score, insight, archetype,
      auraName: currentAuraName, auraEarned: 5, rareAura,
      journalInterpretation: journalResult?.interpretation || null,
      patternInsights
    });
  }

  // ── History / Trend ────────────────────────────────────────────────────────────
  if (p === '/api/history' && method === 'GET') {
    const name = url.searchParams.get('username')?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    const u = db.users[name];
    const history = u.checkInHistory || [];
    const last30 = history.slice(-30);
    const last7 = history.slice(-7);
    const patternInsights = getPatternInsights(history);
    const auraNames = history.map(d => getAuraName(d.score||70));
    const freq = {};
    auraNames.forEach(n => freq[n]=(freq[n]||0)+1);
    const dominantAura = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    return json(200, { last30, last7, patternInsights, dominantAura, totalCheckIns: history.length });
  }

  // ── Friend Compatibility ─────────────────────────────────────────────────────
  if (p === '/api/compatibility' && method === 'GET') {
    const name = url.searchParams.get('username')?.toLowerCase();
    const friend = url.searchParams.get('friend')?.toLowerCase();
    if (!name || !friend || !db.users[name] || !db.users[friend]) return json(404, { error: 'Not found' });
    const u = db.users[name], f = db.users[friend];
    const uScore = calcScore(u.traits), fScore = calcScore(f.traits);
    const diff = Math.abs(uScore - fScore);
    const uAura = getAuraName(uScore), fAura = getAuraName(fScore);
    let type, desc;
    if (uAura === fAura) { type = 'Matching'; desc = `You and ${friend} are on the same wavelength today. Rare alignment.`; }
    else if (diff <= 8) { type = 'Complementary'; desc = `Your energies are close and complementary. You\'ll balance each other well today.`; }
    else if (diff >= 25) { type = 'Opposite'; desc = `You and ${friend} are running very different energies today. Interesting contrast.`; }
    else { type = 'Distinct'; desc = `Your auras are different enough to spark something interesting.`; }
    const traitDiffs = ['confidence','style','discipline','social'].map(k => ({
      trait: k, you: u.traits[k], friend: f.traits[k], diff: f.traits[k] - u.traits[k]
    }));
    return json(200, { type, desc, you: { vyve: uAura, score: uScore }, friend: { username: friend, vyve: fAura, score: fScore }, traitDiffs });
  }

  // ── Badge Award (client-triggered) ──────────────────────────────────────
  if (p === '/api/badge/award' && method === 'POST') {
    const { username, badgeId } = await parseBody(req);
    const name = username?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    if (!ALL_BADGES[badgeId]) return json(400, { error: 'Unknown badge' });
    const awarded = awardBadge(db.users[name], db, badgeId);
    saveDB(db);
    return json(200, { ok: true, awarded });
  }

  // ── Collection ───────────────────────────────────────────────────────────
  if (p === '/api/collection' && method === 'GET') {
    const name = url.searchParams.get('username')?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    const u = db.users[name];
    const colorsFound = u.colorsFound || [];
    const rareFound = u.rareAurasFound || [];
    const baseColors = BASE_VYVE_NAMES.map(n => ({ name: n, found: colorsFound.includes(n) }));
    const rareAuras = RARE_VYVES.map(r => ({ id: r.id, name: r.name, color: r.color, found: rareFound.includes(r.id), tagline: r.tagline }));
    const totalItems = BASE_VYVE_NAMES.length + RARE_VYVES.length;
    const foundItems = colorsFound.filter(c => BASE_VYVE_NAMES.includes(c)).length + rareFound.length;
    const percentComplete = Math.round((foundItems / totalItems) * 100);
    // Next rare vyve hint
    const nextRare = RARE_VYVES.find(r => !rareFound.includes(r.id));
    return json(200, { baseColors, rareAuras, percentComplete, nextRare: nextRare ? { name: nextRare.name } : null, archetype: getProgressionLevel(u.checkInCount||0) >= 4 ? getArchetype(u.traits) : null });
  }

  // ── Use Streak Shield ───────────────────────────────────────────────────
  if (p === '/api/streak/shield' && method === 'POST') {
    const { username } = await parseBody(req);
    const name = username?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    const u = db.users[name];
    resetShieldsIfNeeded(u);
    if (u.streakShields <= 0) return json(400, { error: 'No shields left this month' });
    u.streakShields--;
    u.streak = Math.max(0, u.streak); // preserve streak
    saveDB(db);
    return json(200, { ok: true, shieldsRemaining: u.streakShields });
  }

  // ── Select Challenges for the day ───────────────────────────────────────────────
  if (p === '/api/challenges/select' && method === 'POST') {
    const { username, challengeIds } = await parseBody(req);
    const name = username?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    if (!Array.isArray(challengeIds) || challengeIds.length < 1 || challengeIds.length > 3) return json(400, { error: 'Select 1-3 challenges' });
    const u = db.users[name];
    const today = todayKey();
    if (u.challengesSelectedDate === today) return json(400, { error: 'Already selected today' });
    // Validate all IDs exist in today's pool
    const pool = getDailyChallenges();
    const valid = challengeIds.every(id => pool.find(c => c.id === id));
    if (!valid) return json(400, { error: 'Invalid challenge ID' });
    u.selectedChallenges = challengeIds;
    u.challengesSelectedDate = today;
    u.challengesCompletedToday = [];
    saveDB(db);
    return json(200, { ok: true, selected: challengeIds });
  }

  // ── Complete Challenge ──────────────────────────────────────────────────
  if (p === '/api/challenge/complete' && method === 'POST') {
    const { username, challengeId } = await parseBody(req);
    const name = username?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    const u = db.users[name];
    const today = todayKey();
    if (u.lastCompletedDate !== today) u.challengesCompletedToday = [];
    if (!u.challengesCompletedToday) u.challengesCompletedToday = [];
    if (u.challengesCompletedToday.includes(challengeId)) return json(400, { error: 'Already completed' });
    // Must be in selected set (if user has selected)
    if (u.challengesSelectedDate === today && u.selectedChallenges?.length > 0 && !u.selectedChallenges.includes(challengeId)) {
      return json(400, { error: 'Not in your selected challenges' });
    }
    const ch = getDailyChallenges().find(c => c.id === challengeId);
    if (!ch) return json(404, { error: 'Challenge not found' });
    Object.entries(ch.reward).forEach(([k, v]) => { u.traits[k] = Math.min(99, (u.traits[k] || 50) + v); });
    u.totalAura += ch.vyve;
    u.level = calcLevel(u.totalAura);
    u.challengesCompletedToday.push(challengeId);
    u.lastCompletedDate = today;
    checkBadges(u, db);
    addFeedEvent(db, 'challenge', name, { title: ch.title, vyve: ch.vyve, score: calcScore(u.traits) });
    if (u.level > calcLevel(u.totalAura - ch.vyve)) addFeedEvent(db, 'levelup', name, { level: u.level });
    saveDB(db);
    return json(200, { user: sanitize(u), score: calcScore(u.traits), auraEarned: ch.vyve });
  }

  // ── Leaderboard ─────────────────────────────────────────────────────────
  if (p === '/api/leaderboard' && method === 'GET') {
    const name = url.searchParams.get('username')?.toLowerCase();
    return json(200, { global: getLeaderboard(db), friends: name ? getFriendLeaderboard(db, name) : [] });
  }

  // ── Feed ────────────────────────────────────────────────────────────────
  if (p === '/api/feed' && method === 'GET') {
    const name = url.searchParams.get('username')?.toLowerCase();
    let feed = db.feed || [];
    if (name && db.users[name]) {
      const friends = (db.users[name].friends || []).concat([name]);
      feed = feed.filter(e => friends.includes(e.username));
    }
    return json(200, { feed: feed.slice(0, 50) });
  }

  // ── Friends ─────────────────────────────────────────────────────────────
  if (p === '/api/friends/request' && method === 'POST') {
    const { from, to } = await parseBody(req);
    const f = from?.toLowerCase(), t = to?.toLowerCase();
    if (!f || !t || !db.users[f] || !db.users[t]) return json(404, { error: 'User not found' });
    if (f === t) return json(400, { error: 'Cannot add yourself' });
    if ((db.users[t].friendRequests || []).includes(f)) return json(400, { error: 'Request already sent' });
    if ((db.users[f].friends || []).includes(t)) return json(400, { error: 'Already friends' });
    if (!db.users[t].friendRequests) db.users[t].friendRequests = [];
    db.users[t].friendRequests.push(f);
    saveDB(db);
    return json(200, { ok: true });
  }

  if (p === '/api/friends/accept' && method === 'POST') {
    const { username, from } = await parseBody(req);
    const name = username?.toLowerCase(), f = from?.toLowerCase();
    if (!name || !f || !db.users[name] || !db.users[f]) return json(404, { error: 'Not found' });
    db.users[name].friendRequests = (db.users[name].friendRequests || []).filter(x => x !== f);
    if (!db.users[name].friends) db.users[name].friends = [];
    if (!db.users[f].friends) db.users[f].friends = [];
    if (!db.users[name].friends.includes(f)) db.users[name].friends.push(f);
    if (!db.users[f].friends.includes(name)) db.users[f].friends.push(name);
    addFeedEvent(db, 'friends', name, { with: f });
    saveDB(db);
    return json(200, { ok: true });
  }

  if (p === '/api/friends/decline' && method === 'POST') {
    const { username, from } = await parseBody(req);
    const name = username?.toLowerCase(), f = from?.toLowerCase();
    if (!name || !db.users[name]) return json(404, { error: 'Not found' });
    db.users[name].friendRequests = (db.users[name].friendRequests || []).filter(x => x !== f);
    saveDB(db);
    return json(200, { ok: true });
  }

  if (p === '/api/search' && method === 'GET') {
    const q = url.searchParams.get('q')?.toLowerCase();
    if (!q || q.length < 2) return json(200, { results: [] });
    const results = Object.values(db.users)
      .filter(u => u.username.includes(q))
      .slice(0, 10)
      .map(u => ({ username: u.username, level: u.level, score: calcScore(u.traits), streak: u.streak }));
    return json(200, { results });
  }

  // ── Static files ─────────────────────────────────────────────────────────
  if (res.headersSent) return;
  let filePath = p === '/' ? '/index.html' : p;
  const absPath = path.join(__dirname, filePath);
  if (!absPath.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(absPath, (err, data) => {
    if (res.headersSent) return;
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const mime = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(absPath)] || 'text/plain' });
    res.end(data);
  });
}

// ── Weekly Events ────────────────────────────────────────────────────────────
const WEEKLY_EVENTS = [
  { id: 'monday-reset', name: 'Monday Reset', desc: 'A fresh week. Set your intention now.', bonus: '+3 vyve points for first check-in today', day: 1 },
  { id: 'friday-surge', name: 'Friday Social Surge', desc: 'Social energy peaks on Fridays. Your social trait gains are doubled today.', bonus: '2x social gains', day: 5 }
];

const MONTHLY_EVENTS = [
  { id: 'full-moon', name: 'Full Moon Week', desc: 'Emotional auras are amplified. Rare auras more likely to surface.', badge: 'full-moon-week' },
  { id: 'spring-rebalance', name: 'Spring Rebalance', desc: 'Reset season. All traits receive a +3 passive boost this week.', badge: 'spring-rebalance' },
  { id: 'mercury-chaos', name: 'Mercury Chaos Week', desc: 'Expect volatility. Your vyve may shift more dramatically than usual.', badge: 'mercury-chaos' }
];

function getCurrentEvent() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...5=Fri
  const weekly = WEEKLY_EVENTS.find(e => e.day === day);
  if (weekly) return { ...weekly, type: 'weekly' };
  // Monthly events rotate by week of year
  const weekOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / (7 * 24 * 60 * 60 * 1000));
  if (weekOfYear % 4 === 0) return { ...MONTHLY_EVENTS[weekOfYear % MONTHLY_EVENTS.length], type: 'monthly' };
  return null;
}

// ── User segments ───────────────────────────────────────────────────────────
function getUserSegment(u) {
  const ci = u.checkInCount || 0;
  const lastActive = u.lastActiveDate;
  const today = todayKey();
  const daysSince = lastActive ? Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000) : 999;
  if (daysSince >= 7) return 'churn-risk';
  if (daysSince >= 3) return 'at-risk';
  if (ci >= 7 && daysSince <= 1) return 'habit';
  if (ci >= 3) return 'activated';
  return 'new';
}

const WINBACK_COPY = [
  'Your energy story never stopped. Just pick up today.',
  'Your vyve has been waiting to update.',
  'Come back for today\'s shift.',
  'Restart your flow with one quick check-in.'
];

function getRetentionMessage(u) {
  const seg = getUserSegment(u);
  const streak = u.streak || 0;
  const ci = u.checkInCount || 0;
  const lastActive = u.lastActiveDate;
  const daysSince = lastActive ? Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000) : 0;

  if (seg === 'churn-risk') {
    return { type: 'winback', msg: WINBACK_COPY[Math.floor(Math.random() * WINBACK_COPY.length)] };
  }
  if (seg === 'at-risk') {
    if (daysSince >= 3) return { type: 'comeback', msg: `You\'ve been away ${daysSince} days. Your flow is ready to restart.` };
    return { type: 'nudge', msg: streak > 0 ? `Your Vyve Flow is still alive. One check-in keeps your ${streak}-day flow going.` : 'Your vyve story continues when you do.' };
  }
  if (ci === 5) return { type: 'tease', msg: 'Two more check-ins unlock your Weekly Vyve Story.' };
  if (ci === 6) return { type: 'tease', msg: 'One more check-in and your Weekly Story unlocks.' };
  if (ci === 13) return { type: 'tease', msg: 'One more check-in reveals your Archetype.' };
  if (!u.checkInDoneToday) return { type: 'daily', msg: streak > 2 ? `Day ${streak + 1} is ready. Keep the flow going.` : 'Your vyve is ready.' };
  return null;
}

function getAuraName(score) {
  const names = [
    { name: 'Magnetic Violet', min: 85 }, { name: 'Solar Gold', min: 80 },
    { name: 'Mystic Blue', min: 74 }, { name: 'Velvet Violet', min: 68 },
    { name: 'Spirit Cyan', min: 62 }, { name: 'Ember Orange', min: 55 },
    { name: 'Balance Green', min: 48 }, { name: 'Pulse Pink', min: 0 }
  ];
  return (names.find(n => score >= n.min) || names[names.length - 1]).name;
}

const server = http.createServer(async (req, res) => { try { await route(req, res); } catch(e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('Error'); } } });
server.listen(PORT, '0.0.0.0', () => {
  console.log('AuraVyve v2 running on port ' + PORT);
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('DB_DIR:', process.env.RAILWAY_VOLUME_MOUNT_PATH || 'local');
});
process.on('uncaughtException', function(e) { console.error('Uncaught:', e.message, e.stack); });
process.on('unhandledRejection', function(r) { console.error('Unhandled:', r); });
