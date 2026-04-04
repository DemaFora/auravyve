const API = '';
let currentUser = null;
let dailyChallenges = [];
let completedToday = [];
let currentScore = 0;
let leaderboard = [];

// ── helpers ──────────────────────────────────────────
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  return r.json();
}

function calcScore(traits) {
  return Math.round((traits.confidence + traits.style + traits.discipline + traits.social) / 4);
}

// ── UI rendering ─────────────────────────────────────
function renderApp() {
  const { traits, level, streak } = currentUser;
  const score = calcScore(traits);
  currentScore = score;
  const deg = Math.round((score / 99) * 360);

  document.getElementById('ring').style.background = `conic-gradient(var(--accent) 0 ${deg}deg, rgba(255,255,255,.08) ${deg}deg 360deg)`;
  document.getElementById('score-num').textContent = score;
  document.getElementById('streak-val').textContent = streak + ' day streak';
  document.getElementById('level-chip').textContent = 'Level ' + level;

  document.getElementById('confidence-score').textContent = traits.confidence;
  document.getElementById('style-score').textContent = traits.style;
  document.getElementById('discipline-score').textContent = traits.discipline;
  document.getElementById('social-score').textContent = traits.social;
  document.getElementById('confidence-fill').style.width = traits.confidence + '%';
  document.getElementById('style-fill').style.width = traits.style + '%';
  document.getElementById('discipline-fill').style.width = traits.discipline + '%';
  document.getElementById('social-fill').style.width = traits.social + '%';
}

function renderChallenges() {
  const el = document.getElementById('challenges-list');
  if (!el) return;
  el.innerHTML = dailyChallenges.map(ch => {
    const done = completedToday.includes(ch.id);
    return `<div class="challenge-item${done ? ' done' : ''}">
      <div class="ch-header">
        <div class="ch-title">${ch.title}</div>
        <div class="ch-aura">+${ch.aura} aura</div>
      </div>
      <div class="ch-desc">${ch.desc}</div>
      <button class="ch-btn${done ? ' completed' : ''}" onclick="handleChallenge('${ch.id}')" ${done ? 'disabled' : ''}>
        ${done ? 'Completed today' : 'Complete  +' + ch.aura + ' aura'}
      </button>
    </div>`;
  }).join('');
}

function renderLeaderboard() {
  const el = document.getElementById('leaderboard');
  const you = currentUser.username;
  const ranked = [...leaderboard];
  // insert yourself if not present
  if (!ranked.find(x => x.username === you)) {
    ranked.push({ username: you, score: currentScore, level: currentUser.level, streak: currentUser.streak });
    ranked.sort((a, b) => b.score - a.score);
  }
  const myRank = ranked.findIndex(x => x.username === you) + 1;
  document.getElementById('rank-val').textContent = '#' + myRank;
  const auraToday = completedToday.length > 0 ? dailyChallenges.filter(c => completedToday.includes(c.id)).reduce((s, c) => s + c.aura, 0) : 0;
  document.getElementById('today-delta').textContent = auraToday > 0 ? '+' + auraToday : '0';
  document.getElementById('trend-val').textContent = completedToday.length === 3 ? 'On Fire' : completedToday.length > 0 ? 'Surging' : 'Ascending';

  el.innerHTML = ranked.slice(0, 8).map((u, i) => `
    <div class="user ${u.username === you ? 'you' : ''}">
      <div class="left">
        <div class="rank">${i + 1}</div>
        <div>
          <div class="name">${u.username === you ? 'You' : u.username}</div>
          <div class="small">Lvl ${u.level} · ${u.streak} day streak</div>
        </div>
      </div>
      <div class="score">${u.score}</div>
    </div>
  `).join('');
}

// ── auth views ───────────────────────────────────────
function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
}

function showMain() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'block';
}

async function loadUser(username) {
  const data = await api(`/api/me?username=${encodeURIComponent(username)}`);
  if (data.error) { alert(data.error); return; }
  currentUser = data.user;
  dailyChallenges = data.challenges || [];
  completedToday = data.challengesCompleted || [];
  renderApp();
  renderChallenges();
  await fetchLeaderboard();
  showMain();
}

async function fetchLeaderboard() {
  const data = await api('/api/leaderboard');
  leaderboard = data.leaderboard || [];
  renderLeaderboard();
}

// ── events ───────────────────────────────────────────
async function handleChallenge(challengeId) {
  if (completedToday.includes(challengeId)) return;
  const data = await api('/api/challenge/complete', 'POST', { username: currentUser.username, challengeId });
  if (data.error) { return; }
  currentUser = data.user;
  completedToday.push(challengeId);
  renderApp();
  renderChallenges();
  await fetchLeaderboard();
}

async function handleRegister() {
  const username = document.getElementById('reg-username').value.trim();
  if (!username) return;
  const data = await api('/api/register', 'POST', { username });
  if (data.error) { document.getElementById('auth-error').textContent = data.error; return; }
  localStorage.setItem('aurascore_user', username);
  await loadUser(username);
}

async function handleLogin() {
  const username = document.getElementById('login-username').value.trim();
  if (!username) return;
  const data = await api('/api/login', 'POST', { username });
  if (data.error) { document.getElementById('auth-error').textContent = data.error; return; }
  localStorage.setItem('aurascore_user', username);
  await loadUser(username);
}

function handleLogout() {
  localStorage.removeItem('aurascore_user');
  currentUser = null;
  showAuth();
}

// ── boot ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const saved = localStorage.getItem('aurascore_user');
  if (saved) {
    await loadUser(saved);
  } else {
    showAuth();
  }

  // challenge buttons are rendered dynamically, handled via onclick
  document.getElementById('btn-register').addEventListener('click', handleRegister);
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  document.getElementById('show-login').addEventListener('click', () => {
    document.getElementById('reg-panel').style.display = 'none';
    document.getElementById('login-panel').style.display = 'block';
    document.getElementById('auth-error').textContent = '';
  });
  document.getElementById('show-register').addEventListener('click', () => {
    document.getElementById('login-panel').style.display = 'none';
    document.getElementById('reg-panel').style.display = 'block';
    document.getElementById('auth-error').textContent = '';
  });
});
