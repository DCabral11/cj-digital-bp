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
  accessBody: document.getElementById('access-body'),
  deviceSummary: document.getElementById('device-summary'),
  rankingBody: document.getElementById('ranking-body'),
  historyBody: document.getElementById('history-body'),
  logoutTeam: document.getElementById('logout-team'),
  logoutAdmin: document.getElementById('logout-admin'),
  exportAdminXlsx: document.getElementById('export-admin-xlsx'),
  pinDialog: document.getElementById('pin-dialog'),
  pinForm: document.getElementById('pin-form'),
  pinInput: document.getElementById('pin-input'),
  pointsInput: document.getElementById('points-input'),
  cancelPin: document.getElementById('cancel-pin'),
  pinFeedback: document.getElementById('pin-feedback'),
  dialogTitle: document.getElementById('dialog-title')
};

const state = { teams: [], games: [], submissions: [], accesses: [], session: null, selectedGame: null, admin: null, ready: false, bootstrapError: null, eventsBound: false };
let firebaseApi;
const SESSION_KEY = 'peddy_session';
const DEVICE_KEY = 'peddy_device_id';

const gameIdCollator = new Intl.Collator('pt', { numeric: true, sensitivity: 'base' });
const compareGameIds = (left, right) => gameIdCollator.compare(String(left ?? ''), String(right ?? ''));


function normalizeSubmissions(data) {
  if (!data) return [];

  // Novo formato: /submissions/{submissionId}: { timestamp, posto, equipa, pontos }
  const maybeFlat = Object.entries(data).map(([id, row]) => ({ id, ...row }));
  const flatValid = maybeFlat.filter((r) => r && typeof r === 'object' && ('equipa' in r || 'posto' in r || 'pontos' in r));
  if (flatValid.length) {
    return flatValid.map((r) => ({
      id: String(r.id),
      timestamp: String(r.timestamp || ''),
      posto: String(r.posto || r.gameId || ''),
      equipa: String(r.equipa || r.teamId || ''),
      pontos: Number(r.pontos ?? r.points ?? 0)
    }));
  }

  // Compatibilidade legado: /submissions/{teamId}/{gameId}: { timestamp, points }
  const rows = [];
  for (const [equipa, games] of Object.entries(data)) {
    if (!games || typeof games !== 'object') continue;
    for (const [posto, payload] of Object.entries(games)) {
      rows.push({
        id: `${equipa}_${posto}`,
        timestamp: String(payload?.timestamp || ''),
        posto: String(posto),
        equipa: String(equipa),
        pontos: Number(payload?.points ?? payload?.pontos ?? 0)
      });
    }
  }
  return rows;
}




function getOrCreateDeviceId() {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const generated = `D${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(DEVICE_KEY, generated);
  return generated;
}

function normalizeAccessLogs(data) {
  if (!data) return [];
  return Object.entries(data).map(([id, row]) => ({
    id: String(id),
    teamId: String(row?.teamId || row?.equipa || ''),
    timestamp: String(row?.timestamp || ''),
    deviceId: String(row?.deviceId || ''),
    ua: String(row?.ua || '')
  })).filter((row) => row.teamId && row.timestamp);
}

function renderTeamAccesses(teamId) {
  if (!DOM.accessBody || !DOM.deviceSummary) return;
  const rows = state.accesses
    .filter((r) => String(r.teamId) === String(teamId))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const uniqueDevices = new Set(rows.map((r) => r.deviceId)).size;
  if (rows.length === 0) {
    DOM.deviceSummary.textContent = 'Sem registos de acesso para esta conta.';
    DOM.accessBody.innerHTML = '<tr><td colspan="3">Sem registos.</td></tr>';
    return;
  }

  DOM.deviceSummary.textContent = uniqueDevices > 1
    ? `⚠️ Conta usada em ${uniqueDevices} dispositivos diferentes.`
    : 'Conta usada num único dispositivo.';

  DOM.accessBody.innerHTML = rows.map((r) => `
    <tr>
      <td>${new Date(r.timestamp).toLocaleString('pt-PT')}</td>
      <td>${r.deviceId}</td>
      <td>${r.ua.slice(0, 80)}</td>
    </tr>
  `).join('');
}

function switchView(view) {
  [DOM.loginView, DOM.teamView, DOM.adminView].forEach((v) => {
    const isTarget = v === view;
    v.classList.toggle('visible', isTarget);
    v.classList.toggle('hidden', !isTarget);
    v.hidden = !isTarget;
    v.setAttribute('aria-hidden', String(!isTarget));
  });
}

function computeTeamScore(teamId) {
  return state.submissions
    .filter((row) => String(row.equipa) === String(teamId))
    .reduce((sum, row) => sum + Number(row.pontos || 0), 0);
}

function rankingRows() {
  return state.teams
    .map((team) => ({ name: team.teamName, score: computeTeamScore(team.id) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function historyRows() {
  return [...state.submissions]
    .map((row) => {
      const team = state.teams.find((t) => String(t.id) === String(row.equipa));
      return {
        timestamp: row.timestamp,
        teamName: team?.teamName || row.equipa,
        gameId: row.posto,
        points: Number(row.pontos || 0)
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function renderTeam() {
  const team = state.session?.team;
  if (!team) return;
  const donePosts = new Set(state.submissions.filter((row) => String(row.equipa) === String(team.id)).map((row) => String(row.posto)));

  DOM.teamName.textContent = team.teamName;
  DOM.teamScore.textContent = `Pontuação: ${computeTeamScore(team.id)} pts`;
  DOM.gamesGrid.innerHTML = '';

  state.games.forEach((game) => {
    const visited = donePosts.has(String(game.gameId));
    const tile = document.createElement('button');
    tile.className = `game-tile ${visited ? 'done' : 'open'}`;
    tile.textContent = game.label;
    tile.disabled = visited;
    tile.addEventListener('click', () => openPinDialog(game));
    DOM.gamesGrid.appendChild(tile);
  });

  renderTeamAccesses(team.id);
}

function renderAdmin() {
  DOM.rankingBody.innerHTML = rankingRows().map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.score}</td></tr>`).join('');
  DOM.historyBody.innerHTML = historyRows().map((h) =>
    `<tr><td>${new Date(h.timestamp).toLocaleString('pt-PT')}</td><td>${h.teamName}</td><td>${h.gameId}</td><td>${h.points}</td></tr>`
  ).join('');
}

function exportAdminDashboardToExcel() {
  if (!window.XLSX) {
    DOM.loginError.textContent = 'Biblioteca Excel não carregada.';
    return;
  }

  const rankingData = rankingRows().map((r, idx) => ({ posicao: idx + 1, equipa: r.name, pontos: r.score }));
  const historyData = historyRows().map((h) => ({
    data_hora: new Date(h.timestamp).toLocaleString('pt-PT'),
    equipa: h.teamName,
    jogo: h.gameId,
    pontos: h.points
  }));

  const wb = XLSX.utils.book_new();
  const wsRanking = XLSX.utils.json_to_sheet(rankingData.length ? rankingData : [{ info: 'Sem dados de ranking' }]);
  const wsHistory = XLSX.utils.json_to_sheet(historyData.length ? historyData : [{ info: 'Sem histórico de inserções' }]);
  XLSX.utils.book_append_sheet(wb, wsRanking, 'ranking');
  XLSX.utils.book_append_sheet(wb, wsHistory, 'historico');
  XLSX.writeFile(wb, 'dashboard_admin.xlsx');
}

function openPinDialog(game) {
  state.selectedGame = game;
  DOM.dialogTitle.textContent = `Validar ${game.label}`;
  DOM.pinInput.value = '';
  DOM.pointsInput.value = '100';
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
  if (![0, 100].includes(enteredPoints)) {
    DOM.pinFeedback.textContent = 'A pontuação deve ser 0 ou 100.';
    return;
  }

  try {
    const points = await firebaseApi.validatePinAndInsertSubmission(team.id, game, enteredPin, enteredPoints);
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
  if (state.eventsBound) return;
  state.eventsBound = true;

  DOM.loginForm.addEventListener('submit', (ev) => {
    ev.preventDefault();

    if (state.bootstrapError) {
      DOM.loginError.textContent = `Erro ao iniciar: ${state.bootstrapError.message || state.bootstrapError}`;
      return;
    }

    if (!state.ready) {
      DOM.loginError.textContent = 'A carregar dados do jogo... tenta novamente em 1-2 segundos.';
      return;
    }

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
      firebaseApi?.registerAccess(auth.team.id, getOrCreateDeviceId(), navigator.userAgent);
      switchView(DOM.teamView);
      renderTeam();
    }
  });

  DOM.logoutAdmin.addEventListener('click', logout);
  DOM.exportAdminXlsx?.addEventListener('click', exportAdminDashboardToExcel);
  DOM.logoutTeam.addEventListener('click', logout);
  DOM.pinForm.addEventListener('submit', handlePinSubmit);
  DOM.cancelPin?.addEventListener('click', () => {
    DOM.pinInput.value = '';
    DOM.pointsInput.value = '100';
    DOM.pinFeedback.textContent = '';
    DOM.pinDialog.close();
  });
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
        const adminValue = adminSnap.val();
        if (adminValue && typeof adminValue === 'object' && adminValue.username && adminValue.password) {
          return { username: String(adminValue.username), password: String(adminValue.password) };
        }

        if (adminValue && typeof adminValue === 'object') {
          const nestedAdmin = Object.values(adminValue).find((row) => row && row.username && row.password);
          if (nestedAdmin) {
            return { username: String(nestedAdmin.username), password: String(nestedAdmin.password) };
          }
        }
      }

      if (equipasSnap.exists()) {
        const adminEntry = Object.values(equipasSnap.val()).find((row) => String(row?.role || '').toLowerCase() === 'admin');
        if (adminEntry) {
          return { username: String(adminEntry.username), password: String(adminEntry.password) };
        }
      }

      throw new Error('Credenciais de admin não encontradas em /admin nem em /equipas(role=admin).');
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
      return onValue(ref(db, 'submissions'), (snap) => cb(normalizeSubmissions(snap.exists() ? snap.val() : {})));
    },
    subscribeAccesses(cb) {
      return onValue(ref(db, 'access_logs'), (snap) => cb(normalizeAccessLogs(snap.exists() ? snap.val() : {})));
    },
    async registerAccess(teamId, deviceId, ua) {
      const id = `A${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const payload = {
        teamId: String(teamId),
        timestamp: new Date().toISOString(),
        deviceId: String(deviceId),
        ua: String(ua || '')
      };
      const target = ref(db, `access_logs/${id}`);
      await runTransaction(target, (current) => current || payload);
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

      const submissionsSnap = await get(ref(db, 'submissions'));
      const existingRows = normalizeSubmissions(submissionsSnap.exists() ? submissionsSnap.val() : {});
      const duplicated = existingRows.some((row) => String(row.equipa) === String(teamId) && String(row.posto) === String(game.gameId));
      if (duplicated) throw new Error('Jogo já registado para esta equipa.');

      const submissionId = `S${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const payload = {
        timestamp: new Date().toISOString(),
        posto: String(game.gameId),
        equipa: String(teamId),
        pontos: points
      };

      const target = ref(db, `submissions/${submissionId}`);
      const tx = await runTransaction(target, (current) => current || payload);
      if (!tx.committed) throw new Error('Não foi possível gravar a submissão.');

      return points;
    }
  };

  api.subscribeSubmission = api.subscribeSubmissions;
  api.subscribe = api.subscribeSubmissions;
  return api;
}

async function bootstrap() {
  bindEvents();
  firebaseApi = await createFirebaseApi();
  const [admin, teams, games] = await Promise.all([firebaseApi.getAdmin(), firebaseApi.getTeams(), firebaseApi.getGames()]);

  state.admin = admin;
  state.teams = teams;
  state.games = games;
  state.ready = true;

  const subscribeFn = firebaseApi.subscribeSubmissions || firebaseApi.subscribeSubmission || firebaseApi.subscribe;
  if (typeof subscribeFn !== 'function') {
    throw new Error('API Firebase inválida: método de subscrição de submissões não encontrado.');
  }

  subscribeFn.call(firebaseApi, (submissions) => {
    state.submissions = submissions;
    if (state.session?.role === 'team') renderTeam();
    if (state.session?.role === 'admin') renderAdmin();
  });

  const accessSub = firebaseApi.subscribeAccesses || firebaseApi.subscribeAccessLog || firebaseApi.subscribeAccess;
  if (typeof accessSub === 'function') {
    accessSub.call(firebaseApi, (accesses) => {
      state.accesses = accesses;
      if (state.session?.role === 'team') renderTeam();
    });
  }

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
  state.bootstrapError = err;
  DOM.loginError.textContent = `Erro ao iniciar: ${err.message}`;
});
