// Browser client. It shows snapshots from the server and sends player intent.
// The server makes every game decision.

const SYMBOLS = ['●', '▲', '■', '◆', '★', '✚'];
const SESSION_KEY = 'dots-boxes-battle-session';
const NAME_KEY = 'dots-boxes-battle-name';
const TITLE = 'Dots and Boxes Battle';
const LOW_TIME_MS = 5000;
const MAX_RECONNECT_MS = 8000;
const CONFETTI_PIECES = 70;
const DEMO_STEP_MS = 1500;

// Lines use the same ids as a real board: 0-3 horizontal, 4-6 vertical. Slots 0 and 1 play.
const DEMO_STEPS = [
  { line: 0, slot: 0, caption: 'Red draws a line.' },
  { line: 4, slot: 1, caption: 'Blue draws a line.' },
  { line: 2, slot: 0, caption: 'Red draws the third side. Risky!' },
  { line: 5, slot: 1, box: 0, caption: 'Blue closes the box and claims it.' },
  { line: 1, slot: 1, caption: 'A closed box means Blue goes again.' },
  { line: 6, slot: 0, caption: 'Red draws another third side.' },
  { line: 3, slot: 1, box: 1, caption: 'Blue closes it too. Most boxes wins!' },
];

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let socket = null;
let reconnectMs = 500;
let allowReconnect = true;
let state = null;
let boardSize = null;
let lineEls = [];
let boxEls = [];
let deadline = 0;
let wasMyTurn = false;
let wasPlaying = false;
let shownScores = {};
let toastTimer = null;

// Storage can be unavailable in private windows, and the game must still work.
function storageGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Without storage, the player only loses automatic rejoin after a refresh.
  }
}

function getSession() {
  try {
    return JSON.parse(storageGet(sessionStorage, SESSION_KEY));
  } catch {
    return null;
  }
}

function setSession(session) {
  storageSet(sessionStorage, SESSION_KEY, session ? JSON.stringify(session) : null);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}/ws`);
  showConnection(state || getSession() ? 'Reconnecting…' : 'Connecting to the server…');
  updateHomeButtons();

  socket.addEventListener('open', () => {
    reconnectMs = 500;
    showConnection(null);
    updateHomeButtons();
    const session = getSession();
    if (session) send({ type: 'resume', code: session.code, token: session.token });
  });

  socket.addEventListener('message', (event) => {
    handleMessage(JSON.parse(event.data));
  });

  socket.addEventListener('close', () => {
    updateHomeButtons();
    if (!allowReconnect) return;
    showConnection(state || getSession() ? 'Reconnecting…' : 'Connecting to the server…');
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  toast('Not connected yet. Try again in a moment.');
  return false;
}

function handleMessage(message) {
  switch (message.type) {
    case 'joined':
      setSession({ code: message.code, token: message.token });
      history.replaceState(null, '', location.pathname);
      break;
    case 'state':
      render(message);
      break;
    case 'error':
      if (message.code === 'session_expired') {
        endSeat('That game has ended.');
      } else {
        toast(message.message);
      }
      break;
    case 'left':
      endSeat(null);
      break;
    case 'room_closed':
      endSeat('The room closed.');
      break;
    case 'replaced':
      allowReconnect = false;
      state = null;
      showConnection('This game is now open in another tab. Refresh to play here.');
      break;
    default:
      break;
  }
}

function endSeat(notice) {
  setSession(null);
  state = null;
  wasMyTurn = false;
  wasPlaying = false;
  shownScores = {};
  boardSize = null;
  document.title = TITLE;
  showScreen('home');
  if (notice) toast(notice);
}

function showScreen(name) {
  // A long lobby can leave the page scrolled, which would hide the top of the board.
  if ($(name).hidden) window.scrollTo(0, 0);
  for (const id of ['home', 'lobby', 'game']) $(id).hidden = id !== name;
}

function showConnection(text) {
  $('connection').hidden = !text;
  $('connection').textContent = text ?? '';
}

function updateHomeButtons() {
  const open = socket?.readyState === WebSocket.OPEN;
  $('create').disabled = !open;
  $('join').disabled = !open;
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 3500);
}

function makeBadge(player) {
  const badge = document.createElement('span');
  badge.className = `badge slot-${player.slot}`;
  badge.textContent = SYMBOLS[player.slot];
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

function render(next) {
  state = next;
  if (next.phase === 'lobby') renderLobby(next);
  else renderGame(next);
}

function renderLobby(s) {
  showScreen('lobby');
  wasMyTurn = false;
  wasPlaying = false;
  shownScores = {};
  document.title = TITLE;
  boardSize = null;
  $('lobby-code').textContent = s.code;
  $('player-count').textContent = `(${s.players.length} of 6)`;

  const items = s.players.map((player) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.name;
    item.append(makeBadge(player), name);
    const tags = [];
    if (player.id === s.you) tags.push('you');
    if (player.id === s.hostId) tags.push('host');
    if (!player.connected) tags.push('offline');
    if (tags.length > 0) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tags.join(', ');
      item.append(tag);
    }
    return item;
  });
  $('lobby-players').replaceChildren(...items);

  const isHost = s.hostId === s.you;
  const enough = s.players.length >= 2;
  $('start').hidden = !isHost;
  $('start').disabled = !enough;
  $('start').textContent = enough ? 'Start game' : 'Waiting for one more player…';
  $('lobby-wait').hidden = isHost;
  const host = s.players.find((player) => player.id === s.hostId);
  $('lobby-wait').textContent = `Waiting for ${host?.name ?? 'the host'} to start the game.`;
}

function place(element, x, y) {
  element.style.setProperty('--x', x);
  element.style.setProperty('--y', y);
}

// Layers, bottom to top: boxes, then lines, then dots. Same line id order as the server.
function buildBoard({ cols, rows }) {
  const board = $('board');
  board.style.setProperty('--cols', cols);
  board.style.setProperty('--rows', rows);

  boxEls = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const box = document.createElement('div');
      place(box, col, row);
      boxEls.push(box);
    }
  }

  lineEls = [];
  const addLine = (kind, x, y, name) => {
    const line = document.createElement('button');
    const id = lineEls.length;
    line.type = 'button';
    line.dataset.name = name;
    line.dataset.kind = kind;
    place(line, x, y);
    const stroke = document.createElement('span');
    stroke.className = 'stroke';
    line.append(stroke);
    line.addEventListener('click', () => send({ type: 'draw', line: id }));
    lineEls.push(line);
  };
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      addLine('h', col + 0.5, row, `Horizontal line, row ${row + 1}, column ${col + 1}`);
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      addLine('v', col, row + 0.5, `Vertical line, row ${row + 1}, column ${col + 1}`);
    }
  }

  const dots = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      place(dot, col, row);
      dots.push(dot);
    }
  }

  $('grid').replaceChildren(...boxEls, ...lineEls, ...dots);
  boardSize = `${cols}x${rows}`;
}

function renderGame(s) {
  showScreen('game');
  const { game } = s;
  if (boardSize !== `${game.cols}x${game.rows}`) buildBoard(game);

  const players = new Map(s.players.map((player) => [player.id, player]));
  const myTurn = s.phase === 'playing' && game.turnPlayerId === s.you;
  const finished = s.phase === 'finished';
  const winners = new Set(game.result?.winnerIds ?? []);
  const fresh = new Set(game.lastBoxes);

  game.boxes.forEach((ownerId, index) => {
    const box = boxEls[index];
    const row = Math.floor(index / game.cols) + 1;
    const col = (index % game.cols) + 1;
    if (ownerId === null) {
      box.className = 'box';
      box.textContent = '';
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
      return;
    }
    const owner = players.get(ownerId);
    const classes = ['box', 'owned', `slot-${owner.slot}`];
    if (fresh.has(index)) classes.push('fresh');
    if (finished && winners.has(ownerId)) classes.push('win');
    box.className = classes.join(' ');
    box.textContent = SYMBOLS[owner.slot];
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `Box, row ${row}, column ${col}, ${owner.name}`);
  });

  game.lines.forEach((ownerId, index) => {
    const line = lineEls[index];
    const { kind, name } = line.dataset;
    if (ownerId === null) {
      line.className = `line ${kind} open`;
      line.disabled = !myTurn;
      line.setAttribute('aria-label', `${name}, open`);
      return;
    }
    const owner = players.get(ownerId);
    const classes = ['line', kind, 'drawn', `slot-${owner.slot}`];
    if (index === game.lastLine) classes.push('new');
    if (index === game.lastLine && !finished) classes.push('last');
    line.className = classes.join(' ');
    line.disabled = true;
    line.setAttribute('aria-label', `${name}, drawn by ${owner.name}`);
  });

  renderStatus(s, myTurn, players);
  renderScores(s);

  // The board glows in the color of whoever is drawing, or of the winner at the end.
  const accentId = finished ? game.result.winnerIds[0] : game.turnPlayerId;
  $('board').className = `board slot-${players.get(accentId).slot}${myTurn ? ' mine' : ''}`;
  $('game-code').textContent = s.code;
  const left = game.boxes.filter((owner) => owner === null).length;
  $('boxes-left').textContent = finished ? 'Game over' : `${boxesText(left)} left`;

  if (finished && wasPlaying) celebrate(game.result.winnerIds.map((id) => players.get(id).slot));
  wasPlaying = s.phase === 'playing';

  const isHost = s.hostId === s.you;
  $('again').hidden = !(finished && isHost);
  $('again-wait').hidden = !(finished && !isHost);

  deadline = performance.now() + game.turnMsLeft;
  updateTimer();

  // Browsers block vibration until the player has tapped the page.
  if (myTurn && !wasMyTurn && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(40);
  wasMyTurn = myTurn;
  document.title = myTurn ? `● Your turn - ${TITLE}` : TITLE;
}

function renderStatus(s, myTurn, players) {
  const status = $('status');
  const { game } = s;
  status.classList.toggle('mine', myTurn);
  let text;
  if (s.phase === 'finished') {
    text = resultText(s, players);
    status.classList.toggle('mine', game.result.winnerIds.includes(s.you));
  } else if (myTurn) {
    text = game.extraTurn
      ? `${boxesText(game.lastBoxes.length)} closed! Go again`
      : 'Your turn: draw any line';
  } else {
    const { name } = players.get(game.turnPlayerId);
    text = game.extraTurn
      ? `${name} closed ${boxesText(game.lastBoxes.length)} and goes again…`
      : `${name} is choosing…`;
  }
  if (status.textContent !== text) {
    status.textContent = text;
    animate(status, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 220);
  }
}

// CSS cannot animate between snapshots, so moves that depend on the previous state use this.
function animate(element, keyframes, duration) {
  if (!reducedMotion.matches) element.animate(keyframes, { duration, easing: 'ease-out' });
}

function celebrate(slots) {
  if (reducedMotion.matches) return;
  const pieces = [];
  for (let i = 0; i < CONFETTI_PIECES; i += 1) {
    const piece = document.createElement('span');
    piece.className = `piece slot-${slots[i % slots.length]}`;
    piece.style.setProperty('--left', `${Math.random() * 100}vw`);
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 30}vw`);
    piece.style.setProperty('--spin', `${360 + Math.random() * 720}deg`);
    piece.style.setProperty('--delay', `${Math.random() * 0.7}s`);
    piece.addEventListener('animationend', () => piece.remove());
    pieces.push(piece);
  }
  $('confetti').replaceChildren(...pieces);
}

function boxesText(count) {
  return `${count} ${count === 1 ? 'box' : 'boxes'}`;
}

function resultText(s, players) {
  const { result, scores } = s.game;
  const boxes = boxesText(scores[result.winnerIds[0]]);
  if (result.reason === 'draw') {
    const names = result.winnerIds.map((id) => players.get(id).name).join(' and ');
    return `It's a tie! ${names} share the win with ${boxes}.`;
  }
  const winner = result.winnerIds[0] === s.you ? 'You win' : `${players.get(result.winnerIds[0]).name} wins`;
  return `${winner} with ${boxes}!`;
}

function renderScores(s) {
  const { game } = s;
  const winners = game.result?.winnerIds ?? [];
  const list = $('scores');
  const oldTops = new Map(
    [...list.children].map((item) => [item.dataset.player, item.getBoundingClientRect().top]),
  );
  const rows = [...s.players]
    .sort((a, b) => game.scores[b.id] - game.scores[a.id] || a.slot - b.slot)
    .map((player) => {
      const item = document.createElement('li');
      item.className = `score slot-${player.slot}`;
      item.dataset.player = player.id;
      if (player.id === game.turnPlayerId) item.classList.add('turn');
      if (winners.includes(player.id)) item.classList.add('winner');

      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = player.id === s.you ? `${player.name} (you)` : player.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      let detail = 'Waiting';
      if (player.gone) detail = 'Left: auto-playing';
      else if (!player.connected) detail = 'Offline';
      else if (winners.includes(player.id)) detail = 'Winner';
      else if (s.phase === 'finished') detail = 'Finished';
      else if (player.id === game.turnPlayerId) detail = 'Drawing…';
      tag.textContent = detail;
      info.append(name, tag);

      const big = document.createElement('span');
      big.className = 'big';
      big.textContent = game.scores[player.id];
      big.title = 'Boxes';
      big.setAttribute('aria-label', boxesText(game.scores[player.id]));

      if (game.scores[player.id] > (shownScores[player.id] ?? game.scores[player.id])) {
        animate(big, [{ transform: 'scale(1.7)' }, { transform: 'scale(1)' }], 350);
      }

      item.append(makeBadge(player), info, big);
      return item;
    });
  list.replaceChildren(...rows);
  shownScores = { ...game.scores };

  // Players slide to their new rank instead of jumping there.
  for (const item of rows) {
    const oldTop = oldTops.get(item.dataset.player);
    const shift = oldTop === undefined ? 0 : oldTop - item.getBoundingClientRect().top;
    if (shift !== 0) {
      animate(item, [{ transform: `translateY(${shift}px)` }, { transform: 'none' }], 300);
    }
  }
}

// The looping board on the home screen, built with the same classes as the real one.
function startDemo() {
  $('demo').style.setProperty('--cols', 2);
  $('demo').style.setProperty('--rows', 1);
  const makeLine = (kind, x, y) => {
    const line = document.createElement('div');
    line.className = `line ${kind} open`;
    place(line, x, y);
    const stroke = document.createElement('span');
    stroke.className = 'stroke';
    line.append(stroke);
    return line;
  };
  const boxes = [0, 1].map((col) => {
    const box = document.createElement('div');
    box.className = 'box';
    place(box, col, 0);
    return box;
  });
  const lines = [
    makeLine('h', 0.5, 0),
    makeLine('h', 1.5, 0),
    makeLine('h', 0.5, 1),
    makeLine('h', 1.5, 1),
    makeLine('v', 0, 0.5),
    makeLine('v', 1, 0.5),
    makeLine('v', 2, 0.5),
  ];
  const dots = [];
  for (let row = 0; row <= 1; row += 1) {
    for (let col = 0; col <= 2; col += 1) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      place(dot, col, row);
      dots.push(dot);
    }
  }
  $('demo-grid').replaceChildren(...boxes, ...lines, ...dots);

  const show = (step) => {
    lines.forEach((line) => line.classList.remove('new', 'last'));
    boxes.forEach((box) => box.classList.remove('fresh'));
    lines[step.line].className = `line ${lines[step.line].classList[1]} drawn new last slot-${step.slot}`;
    if (step.box !== undefined) {
      boxes[step.box].className = `box owned fresh slot-${step.slot}`;
      boxes[step.box].textContent = SYMBOLS[step.slot];
    }
    $('demo-caption').textContent = step.caption;
  };

  // Without motion, the finished board stays on screen with the final caption.
  if (reducedMotion.matches) {
    DEMO_STEPS.forEach(show);
    return;
  }

  const reset = () => {
    lines.forEach((line) => {
      line.className = `line ${line.classList[1]} open`;
    });
    boxes.forEach((box) => {
      box.className = 'box';
      box.textContent = '';
    });
  };
  // Two extra beats hold the finished board before it starts over.
  let tick = 0;
  setInterval(() => {
    if ($('home').hidden) return;
    if (tick < DEMO_STEPS.length) show(DEMO_STEPS[tick]);
    tick += 1;
    if (tick === DEMO_STEPS.length + 2) {
      reset();
      tick = 0;
    }
  }, DEMO_STEP_MS);
  show(DEMO_STEPS[0]);
  tick = 1;
}

function updateTimer() {
  const fill = $('timer-fill');
  const seconds = $('timer-seconds');
  if (!state?.game || state.phase !== 'playing') {
    fill.style.transform = 'scaleX(0)';
    seconds.textContent = '';
    return;
  }
  const { game } = state;
  const left = Math.max(0, deadline - performance.now());
  const total = Math.max(game.turnMsTotal, 1);
  fill.style.transform = `scaleX(${Math.min(1, left / total)})`;
  const mine = game.turnPlayerId === state.you;
  const low = mine && left <= LOW_TIME_MS;
  fill.classList.toggle('mine', mine);
  fill.classList.toggle('low', low);
  seconds.classList.toggle('low', low);
  seconds.textContent = `${Math.ceil(left / 1000)}s`;
}

function currentName() {
  const name = $('name').value.trim();
  if (!name) {
    toast('Enter your name first.');
    $('name').focus();
    return null;
  }
  storageSet(localStorage, NAME_KEY, name);
  return name;
}

async function shareInvite() {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied.');
  } catch {
    toast(`Share this link: ${url}`);
  }
}

$('create').addEventListener('click', () => {
  const name = currentName();
  if (name) send({ type: 'create', name });
});

function joinRoom() {
  const name = currentName();
  if (!name) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Enter the 4-letter room code.');
    $('code').focus();
    return;
  }
  send({ type: 'join', code, name });
}

$('join').addEventListener('click', joinRoom);
$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoom();
});
$('name').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if ($('code').value.trim()) joinRoom();
  else $('create').click();
});
$('share').addEventListener('click', shareInvite);
$('start').addEventListener('click', () => send({ type: 'start' }));
$('again').addEventListener('click', () => send({ type: 'playAgain' }));
$('lobby-leave').addEventListener('click', () => send({ type: 'leave' }));
$('game-leave').addEventListener('click', () => {
  const running = state?.phase === 'playing';
  if (!running || confirm('Leave this game? You will not be able to return.')) {
    send({ type: 'leave' });
  }
});

$('name').value = storageGet(localStorage, NAME_KEY) ?? '';
const invitedCode = new URLSearchParams(location.search).get('room');
if (invitedCode) {
  $('code').value = invitedCode.slice(0, 4).toUpperCase();
  $($('name').value ? 'join' : 'name').focus();
}

setInterval(updateTimer, 100);
startDemo();
updateHomeButtons();
connect();
