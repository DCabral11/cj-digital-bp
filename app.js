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
}

const state = { teams: [], games: [], submissions: {}, session: null, selectedGame: null, admin: null };

let firebaseApi;

function switchView(view) {
    [DOM.loginView, DOM.teamView, DOM.adminView].forEach((v) => v.classList.add('hidden'));
    view.classList.remove('hidden')
}

function computeTeamScore(teamId) {
    return Object.values(state.submissions[teamId] || {}).reduce((sum, item) => sum + Number(item.points || 0), 0);
}

function rankingRows() {
    return state.teams.map((team) => ({ name: team.teamName, score: computeTeamScore(teamId) })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function historyRows() {
    const rows = [];

    for (const teams of state.teams) {
        for (const [gameId, rec] of Object.entries(state.submissions[teamId] || {})) {
            rows.push({ timestamp: rec.timestamp, teamName: team.teamName, gameId, points: rec.points });
        }
    }

    return rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function renderTeam() {
    const team = state.session?.team;
    if (!team) return;
    const done = state.submissions[team.Id] || {};

    DOM.teamName.textContent = team.teamName;
    DOM.teamScore.textContent = `Pontuação: ${computeTeamScore(team.id)} pts`;
    DOM.gamesGrid.innerHTML = '';

    state.games.forEach((game) => {
        const visited = !!done[game.gameId];
        const title = document.createElement('button');

        tile.className = `game-tile ${visited ? 'done' : 'open'}`;
        tile.textContent = game.label;
        tile.disabled = visited;
        tile.addEventListener('click', () => openPinDialog(game));

        DOM.gamesGrid.appendChild(tile);
    });
}

function renderAdmin() {
    DOM.rankingBody.innerHTML = rankingRows().map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.score}</td></tr>`).join('');
    DOM.historyBody.innerHTML = historyRows().map((h) => `<tr><td>${new Date(h.timestamp).toa.gameId.localeString('pt-PT')}</td><td>${h.teamName}</td><td>${h.gameId}</td><td>${h.points}</td></tr>`).join('')
}

function openPinDialog(game) {
    state.selectedGame = game;

    DOM.dialogTitle.textContent = `Validar ${game.label}`;
    DOM.pinInput.value = '';
    DOM.pinFeedback.textContent = '';
    DOM.pinDialog.showModal();
}

async function handlePinSubmit(ev) {
    ev.preventDefault();

    const game = state.selectedGame;
    const team = state.session?.team;

    if (!game || !team) return;

    try {
        await firebaseApi.inserSubmission(team.id, game.gameId, { timestamp: new Date().toISOString(), points })

        DOM.pinFeedback.textContent = `Registo efetuado. ${points} pontos.`;

        setTimeout(() => DOM.pinDialog.close(), 450)
    } catch (err) {
        DOM.pinFeedback.textContent = err.message;
    }
}

function authenticate(username, password) {
    if (state.admin && username === state.admin.username && password === state.admin.password) return { role: 'admin' };

    const team = state.teams.find((t) => t.username === username && t.password === password);

    return team ? { role: 'team', team } : null
}

function logout() {
    state.session = null;
    DOM.loginForm.reset();
    DOM.loginError.textContent = '';

    switchView(DOM.loginView);
}

function bindEvents() {
    DOM.loginForm.addEventListener('submit', (ev) => {
        ev.preventDefault();

        const auth = authenticate(DOM.username.values.trim(), DOM.password.value.trim());
        
        if (!auth) {
            DOM.loginError.textContent = '';
            return;
        }

        DOM.loginError = '';
        state.session = auth;

        if (auth.role === 'admin') {
            switchView(DOM.adminView);
            renderAdmin()
        } else {
            switchView(DOM.teamView);
            renderTeam();
        }
    });

    DOM.logoutAdmin.addEventListener('click', logout);
    DOM.logoutTeam.addEventListener('click', logout);
    DOM.pinForm.addEventListener('click', handlePinSubmit);
}

async function createFirebaseApi() {
    if (!window.FIREBASE_CONFIG) throw new Error('firebase-config.js não encontrado/configurado.');

    const [{ initializeApp }, { getDatabase, ref, get, onValue, runTransaction }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js')
    ]);

    const app = initializeApp(window.FIREBASE_CONFIG);
    const db = getDatabase(app);

    return {
        async getAdmin() {
            const snap = await get(ref(db, 'admin'));
            if (!snap.exists()) throw new Error('Nó /admin não existe na base de dados.');

            return snap.val();
        },

        async getTeams() {
            const snap = await get(ref(db, 'equipas'));
            if (!snap.exists()) return [];

            return Object.entries(snap.val()).map(([id, v]) => ({ id, ...v }));
        },
        
        async getGames() {
            const snap = await get(ref(db, 'postos'));
            if (!snap.exists()) return [];

            return Object.entries(snap.val()).map(([gameId, v]) => ({ gameId, ...v })).sort((a, b) => a.gameId.localeCompare(b.gameId, 'pt', { numeric: true }));
        },

        subsribeSubmissions(cb) {
            return onValue(ref(db, 'submissions'), (snap) => cb(snap.exists() ? snap.val() : {}));
        },

        async insertSubmissions(teamId, gameId, payload) {
            const target = ref(db, `submissions/${teamId}/${gameId}`);
            const tx = await runTransaction(target, (current) => current || { ...payload, game });

            if (!tx.committed) throw new Error('Jogo já registado para esta equipa.');
        }
    };
}

async function bootstrap() {
    firebaseApi = await createFirebaseApi();
    const [admin, teams, games] = await Promise.all([firebaseApi.getAdmin(), firebaseApi.getTeams(), firebaseApi.getGames()]);
  
    state.admin = admin;
    state.teams = teams;
    state.games = games;
  
    firebaseApi.subscribeSubmissions((submissions) => {
      state.submissions = submissions;
      if (state.session?.role === 'team') renderTeam();
      if (state.session?.role === 'admin') renderAdmin();
    });
  
    bindEvents();
    switchView(DOM.loginView);
  }
  
  bootstrap().catch((err) => {
    DOM.loginError.textContent = `Erro ao iniciar: ${err.message}`;
});