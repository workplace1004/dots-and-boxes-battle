// Pure game rules. No timers, sockets or randomness, so every rule is easy to test.

// Sizes are in boxes. The 2-player board has an odd box count, so that game cannot tie.
export const BOARD_SIZES = {
  2: { cols: 5, rows: 5 },
  3: { cols: 6, rows: 6 },
  4: { cols: 7, rows: 7 },
  5: { cols: 8, rows: 7 },
  6: { cols: 8, rows: 8 },
};

// Line ids: horizontal lines row by row, then vertical lines row by row.
function horizontalCount({ cols, rows }) {
  return cols * (rows + 1);
}

export function createGame(playerIds, firstIndex = 0) {
  const size = BOARD_SIZES[playerIds.length];
  if (!size) throw new Error(`Unsupported player count: ${playerIds.length}`);
  const { cols, rows } = size;
  return {
    cols,
    rows,
    lines: new Array(horizontalCount(size) + (cols + 1) * rows).fill(null),
    boxes: new Array(cols * rows).fill(null),
    playerIds: [...playerIds],
    turnIndex: firstIndex % playerIds.length,
    lastLine: null,
    lastBoxes: [],
    extraTurn: false,
    moves: 0,
    result: null,
  };
}

export function currentPlayerId(game) {
  return game.playerIds[game.turnIndex];
}

export function openLines(game) {
  const lines = [];
  game.lines.forEach((owner, line) => {
    if (owner === null) lines.push(line);
  });
  return lines;
}

// The four sides of a box: top, bottom, left, right.
export function boxLines(game, box) {
  const { cols } = game;
  const col = box % cols;
  const row = Math.floor(box / cols);
  const left = horizontalCount(game) + row * (cols + 1) + col;
  return [row * cols + col, (row + 1) * cols + col, left, left + 1];
}

// The one or two boxes a line borders.
export function lineBoxes(game, line) {
  const { cols, rows } = game;
  const horizontal = horizontalCount(game);
  const boxes = [];
  if (line < horizontal) {
    const col = line % cols;
    const row = Math.floor(line / cols);
    if (row > 0) boxes.push((row - 1) * cols + col);
    if (row < rows) boxes.push(row * cols + col);
  } else {
    const offset = line - horizontal;
    const col = offset % (cols + 1);
    const row = Math.floor(offset / (cols + 1));
    if (col > 0) boxes.push(row * cols + col - 1);
    if (col < cols) boxes.push(row * cols + col);
  }
  return boxes;
}

// Returns an error code, or null when the line was drawn.
export function drawLine(game, playerId, line) {
  if (game.result) return 'game_over';
  if (playerId !== currentPlayerId(game)) return 'not_your_turn';
  if (!Number.isInteger(line) || line < 0 || line >= game.lines.length) return 'invalid_line';
  if (game.lines[line] !== null) return 'line_taken';

  game.lines[line] = playerId;
  game.lastLine = line;
  game.moves += 1;

  game.lastBoxes = lineBoxes(game, line).filter((box) =>
    boxLines(game, box).every((side) => game.lines[side] !== null),
  );
  for (const box of game.lastBoxes) game.boxes[box] = playerId;

  game.extraTurn = game.lastBoxes.length > 0;
  if (game.moves === game.lines.length) {
    game.extraTurn = false;
    game.result = decideResult(game);
  } else if (!game.extraTurn) {
    game.turnIndex = (game.turnIndex + 1) % game.playerIds.length;
  }
  return null;
}

// Box count for each player.
export function scoreGame(game) {
  const scores = {};
  for (const id of game.playerIds) scores[id] = 0;
  for (const owner of game.boxes) {
    if (owner !== null) scores[owner] += 1;
  }
  return scores;
}

function decideResult(game) {
  const scores = scoreGame(game);
  const best = Math.max(...Object.values(scores));
  const winnerIds = game.playerIds.filter((id) => scores[id] === best);
  return { winnerIds, reason: winnerIds.length > 1 ? 'draw' : 'most' };
}
