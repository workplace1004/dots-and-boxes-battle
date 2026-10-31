import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

let app;
let base;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${app.port}`;
});

after(() => app.close());

// A socket client that lets a test wait for the next message matching a condition.
async function connect(options) {
  const socket = new WebSocket(`ws://${base}/ws`, options);
  const inbox = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else inbox.push(message);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    next(match) {
      const index = inbox.findIndex(match);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

const isType = (type) => (message) => message.type === type;

test('serves the game files and health check with security headers', async () => {
  const page = await fetch(`http://${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /Dots and Boxes Battle/);
  assert.equal((await fetch(`http://${base}/app.js`)).status, 200);
  assert.equal((await fetch(`http://${base}/style.css`)).status, 200);
  assert.equal(await (await fetch(`http://${base}/health`)).text(), 'ok');
});

test('other paths cannot reach private files', async () => {
  for (const path of ['/package.json', '/server/index.js', '/..%2fpackage.json', '/nope']) {
    assert.equal((await fetch(`http://${base}${path}`)).status, 404, path);
  }
});

test('sockets from another website are refused', async () => {
  await assert.rejects(connect({ headers: { Origin: 'https://evil.example' } }));
  const same = await connect({ headers: { Origin: `http://${base}` } });
  same.socket.close();
});

test('two clients play a whole game over real sockets', async () => {
  const ann = await connect();
  ann.send({ type: 'create', name: 'Ann' });
  const { code } = await ann.next(isType('joined'));

  const ben = await connect();
  ben.send({ type: 'join', code, name: 'Ben' });
  await ben.next(isType('joined'));
  await ann.next((message) => message.type === 'state' && message.players.length === 2);

  ann.send({ type: 'start' });
  const clients = new Map([[1, ann], [2, ben]]);
  let state = await ann.next((message) => message.phase === 'playing');
  await ben.next((message) => message.phase === 'playing');

  while (state.phase === 'playing') {
    const moves = state.game.moves + 1;
    const line = state.game.lines.indexOf(null);
    clients.get(state.game.turnPlayerId).send({ type: 'draw', line });
    const isNext = (message) => message.type === 'state' && message.game?.moves === moves;
    [state] = await Promise.all([ann.next(isNext), ben.next(isNext)]);
    // The rate limit allows normal play. This pace only keeps a very fast test under it.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  assert.equal(state.phase, 'finished');
  assert.ok(state.game.result.winnerIds.length >= 1);
  assert.equal(state.game.scores[1] + state.game.scores[2], 25);
  ann.socket.close();
  ben.socket.close();
});

test('malformed messages get an error and the connection survives', async () => {
  const client = await connect();
  for (const bad of ['not json', 'null', '[]', '42', '{"type":"__proto__"}']) {
    client.socket.send(bad);
    assert.equal((await client.next(isType('error'))).code, 'bad_message');
  }
  client.send({ type: 'create', name: 'Still fine' });
  await client.next(isType('joined'));
  client.socket.close();
});

test('oversized messages close the connection', async () => {
  const client = await connect();
  const closed = new Promise((resolve) => client.socket.once('close', resolve));
  client.socket.on('error', () => {});
  client.socket.send(JSON.stringify({ type: 'create', name: 'x'.repeat(2000) }));
  assert.equal(await closed, 1009);
});

test('message floods and join guessing are rate limited', async () => {
  const flood = await connect();
  for (let i = 0; i < 40; i += 1) flood.send({ type: 'nope' });
  const limited = await flood.next((message) => message.code === 'rate_limited');
  assert.ok(limited);
  flood.socket.close();

  const guesser = await connect();
  for (let i = 0; i < 25; i += 1) {
    guesser.send({ type: 'join', code: 'ZZZZ', name: 'Guess' });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const blocked = await guesser.next((message) => message.message?.includes('Too many attempts'));
  assert.ok(blocked);
  guesser.socket.close();
});
