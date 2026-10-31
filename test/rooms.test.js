import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { cleanName, RoomManager } from '../server/rooms.js';

function client() {
  const messages = [];
  return {
    messages,
    closed: false,
    send(message) {
      messages.push(structuredClone(message));
    },
    close() {
      this.closed = true;
    },
    last(type) {
      return messages.findLast((message) => message.type === type);
    },
  };
}

let manager;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  manager = new RoomManager();
});

afterEach(() => {
  manager.shutdown();
  mock.timers.reset();
});

function room(names = ['Ann', 'Ben']) {
  const clients = names.map(() => client());
  manager.handle(clients[0], { type: 'create', name: names[0] });
  const { code } = clients[0].last('joined');
  names.slice(1).forEach((name, index) => {
    manager.handle(clients[index + 1], { type: 'join', code, name });
  });
  return { code, clients };
}

function started(names) {
  const result = room(names);
  manager.handle(result.clients[0], { type: 'start' });
  return result;
}

function currentClient(clients) {
  const { game, players } = clients[0].last('state');
  const index = players.findIndex((player) => player.id === game.turnPlayerId);
  return clients[index];
}

function firstOpen(clients) {
  return clients[0].last('state').game.lines.indexOf(null);
}

function playOut(clients) {
  while (clients[0].last('state').phase === 'playing') {
    manager.handle(currentClient(clients), { type: 'draw', line: firstOpen(clients) });
  }
}

test('names are cleaned and limited', () => {
  assert.equal(cleanName('  Ann   Lee '), 'Ann Lee');
  assert.equal(cleanName('A\u0000​nn'), 'Ann');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName('x'.repeat(17)), null);
  assert.equal(cleanName(42), null);
});

test('create and join share the lobby, without leaking tokens', () => {
  const { code, clients } = room();
  assert.match(code, /^[A-HJ-NP-Z]{4}$/);
  const state = clients[0].last('state');
  assert.equal(state.phase, 'lobby');
  assert.deepEqual(state.players.map((player) => player.name), ['Ann', 'Ben']);
  assert.equal(state.you, 1);
  assert.equal(clients[1].last('state').you, 2);
  const token = clients[0].last('joined').token;
  assert.ok(!JSON.stringify(clients[1].messages).includes(token));
});

test('join errors are clear', () => {
  const { code, clients } = room();
  const other = client();
  manager.handle(other, { type: 'join', code: 'ZZZZ', name: 'Cy' });
  assert.equal(other.last('error').code, 'room_not_found');
  manager.handle(other, { type: 'join', code, name: 'ANN' });
  assert.equal(other.last('error').code, 'name_taken');
  manager.handle(other, { type: 'join', code, name: '' });
  assert.equal(other.last('error').code, 'invalid_name');
  manager.handle(clients[0], { type: 'join', code, name: 'Again' });
  assert.equal(clients[0].last('error').code, 'already_in_room');
});

test('lower-case codes work and rooms hold six players', () => {
  const { code } = room(['A', 'B', 'C', 'D', 'E', 'F']);
  const seventh = client();
  manager.handle(seventh, { type: 'join', code: code.toLowerCase(), name: 'G' });
  assert.equal(seventh.last('error').code, 'room_full');
});

test('only the host starts, and only with two players', () => {
  const solo = room(['Ann']);
  manager.handle(solo.clients[0], { type: 'start' });
  assert.equal(solo.clients[0].last('error').code, 'need_players');

  const { clients, code } = room();
  manager.handle(clients[1], { type: 'start' });
  assert.equal(clients[1].last('error').code, 'not_host');
  manager.handle(clients[0], { type: 'start' });
  assert.equal(clients[0].last('state').phase, 'playing');

  const late = client();
  manager.handle(late, { type: 'join', code, name: 'Late' });
  assert.equal(late.last('error').code, 'game_started');
});

test('illegal draws only affect the sender', () => {
  const { clients } = started();
  const before = clients[1].messages.length;
  manager.handle(clients[1], { type: 'draw', line: 0 });
  assert.equal(clients[1].last('error').code, 'not_your_turn');
  assert.equal(clients[1].messages.length, before + 1);
  assert.equal(clients[0].last('state').game.moves, 0);
});

test('a draw before the game starts is refused', () => {
  const { clients } = room();
  manager.handle(clients[0], { type: 'draw', line: 0 });
  assert.equal(clients[0].last('error').code, 'board_not_ready');
});

test('closing a box keeps the turn and restarts the timer', () => {
  const { clients } = started();
  for (const line of [0, 5, 30]) {
    manager.handle(currentClient(clients), { type: 'draw', line });
  }
  mock.timers.tick(10_000);
  manager.handle(clients[1], { type: 'draw', line: 31 });

  const { game } = clients[0].last('state');
  assert.equal(game.boxes[0], 2);
  assert.equal(game.scores[2], 1);
  assert.deepEqual(game.lastBoxes, [0]);
  assert.equal(game.extraTurn, true);
  assert.equal(game.turnPlayerId, 2);
  assert.equal(game.turnMsLeft, 20_000);
});

test('a full game finishes, then returns to the lobby with the next starter', () => {
  const { clients } = started();
  assert.equal(clients[0].last('state').game.turnPlayerId, 1);
  playOut(clients);
  const finished = clients[0].last('state');
  assert.equal(finished.phase, 'finished');
  assert.ok(finished.game.result.winnerIds.length >= 1);
  assert.equal(finished.game.turnPlayerId, null);
  assert.equal(finished.game.scores[1] + finished.game.scores[2], 25);

  manager.handle(clients[1], { type: 'playAgain' });
  assert.equal(clients[1].last('error').code, 'not_host');
  manager.handle(clients[0], { type: 'playAgain' });
  assert.equal(clients[0].last('state').phase, 'lobby');
  manager.handle(clients[0], { type: 'start' });
  assert.equal(clients[0].last('state').game.turnPlayerId, 2);
});

test('a timed-out turn draws a random line and moves on', () => {
  const { clients } = started();
  mock.timers.tick(19_999);
  assert.equal(clients[0].last('state').game.moves, 0);
  mock.timers.tick(1);
  const state = clients[0].last('state');
  assert.equal(state.game.moves, 1);
  assert.equal(state.game.turnPlayerId, 2);
  assert.equal(state.game.lines.filter((owner) => owner === 1).length, 1);
});

test('timeouts alone finish a game', () => {
  const { clients } = started();
  for (let i = 0; i < 60; i += 1) {
    assert.equal(clients[0].last('state').phase, 'playing');
    mock.timers.tick(20_000);
  }
  const state = clients[0].last('state');
  assert.equal(state.phase, 'finished');
  assert.equal(state.game.scores[1] + state.game.scores[2], 25);
});

test('no timer fires after the game finishes', () => {
  const { clients } = started();
  playOut(clients);
  const count = clients[0].messages.length;
  mock.timers.tick(120_000);
  assert.equal(clients[0].messages.length, count);
});

test('a dropped player gets a short turn, then returns to the same seat', () => {
  const { clients, code } = started();
  const { token } = clients[0].last('joined');
  manager.disconnect(clients[0]);
  let state = clients[1].last('state');
  assert.equal(state.players[0].connected, false);
  assert.equal(state.hostId, 2);
  assert.ok(state.game.turnMsLeft <= 5000);

  mock.timers.tick(5000);
  assert.equal(clients[1].last('state').game.moves, 1);

  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.equal(back.last('joined').playerId, 1);
  state = back.last('state');
  assert.equal(state.you, 1);
  assert.equal(state.players[0].connected, true);
  assert.equal(state.game.moves, 1);
});

test('returning during your short turn restores thinking time, without shortening it', () => {
  const { clients, code } = started();
  const { token } = clients[0].last('joined');
  manager.disconnect(clients[0]);
  mock.timers.tick(4000);
  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.ok(back.last('state').game.turnMsLeft >= 5000);
  manager.handle(back, { type: 'draw', line: 3 });
  assert.equal(back.last('state').game.moves, 1);
});

test('a second tab replaces the first, and the old close does not drop the seat', () => {
  const { clients, code } = room();
  const { token } = clients[0].last('joined');
  const tab = client();
  manager.handle(tab, { type: 'resume', code, token });
  assert.ok(clients[0].last('replaced'));
  assert.equal(clients[0].closed, true);
  manager.disconnect(clients[0]);
  assert.equal(tab.last('state').players[0].connected, true);
});

test('bad resume attempts are refused', () => {
  const { code } = room();
  const other = client();
  manager.handle(other, { type: 'resume', code, token: 'wrong' });
  assert.equal(other.last('error').code, 'session_expired');
  manager.handle(other, { type: 'resume', code, token: null });
  assert.equal(other.last('error').code, 'session_expired');
  manager.handle(other, { type: 'resume', code: {}, token: 'x' });
  assert.equal(other.last('error').code, 'session_expired');
});

test('lobby players are removed after the grace period and the host moves', () => {
  const { clients } = room();
  manager.disconnect(clients[0]);
  assert.equal(clients[1].last('state').hostId, 2);
  assert.equal(clients[1].last('state').players.length, 2);
  mock.timers.tick(30_000);
  const state = clients[1].last('state');
  assert.deepEqual(state.players.map((player) => player.name), ['Ben']);
  const fresh = client();
  manager.handle(fresh, { type: 'join', code: state.code, name: 'Ann' });
  assert.equal(fresh.last('state').players.find((p) => p.name === 'Ann').slot, 0);
});

test('a player who leaves mid-game is auto-played quickly and cannot resume', () => {
  const { clients, code } = started();
  const { token } = clients[0].last('joined');
  manager.handle(clients[0], { type: 'leave' });
  assert.ok(clients[0].last('left'));
  assert.equal(clients[1].last('state').players[0].gone, true);
  mock.timers.tick(800);
  assert.equal(clients[1].last('state').game.moves, 1);
  const back = client();
  manager.handle(back, { type: 'resume', code, token });
  assert.equal(back.last('error').code, 'session_expired');
});

test('a game finishes even if only one player stays', () => {
  const { clients } = started(['Ann', 'Ben', 'Cy']);
  manager.handle(clients[1], { type: 'leave' });
  manager.handle(clients[2], { type: 'leave' });
  const stay = clients[0];
  while (stay.last('state').phase === 'playing') {
    const state = stay.last('state');
    if (state.game.turnPlayerId === 1) {
      manager.handle(stay, { type: 'draw', line: state.game.lines.indexOf(null) });
    } else {
      mock.timers.tick(800);
    }
  }
  assert.equal(stay.last('state').phase, 'finished');
});

test('players who left are removed when the room returns to the lobby', () => {
  const { clients } = started(['Ann', 'Ben', 'Cy']);
  manager.handle(clients[2], { type: 'leave' });
  while (clients[0].last('state').phase === 'playing') {
    const state = clients[0].last('state');
    if (state.game.turnPlayerId === 3) mock.timers.tick(800);
    else manager.handle(currentClient(clients), { type: 'draw', line: firstOpen(clients) });
  }
  manager.handle(clients[0], { type: 'playAgain' });
  assert.deepEqual(clients[0].last('state').players.map((p) => p.name), ['Ann', 'Ben']);
});

test('rooms are deleted when everyone is gone', () => {
  const { clients } = started();
  manager.disconnect(clients[0]);
  manager.disconnect(clients[1]);
  assert.equal(manager.rooms.size, 1);
  mock.timers.tick(30_000);
  assert.equal(manager.rooms.size, 0);
  assert.equal(mock.timers.tick(120_000), undefined);
});

test('idle rooms are swept and their players are told', () => {
  const { clients } = room();
  mock.timers.tick(60 * 60 * 1000);
  manager.sweep();
  assert.equal(manager.rooms.size, 0);
  assert.ok(clients[0].last('room_closed'));
  manager.handle(clients[0], { type: 'start' });
  assert.equal(clients[0].last('error').code, 'not_in_room');
});

test('the room cap and unknown messages are handled', () => {
  manager.shutdown();
  manager = new RoomManager({ maxRooms: 1 });
  room(['Ann']);
  const other = client();
  manager.handle(other, { type: 'create', name: 'Ben' });
  assert.equal(other.last('error').code, 'server_full');
  manager.handle(other, { type: 'nope' });
  assert.equal(other.last('error').code, 'bad_message');
  manager.handle(other, { type: 'draw', line: 0 });
  assert.equal(other.last('error').code, 'not_in_room');
});
