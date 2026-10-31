# Dots and Boxes Battle

A live multiplayer game for 2 to 6 players. Take turns drawing lines between dots. Close a box to claim it and go again. Most boxes wins. Friends join from any phone or laptop with a room code.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the rules, design and workflows.

## Run it on your computer

Requires Node.js 22 or newer.

```
npm install
npm start
```

Open http://localhost:3001. To try multiplayer alone, open a second browser tab and join with the room code.

## Test it

```
npm test
```

## Put it online (free)

Render runs this game because it supports the always-open connections (WebSockets) the game needs. Vercel's standard hosting does not, so don't use it for this game.

1. Upload this folder to a new GitHub repository.
2. Sign in at https://render.com and choose **New > Blueprint**.
3. Select the repository. Render reads `render.yaml` and sets everything up.
4. Share the `https://dots-and-boxes-battle-....onrender.com` link it gives you.

On Render's free plan, the server sleeps when unused, so the first visit can take about a minute. Restarts and sleep also end running games, because rooms are kept in memory.
