// Rooms, seats and turn timers. Knows nothing about sockets: a connection is any
// object with send(message) and an optional close().
import { randomBytes, randomInt } from 'node:crypto';
import { createGame, currentPlayerId, drawLine, openLines, scoreGame } from './game.js';

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_NAME_LENGTH = 16;

const DEFAULTS = {
  turnMs: 20_000,
  offlineTurnMs: 5_000,
  goneTurnMs: 800,
  graceMs: 30_000,
  idleMs: 60 * 60 * 1000,
  maxRooms: 1000,
};

const MESSAGES = {
  already_in_room: 'You are already in a room.',
  bad_message: 'That request was not understood.',
  board_not_ready: 'The game is not running.',
  game_over: 'The game is over.',
  game_started: 'That game has already started.',
  invalid_line: 'That line does not exist.',
  invalid_name: `Enter a name of 1 to ${MAX_NAME_LENGTH} characters.`,
  line_taken: 'That line is already drawn.',
  name_taken: 'Someone in this room already has that name.',
  need_players: `You need at least ${MIN_PLAYERS} players to start.`,
  not_host: 'Only the host can do that.',
  not_in_room: 'You are not in a room.',
  not_your_turn: 'It is not your turn.',
  room_full: `That room is full (${MAX_PLAYERS} players).`,
  room_not_found: 'No room has that code. Check it and try again.',
  server_full: 'The server is full. Please try again soon.',
  session_expired: 'Your seat has ended.',
};

export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH) return null;
  return name;
}

export class RoomManager {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.rooms = new Map();
    this.seats = new Map(); // connection -> { room, player }
  }

  // Entry point for every client message.
  handle(conn, message) {
    const type = message?.type;
    switch (type) {
      case 'create':
        return this.#create(conn, message);
      case 'join':
        return this.#join(conn, message);
      case 'resume':
        return this.#resume(conn, message);
      case 'start':
      case 'draw':
      case 'playAgain':
      case 'leave': {
        const seat = this.seats.get(conn);
        if (!seat) return this.#fail(conn, 'not_in_room');
        seat.room.lastActivity = Date.now();
        if (type === 'start') return this.#start(conn, seat);
        if (type === 'draw') return this.#draw(conn, seat, message.line);
        if (type === 'playAgain') return this.#playAgain(conn, seat);
        return this.#leave(conn, seat);
      }
      default:
        return this.#fail(conn, 'bad_message');
    }
  }

  disconnect(conn) {
    const seat = this.seats.get(conn);
    if (!seat) return;
    this.seats.delete(conn);
    const { room, player } = seat;
    if (player.conn !== conn) return;

    player.conn = null;
    player.graceTimer = setTimeout(() => this.#expire(room, player), this.options.graceMs);
    this.#ensureHost(room);
    if (room.phase === 'playing' && this.#isTurnOf(room, player)) {
      const left = room.turnDeadline - Date.now();
      this.#scheduleTurn(room, Math.min(left, this.options.offlineTurnMs));
    }
    this.#broadcast(room);
  }

  // Removes rooms nobody has acted in for a long time.
  sweep() {
    const cutoff = Date.now() - this.options.idleMs;
    for (const room of this.rooms.values()) {
      if (room.lastActivity <= cutoff) this.#destroy(room, true);
    }
  }

  shutdown() {
    for (const room of this.rooms.values()) this.#destroy(room, true);
  }

  #create(conn, { name: rawName }) {
    if (this.seats.has(conn)) return this.#fail(conn, 'already_in_room');
    const name = cleanName(rawName);
    if (!name) return this.#fail(conn, 'invalid_name');
    if (this.rooms.size >= this.options.maxRooms) return this.#fail(conn, 'server_full');

    const room = {
      code: this.#newCode(),
      phase: 'lobby',
      players: [],
      hostId: null,
      nextPlayerId: 1,
      round: 0,
      game: null,
      turnTimer: null,
      turnDeadline: 0,
      turnTotal: 0,
      lastActivity: Date.now(),
    };
    this.rooms.set(room.code, room);
    this.#seat(conn, room, name);
  }

  #join(conn, { code: rawCode, name: rawName }) {
    if (this.seats.has(conn)) return this.#fail(conn, 'already_in_room');
    const name = cleanName(rawName);
    if (!name) return this.#fail(conn, 'invalid_name');
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return this.#fail(conn, 'room_not_found');
    if (room.phase !== 'lobby') return this.#fail(conn, 'game_started');
    if (room.players.length >= MAX_PLAYERS) return this.#fail(conn, 'room_full');

    const lowered = name.toLowerCase();
    if (room.players.some((player) => player.name.toLowerCase() === lowered)) {
      return this.#fail(conn, 'name_taken');
    }
    room.lastActivity = Date.now();
    this.#seat(conn, room, name);
  }

  #resume(conn, { code, token }) {
    if (this.seats.has(conn)) return this.#fail(conn, 'already_in_room');
    const room = typeof code === 'string' ? this.rooms.get(code) : null;
    const player =
      room && typeof token === 'string'
        ? room.players.find((candidate) => candidate.token === token)
        : null;
    if (!player) return this.#fail(conn, 'session_expired');

    if (player.conn) {
      const old = player.conn;
      this.seats.delete(old);
      old.send({ type: 'replaced' });
      old.close?.();
    }
    clearTimeout(player.graceTimer);
    player.conn = conn;
    player.gone = false;
    this.seats.set(conn, { room, player });
    room.lastActivity = Date.now();
    this.#ensureHost(room);

    // A returning player gets normal thinking time if the short offline timer is running.
    if (room.phase === 'playing' && this.#isTurnOf(room, player)) {
      const left = room.turnDeadline - Date.now();
      this.#scheduleTurn(room, Math.max(left, this.options.offlineTurnMs));
    }
    conn.send({ type: 'joined', code: room.code, token: player.token, playerId: player.id });
    this.#broadcast(room);
  }

  #start(conn, { room, player }) {
    if (room.hostId !== player.id) return this.#fail(conn, 'not_host');
    if (room.phase !== 'lobby') return this.#fail(conn, 'game_started');
    if (room.players.length < MIN_PLAYERS) return this.#fail(conn, 'need_players');

    room.game = createGame(
      room.players.map((candidate) => candidate.id),
      room.round,
    );
    room.round += 1;
    room.phase = 'playing';
    this.#beginTurn(room);
    this.#broadcast(room);
  }

  #draw(conn, { room, player }, line) {
    if (room.phase !== 'playing') return this.#fail(conn, 'board_not_ready');
    const error = drawLine(room.game, player.id, line);
    if (error) return this.#fail(conn, error);
    this.#afterMove(room);
  }

  #playAgain(conn, { room, player }) {
    if (room.hostId !== player.id) return this.#fail(conn, 'not_host');
    if (room.phase !== 'finished') return this.#fail(conn, 'board_not_ready');
    room.players = room.players.filter((candidate) => !candidate.gone);
    room.game = null;
    room.phase = 'lobby';
    this.#broadcast(room);
  }

  #leave(conn, { room, player }) {
    this.seats.delete(conn);
    clearTimeout(player.graceTimer);
    player.conn = null;
    player.token = null; // The seat cannot be resumed after leaving on purpose.
    conn.send({ type: 'left' });
    this.#markGone(room, player);
  }

  #expire(room, player) {
    if (player.conn || !this.rooms.has(room.code)) return;
    this.#markGone(room, player);
  }

  #markGone(room, player) {
    if (room.phase === 'lobby') {
      room.players = room.players.filter((candidate) => candidate !== player);
    } else {
      player.gone = true;
    }
    if (room.players.every((candidate) => candidate.gone)) {
      this.#destroy(room, false);
      return;
    }
    this.#ensureHost(room);
    if (room.phase === 'playing' && this.#isTurnOf(room, player)) {
      this.#scheduleTurn(room, this.options.goneTurnMs);
    }
    this.#broadcast(room);
  }

  #seat(conn, room, name) {
    const used = new Set(room.players.map((player) => player.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    const player = {
      id: room.nextPlayerId,
      name,
      slot,
      token: randomBytes(16).toString('hex'),
      conn,
      gone: false,
      graceTimer: null,
    };
    room.nextPlayerId += 1;
    room.players.push(player);
    this.seats.set(conn, { room, player });
    this.#ensureHost(room);
    conn.send({ type: 'joined', code: room.code, token: player.token, playerId: player.id });
    this.#broadcast(room);
  }

  #ensureHost(room) {
    const host = room.players.find((player) => player.id === room.hostId);
    if (host?.conn) return;
    const next = room.players.find((player) => player.conn);
    if (next) room.hostId = next.id;
  }

  #isTurnOf(room, player) {
    return currentPlayerId(room.game) === player.id;
  }

  #beginTurn(room) {
    const player = room.players.find((candidate) => candidate.id === currentPlayerId(room.game));
    let duration = this.options.turnMs;
    if (player.gone) duration = this.options.goneTurnMs;
    else if (!player.conn) duration = this.options.offlineTurnMs;
    room.turnTotal = duration;
    this.#scheduleTurn(room, duration);
  }

  #scheduleTurn(room, duration) {
    clearTimeout(room.turnTimer);
    const ms = Math.max(0, duration);
    room.turnDeadline = Date.now() + ms;
    room.turnTotal = Math.max(room.turnTotal, ms);
    room.turnTimer = setTimeout(() => this.#autoPlay(room), ms);
  }

  #autoPlay(room) {
    if (room.phase !== 'playing') return;
    const lines = openLines(room.game);
    const line = lines[randomInt(lines.length)];
    drawLine(room.game, currentPlayerId(room.game), line);
    this.#afterMove(room);
  }

  #afterMove(room) {
    clearTimeout(room.turnTimer);
    if (room.game.result) {
      room.phase = 'finished';
    } else {
      room.turnTotal = 0;
      this.#beginTurn(room);
    }
    this.#broadcast(room);
  }

  #broadcast(room) {
    const base = this.#snapshot(room);
    for (const player of room.players) {
      player.conn?.send({ ...base, you: player.id });
    }
  }

  #snapshot(room) {
    let game = null;
    if (room.game) {
      const { cols, rows, lines, boxes, lastLine, lastBoxes, extraTurn, moves, result } = room.game;
      const playing = room.phase === 'playing';
      game = {
        cols,
        rows,
        lines,
        boxes,
        lastLine,
        lastBoxes,
        extraTurn,
        moves,
        result,
        scores: scoreGame(room.game),
        turnPlayerId: playing ? currentPlayerId(room.game) : null,
        turnMsLeft: playing ? Math.max(0, room.turnDeadline - Date.now()) : 0,
        turnMsTotal: playing ? room.turnTotal : 0,
      };
    }
    return {
      type: 'state',
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map(({ id, name, slot, conn, gone }) => ({
        id,
        name,
        slot,
        connected: Boolean(conn),
        gone,
      })),
      game,
    };
  }

  #destroy(room, notify) {
    clearTimeout(room.turnTimer);
    for (const player of room.players) {
      clearTimeout(player.graceTimer);
      if (player.conn) {
        this.seats.delete(player.conn);
        if (notify) player.conn.send({ type: 'room_closed' });
      }
    }
    this.rooms.delete(room.code);
  }

  #newCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  #fail(conn, code) {
    conn.send({ type: 'error', code, message: MESSAGES[code] });
  }
}
