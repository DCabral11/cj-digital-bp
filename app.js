const DOM = {
  loginView: document.getElementById('login-view'),
  teamView: document.getElementById('team-view'),
  adminView: document.getElementById('admin-view'),
  loginForm: document.getElementById('login-form'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  loginError: document.getElementById('login-error'),
  teamName: document.getElementById('team-name'),
  teamScore: document.getElementById('team-score'),
  gamesGrid: document.getElementById('games-grid'),
  rankingBody: document.getElementById('ranking-body'),
  historyBody: document.getElementById('history-body'),
  logoutTeam: document.getElementById('logout-team'),
  logoutAdmin: document.getElementById('logout-admin'),
  pinDialog: document.getElementById('pin-dialog'),
  pinForm: document.getElementById('pin-form'),
  pinInput: document.getElementById('pin-input'),
  pointsInput: document.getElementById('points-input'),
  pinFeedback: document.getElementById('pin-feedback'),
  dialogTitle: document.getElementById('dialog-title')
};

const state = { teams: [], games: [], submissions: {}, session: null, selectedGame: null, admin: null };
let firebaseApi;

const SESSION_KEY = 'peddy_session';

const gameIdCollator = new Intl.Collator('pt', { numeric: true, sensitivity: 'base' });
const compareGameIds = (left, right) => gameIdCollator.compare(String(left ?? ''), String(right ?? ''));

function switchView(view) {
  [DOM.loginView, DOM.teamView, DOM.adminView].forEach((v) => {
       const isTarget = v === view;
       
       v.classList.toggle('visible', isTarget);
       v.classList.toggle('hidden', !isTarget);

       v.hidden = !isTarget;

       v.setAttribute("aria-hidden", String(!isTarget));
    });
}

function computeTeamScore(teamId) {
  return Object.values(state.submissions[teamId] || {}).reduce((sum, item) => sum + Number(item.points || 0), 0);
}

function rankingRows() {
  return state.teams
    .map((team) => ({ name: team.teamName, score: computeTeamScore(team.id) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function historyRows() {
  const rows = [];
  for (const team of state.teams) {
    for (const [gameId, rec] of Object.entries(state.submissions[team.id] || {})) {
      rows.push({ timestamp: rec.timestamp, teamName: team.teamName, gameId, points: rec.points });
    }
  }
  return rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function renderTeam() {
  const team = state.session?.team;
  if (!team) return;
  const done = state.submissions[team.id] || {};

  DOM.teamName.textContent = team.teamName;
  DOM.teamScore.textContent = `Pontuação: ${computeTeamScore(team.id)} pts`;
  DOM.gamesGrid.innerHTML = '';

  state.games.forEach((game) => {
    const visited = !!done[game.gameId];
    const tile = document.createElement('button');
    tile.className = `game-tile ${visited ? 'done' : 'open'}`;
    tile.textContent = game.label;
    tile.disabled = visited;
    tile.addEventListener('click', () => openPinDialog(game));
    DOM.gamesGrid.appendChild(tile);
  });
}

function renderAdmin() {
  DOM.rankingBody.innerHTML = rankingRows().map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.score}</td></tr>`).join('');
  DOM.historyBody.innerHTML = historyRows().map((h) =>
    `<tr><td>${new Date(h.timestamp).toLocaleString('pt-PT')}</td><td>${h.teamName}</td><td>${h.gameId}</td><td>${h.points}</td></tr>`
  ).join('');
}

function openPinDialog(game) {
  state.selectedGame = game;
  DOM.dialogTitle.textContent = `Validar ${game.label}`;
  DOM.pinInput.value = '';
  DOM.pointsInput.value = '';
  DOM.pinFeedback.textContent = '';
  DOM.pinDialog.showModal();
}

async function handlePinSubmit(ev) {
  ev.preventDefault();
  const game = state.selectedGame;
  const team = state.session?.team;
  if (!game || !team) return;
  
  const enteredPin = DOM.pinInput.value.trim();
  const enteredPoints = Number(DOM.pointsInput.value);
  
  try {
    const points = const points = await firebaseApi.validatePinAndInsertSubmission(team.id, game, enteredPin, enteredPoints);
    DOM.pinFeedback.textContent = `Registo efetuado. ${points} pontos.`;
    setTimeout(() => DOM.pinDialog.close(), 450);
  } catch (err) {
    DOM.pinFeedback.textContent = err.message;
  }
}

function authenticate(username, password) {
  if (state.admin && username === state.admin.username && password === state.admin.password) return { role: 'admin' };
  const team = state.teams.find((t) => t.username === username && t.password === password);
  return team ? { role: 'team', team } : null;
}

function logout() {
  state.session = null;

  localStorage.removeItem(SESSION_KEY);
  
  if (DOM.pinDialog.open) DOM.pinDialog.close();
  
  DOM.loginForm.reset();
  DOM.loginError.textContent = '';
  switchView(DOM.loginView);
}

function bindEvents() {
  DOM.loginForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const auth = authenticate(DOM.username.value.trim(), DOM.password.value.trim());
    if (!auth) {
      DOM.loginError.textContent = 'Credenciais inválidas.';
      return;
    }
    DOM.loginError.textContent = '';
    state.session = auth;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ role: auth.role, teamId: auth.team?.id || null }));
    if (auth.role === 'admin') {
      switchView(DOM.adminView);
      renderAdmin();
    } else {
      switchView(DOM.teamView);
      renderTeam();
    }
  });

  DOM.logoutAdmin.addEventListener('click', logout);
  DOM.logoutTeam.addEventListener('click', logout);
  DOM.pinForm.addEventListener('submit', handlePinSubmit);
}

async function createFirebaseApi() {
  if (!window.FIREBASE_CONFIG) throw new Error('firebase-config.js não encontrado/configurado.');

  const [{ initializeApp }, { getDatabase, ref, get, onValue, runTransaction }] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js')
  ]);

  const app = initializeApp(window.FIREBASE_CONFIG);
  const db = getDatabase(app);

  const api = {
    async getAdmin() {
      const [adminSnap, equipasSnap] = await Promise.all([get(ref(db, 'admin')), get(ref(db, 'equipas'))]);
      if (adminSnap.exists()) {
        return adminSnap.val();
      }

      if (equipasSnap.exists()) {
        const adminEntry = Object.values(equipasSnap.val()).find((row) => String(row?.role || '').toLowerCase() === 'admin');
        if (adminEntry) {
          return { username: adminEntry.username, password: adminEntry.password };
        }
      }

      throw new Error('Nó /admin não existe e não foi encontrado utilizador admin em /equipas.');
    },
    async getTeams() {
      const snap = await get(ref(db, 'equipas'));
      if (!snap.exists()) return [];
      return Object.entries(snap.val())
        .map(([id, v]) => ({ id: String(id), ...v }))
        .filter((team) => String(team.role || 'team').toLowerCase() === 'team')
        .map((team) => ({
          id: team.id,
          username: team.username,
          password: team.password,
          teamName: team.team_name || team.teamName || team.username
        }));
    },
    async getGames() {
      const snap = await get(ref(db, 'postos'));
      if (!snap.exists()) return [];
      return Object.entries(snap.val())
        .map(([postoId, v]) => ({
          postoId: String(postoId),
          gameId: String(v.game_label || `P${postoId}`),
          label: String(v.game_label || `P${postoId}`)
        }))
        .sort((a, b) => compareGameIds(a.postoId, b.postoId));
    },
    subscribeSubmissions(cb) {
      return onValue(ref(db, 'submissions'), (snap) => cb(snap.exists() ? snap.val() : {}));
    },
    async validatePinAndInsertSubmission(teamId, game, enteredPin, enteredPoints) {
       const pinPath = `postos/${game.postoId}/pin`;
        const pinSnap = await get(ref(db, pinPath));
        
        if (!pinSnap.exists()) {
          throw new Error('PIN do posto não encontrado na base de dados.');
        }

        const dbPin = String(pinSnap.val() || '').trim();
        const isValidPin = String(enteredPin || '').trim() === dbPin;

        if (!isValidPin) {
          throw new Error('PIN incorreto. Verifica o código do posto.');
        }

        const points = Number(enteredPoints);
        const payload = { timestamp: new Date().toISOString(), points, gameId: game.gameId };

        const target = ref(db, `submissions/${teamId}/${game.gameId}`);
        const tx = await runTransaction(target, (current) => current || payload);
        if (!tx.committed) throw new Error('Jogo já registado para esta equipa.');

        return points;
    }
  };

  api.subscribeSubmission = api.subscribeSubmissions;
  api.subscribe = api.subscribeSubmissions;
  return api;
}

async function bootstrap() {
  firebaseApi = await createFirebaseApi();
  const [admin, teams, games] = await Promise.all([firebaseApi.getAdmin(), firebaseApi.getTeams(), firebaseApi.getGames()]);

  state.admin = admin;
  state.teams = teams;
  state.games = games;

  const subscribeFn = firebaseApi.subscribeSubmissions || firebaseApi.subscribeSubmission || firebaseApi.subscribe;
  if (typeof subscribeFn !== 'function') {
    throw new Error('API Firebase inválida: método de subscrição de submissões não encontrado.');
  }

  subscribeFn.call(firebaseApi, (submissions) => {
    state.submissions = submissions;
    if (state.session?.role === 'team') renderTeam();
    if (state.session?.role === 'admin') renderAdmin();
  });

  bindEvents();

  const persisted = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');

  if (persisted?.role === 'admin') {
      state.session = { role: 'admin' };
      switchView(DOM.adminView);
      renderAdmin();
      return;
  }

  if (persisted?.role === 'team' && persisted.teamId) {
      const team = state.teams.find((t) => t.id === String(persisted.teamId));

      if (team) {
          state.session = { role: 'team', team };
          switchView(DOM.teamView);
          renderTeam();
          return;
      }
  }
  
  switchView(DOM.loginView);
}

bootstrap().catch((err) => {
  DOM.loginError.textContent = `Erro ao iniciar: ${err.message}`;
});





