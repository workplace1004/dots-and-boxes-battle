# Dots and Boxes Battle: Architecture and Workflow

## 1. Game rules

Goal: **own the most boxes.**

1. Players take turns drawing **one** line between two neighbouring dots.
2. Drawing the fourth side of a box completes it. The box is yours.
3. If your line completed at least one box, **you go again**. One line can complete two boxes.
4. If it completed none, the turn passes to the next player.
5. When every line is drawn, the player with the most boxes wins. Equal top scores share the win.
6. Each line has a 20-second limit. If time runs out, the game draws a random open line for you. A completed box from that line still counts, and you still go again.

Boards grow with the player count:

| Players | Boxes (columns x rows) | Boxes | Lines |
|---|---|---|---|
| 2 | 5 x 5 | 25 | 60 |
| 3 | 6 x 6 | 36 | 84 |
| 4 | 7 x 7 | 49 | 112 |
| 5 | 8 x 7 | 56 | 127 |
| 6 | 8 x 8 | 64 | 144 |

The 2-player board has an odd box count, so a 2-player game cannot tie. The first player changes each round.

## 2. System overview

```
 Phone / laptop browsers                 Node.js server (one process)
+------------------------+              +-------------------------------+
| public/app.js          |   WebSocket  | server/index.js               |
|  - shows the snapshot  | <----------> |  HTTP files, sockets, limits  |
|  - sends player intent |              |             |                 |
+------------------------+              | server/rooms.js               |
                                        |  rooms, seats, timers         |
                                        |             |                 |
                                        | server/game.js                |
                                        |  pure rules, no I/O           |
                                        +-------------------------------+
```

### Key decisions

| Decision | Reason |
|---|---|
| **Standalone folder with its own `package.json`** | It installs, tests and deploys alone, and cannot break the other game in this workspace. |
| **The server decides everything** | Clients only ask ("draw line 12"), so a modified browser cannot cheat. |
| **Full snapshot after every change** | There is no sync logic to get wrong. A reconnecting player just gets the latest snapshot. |
| **Layers: `game` -> `rooms` -> `index`** | Each layer can be tested alone. |
| **Plain JavaScript with no build step, and one dependency (`ws`)** | Few moving parts to deploy or debug. |
| **Rooms stay in memory** | Games are short, so no database is needed. The trade-offs are one server process only, and a restart ends running games. |
| **Remaining time is sent, not a clock time** | Wrong clocks on players' devices cannot affect the countdown. |
| **Lines are real buttons with a diamond-shaped tap area** | The diamonds fit together with no gaps or overlaps, so every point on the board selects exactly its nearest line. That makes thin lines easy to hit on a phone, and buttons give keyboard and screen reader support. |

## 3. Board model

A board of `cols` x `rows` boxes has `(cols + 1) x (rows + 1)` dots. Each line has one integer id: horizontal lines come first, then vertical lines.

```
Horizontal lines: cols * (rows + 1)    id = row * cols + col
Vertical lines:   (cols + 1) * rows    id = horizontal + row * (cols + 1) + col
Box:              cols * rows          id = row * cols + col

Example, 2 x 2 boxes (12 lines):

  o  0  o  1  o        Box 0 has lines 0, 2, 6, 7
  6     7     8        Box 3 has lines 3, 5, 10, 11
  o  2  o  3  o        Line 7 touches boxes 0 and 1
  9    10    11        Line 0 touches box 0 only
  o  4  o  5  o
```

Game state, all of it plain data:

| Field | Meaning |
|---|---|
| `lines[id]` | The player who drew the line, or `null` |
| `boxes[id]` | The player who completed the box, or `null` |
| `turnIndex` | Position of the current player in `playerIds` |
| `lastLine`, `lastBoxes` | The latest move, so everyone can see it |
| `extraTurn` | True when the last move earned another turn |
| `moves` | Lines drawn. The game ends when it equals `lines.length` |
| `result` | `null`, or `{ winnerIds, reason }`, where `reason` is `most` or `draw` |

## 4. Files

```
server/game.js      Rules: board sizes, line geometry, draw, scoring, winner
server/rooms.js     Room codes, players, host, turn timers, reconnects
server/index.js     Static files, WebSocket, rate limits, heartbeat
public/index.html   Screens: home, lobby, game
public/style.css    Responsive layout, board and player colors
public/app.js       Connection, reconnect, drawing, input
test/               Rules, room and real-socket tests
render.yaml         Render settings, for when this folder is the repository root
```

## 5. Room lifecycle

```
          create / join             host starts           last line drawn
 (none) ----------------> LOBBY ----------------> PLAYING ----------------> FINISHED
                            ^                                                  |
                            +------------------- host: play again -------------+
```

Joining is only allowed in the lobby, and a room holds up to 6 players.

## 6. Workflows

### Create and join
1. The host enters a name and creates a room. The server returns a 4-letter code and a secret seat token.
2. Friends use the code or the shared link (`/?room=ABCD`).
3. The host starts the game once at least 2 players are present.

### A turn

```
 client: {type:"draw", line}
              |
   game running, player's turn,
   valid line, line still open? --- no ---> error to that player only, state unchanged
              | yes
   record line, award completed boxes
              |
       all lines drawn? ---- yes ---> decide result, phase = finished
              | no
       box completed? ------ yes ---> same player, new timer
              | no
       next player, new timer
              |
   snapshot to everyone
```

### Connection loss
| Situation | What happens |
|---|---|
| Connection drops | The seat is kept, and the token lets the browser tab return automatically. |
| Offline on their turn | The turn shortens to 5 seconds at most, then a random line is drawn. |
| Offline over 30 seconds, in the lobby | The player is removed. |
| Offline over 30 seconds, in a game | The player is marked gone, and their turns are played in under a second. They can still return. |
| Player presses Leave | Same as above, but they cannot return. |
| Host offline or gone | The next connected player becomes host. |
| Everybody gone | The room is deleted. |
| No player action for 1 hour | The room is deleted. |

## 7. Messages

Client to server:

| Type | Fields |
|---|---|
| `create` | `name` |
| `join` | `code`, `name` |
| `resume` | `code`, `token` |
| `start`, `playAgain`, `leave` | none |
| `draw` | `line` |

Server to client:

| Type | Meaning |
|---|---|
| `joined` | Seat details: `code`, `token`, `playerId` |
| `state` | The full room snapshot, personalized with `you` |
| `error` | `code` and a readable `message` |
| `left`, `room_closed`, `replaced` | The seat ended, for the reason in the name |

## 8. Security and limits

- All input is validated on the server, and names are cleaned and limited to 16 characters.
- Names are drawn with `textContent`, so they cannot inject HTML.
- Seat tokens are random, go only to their owner, and never appear in snapshots.
- Messages are limited to 1 KB, with a per-connection rate limit, a join attempt limit and a cap on rooms.
- Sockets from other websites are refused by an Origin check.
- Only a fixed list of files is served, which prevents path traversal.

## 9. Testing

| Level | What it proves |
|---|---|
| `test/game.test.js` | Geometry on every board, boxes, extra turns, illegal moves, ties, random full games |
| `test/rooms.test.js` | Lobby, host handover, timers and reconnects, using a fake clock |
| `test/server.test.js` | A full game over real WebSockets, plus limits and file serving |
| Browser check | Real browser sessions, including phone size |

## 10. Run it

```
npm install
npm test
npm start      # http://localhost:3001, or the port in PORT
```

The default port is 3001, so this game can run beside Territory Grab on port 3000.
