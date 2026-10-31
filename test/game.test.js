import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOARD_SIZES,
  boxLines,
  createGame,
  currentPlayerId,
  drawLine,
  lineBoxes,
  openLines,
  scoreGame,
} from '../server/game.js';

const PLAYERS = (count) => Array.from({ length: count }, (_, index) => index + 1);

// Draws lines for whoever's turn it is.
function play(game, lines) {
  for (const line of lines) assert.equal(drawLine(game, currentPlayerId(game), line), null);
}

test('unsupported player counts are refused', () => {
  assert.throws(() => createGame([1]));
  assert.throws(() => createGame(PLAYERS(7)));
});

test('board sizes match the documented line counts', () => {
  const expected = { 2: [25, 60], 3: [36, 84], 4: [49, 112], 5: [56, 127], 6: [64, 144] };
  for (const [count, [boxes, lines]] of Object.entries(expected)) {
    const game = createGame(PLAYERS(Number(count)));
    assert.equal(game.boxes.length, boxes, `${count} players`);
    assert.equal(game.lines.length, lines, `${count} players`);
  }
});

test('box and line geometry agree on every board', () => {
  for (const count of Object.keys(BOARD_SIZES)) {
    const game = createGame(PLAYERS(Number(count)));
    game.boxes.forEach((_, box) => {
      const sides = boxLines(game, box);
      assert.equal(new Set(sides).size, 4);
      for (const side of sides) {
        assert.ok(side >= 0 && side < game.lines.length);
        assert.ok(lineBoxes(game, side).includes(box));
      }
    });
    let edgeLines = 0;
    game.lines.forEach((_, line) => {
      const boxes = lineBoxes(game, line);
      assert.ok(boxes.length === 1 || boxes.length === 2);
      if (boxes.length === 1) edgeLines += 1;
      for (const box of boxes) assert.ok(boxLines(game, box).includes(line));
    });
    assert.equal(edgeLines, 2 * (game.cols + game.rows), 'only the outer border has one box');
  }
});

test('lines do not wrap around the board edges', () => {
  const game = createGame([1, 2]); // 5 x 5, so 30 horizontal lines
  assert.deepEqual(lineBoxes(game, 0), [0], 'top border');
  assert.deepEqual(lineBoxes(game, 25), [20], 'bottom border');
  assert.deepEqual(lineBoxes(game, 5), [0, 5], 'inner horizontal');
  assert.deepEqual(lineBoxes(game, 30), [0], 'left border');
  assert.deepEqual(lineBoxes(game, 35), [4], 'right border, end of the first row');
  assert.deepEqual(lineBoxes(game, 36), [5], 'left border, start of the second row');
  assert.deepEqual(boxLines(game, 0), [0, 5, 30, 31]);
  assert.deepEqual(boxLines(game, 24), [24, 29, 58, 59]);
});

test('moves are validated', () => {
  const game = createGame([1, 2]);
  assert.equal(drawLine(game, 2, 0), 'not_your_turn');
  assert.equal(drawLine(game, 1, 0), null);
  assert.equal(currentPlayerId(game), 2);
  assert.equal(drawLine(game, 2, 0), 'line_taken');
  for (const bad of [-1, 60, 1.5, '1', null, undefined]) {
    assert.equal(drawLine(game, 2, bad), 'invalid_line');
  }
  assert.equal(game.moves, 1);
  assert.equal(game.lastLine, 0);
});

test('firstIndex chooses who starts', () => {
  assert.equal(currentPlayerId(createGame([1, 2, 3], 4)), 2);
});

test('the fourth side claims the box and earns another turn', () => {
  const game = createGame([1, 2]);
  play(game, [0, 5, 30]);
  assert.equal(game.extraTurn, false);
  assert.equal(currentPlayerId(game), 2);

  play(game, [31]);
  assert.equal(game.boxes[0], 2);
  assert.deepEqual(game.lastBoxes, [0]);
  assert.equal(game.extraTurn, true);
  assert.equal(currentPlayerId(game), 2, 'the scorer goes again');
  assert.equal(scoreGame(game)[2], 1);

  play(game, [59]);
  assert.deepEqual(game.lastBoxes, []);
  assert.equal(game.extraTurn, false);
  assert.equal(currentPlayerId(game), 1, 'a line with no box passes the turn');
});

test('one line can claim two boxes', () => {
  const game = createGame([1, 2]);
  // Boxes 0 and 1 share vertical line 31. Draw everything around them first.
  game.turnIndex = 0;
  for (const line of [0, 5, 30, 1, 6, 32]) game.lines[line] = 1;
  game.moves = 6;
  assert.equal(drawLine(game, 1, 31), null);
  assert.deepEqual(game.lastBoxes, [0, 1]);
  assert.equal(scoreGame(game)[1], 2);
  assert.equal(currentPlayerId(game), 1);
});

test('turns rotate through every player and skip nobody', () => {
  const game = createGame([1, 2, 3]);
  const order = [];
  for (const line of [0, 2, 4, 6]) {
    order.push(currentPlayerId(game));
    drawLine(game, currentPlayerId(game), line);
  }
  assert.deepEqual(order, [1, 2, 3, 1]);
});

test('equal top scores share the win', () => {
  const game = createGame([1, 2, 3]);
  const lastBox = game.boxes.length - 1;
  const lastLine = boxLines(game, lastBox)[3]; // The right border only touches this box.
  game.lines.fill(3);
  game.lines[lastLine] = null;
  game.moves = game.lines.length - 1;
  game.boxes = game.boxes.map((_, box) => {
    if (box === lastBox) return null;
    return box < 17 ? 1 : 2;
  });
  game.turnIndex = 0;

  assert.equal(drawLine(game, 1, lastLine), null);
  assert.equal(scoreGame(game)[1], 18);
  assert.equal(scoreGame(game)[2], 18);
  assert.deepEqual(game.result, { winnerIds: [1, 2], reason: 'draw' });
});

test('the most boxes wins outright', () => {
  const game = createGame([1, 2]);
  const lastBox = game.boxes.length - 1;
  const lastLine = boxLines(game, lastBox)[3];
  game.lines.fill(2);
  game.lines[lastLine] = null;
  game.moves = game.lines.length - 1;
  game.boxes = game.boxes.map((_, box) => {
    if (box === lastBox) return null;
    return box < 12 ? 1 : 2;
  });
  game.turnIndex = 0;

  assert.equal(drawLine(game, 1, lastLine), null);
  assert.deepEqual(scoreGame(game), { 1: 13, 2: 12 });
  assert.deepEqual(game.result, { winnerIds: [1], reason: 'most' });
  assert.equal(game.extraTurn, false);
  assert.equal(drawLine(game, 1, 0), 'game_over');
});

test('random full games on every board stay consistent', () => {
  // A small repeatable generator, so a failure can be reproduced.
  let seed = 12345;
  const next = (limit) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };

  for (const count of Object.keys(BOARD_SIZES)) {
    for (let round = 0; round < 25; round += 1) {
      const game = createGame(PLAYERS(Number(count)), round);
      while (!game.result) {
        const before = currentPlayerId(game);
        const owned = game.boxes.filter((owner) => owner !== null).length;
        const open = openLines(game);
        assert.equal(drawLine(game, before, open[next(open.length)]), null);

        const gained = game.boxes.filter((owner) => owner !== null).length - owned;
        assert.equal(gained, game.lastBoxes.length);
        assert.ok(gained <= 2);
        if (!game.result) {
          assert.equal(currentPlayerId(game) === before, gained > 0);
        }
      }
      assert.equal(game.moves, game.lines.length);
      assert.ok(game.boxes.every((owner) => owner !== null));
      const scores = Object.values(scoreGame(game));
      assert.equal(scores.reduce((sum, score) => sum + score, 0), game.boxes.length);
      assert.equal(openLines(game).length, 0);
      const best = Math.max(...scores);
      for (const id of game.result.winnerIds) assert.equal(scoreGame(game)[id], best);
    }
  }
});
