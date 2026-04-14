# CLAUDE.md

Conventions and rules for AI agents (Claude Code, the Stratos Games Factory daemon, subagents) and human contributors working in the House Mafia repo. Humans should read `README.md` first.

## Project

**House Mafia** — a mobile-first multiplayer social deduction party game. Think Mafia/Werewolf but set at a house party: lighter, funnier, faster. 4–16 players, 3–5 minute rounds, web-first with Capacitor wrapping for mobile later.

This repo is part of the [Stratos Games](https://github.com/sahilmodi1965/stratos-games-factory) portfolio. Play-test feedback comes in via GitHub Issues with the `build-request` label, and the Stratos swarm picks them up. PR previews ship to `gh-pages /pr/<number>/`. The live web build is at `gh-pages /` (mirrored from `docs/`).

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Language | Vanilla JS (ES modules) | No TypeScript, no framework |
| Markup | HTML + CSS | Mobile-first, no preprocessors |
| Build | Vite | `npm run build` → `docs/` |
| Multiplayer | Supabase Realtime | Room state, presence, role sync |
| Hosting | GitHub Pages | Free, zero-config |
| Mobile (later) | Capacitor | Web-first, wrap later |

## Repo layout

```
house-mafia/
├── index.html               ← entry point
├── src/
│   ├── main.js              ← app bootstrap, screen router
│   ├── room.js              ← room creation, joining, lobby (Supabase)
│   ├── game.js              ← game loop: role assign → night → day → vote → resolve
│   ├── roles.js             ← role definitions, assignment logic
│   ├── phases/
│   │   ├── night.js         ← mafia pick, host investigate
│   │   ├── day.js           ← discussion timer, chat
│   │   └── vote.js          ← voting UI, tally, elimination
│   ├── ui/
│   │   ├── screens.js       ← screen transitions, animations
│   │   ├── timer.js         ← countdown timer component
│   │   └── toast.js         ← notifications, reveals
│   ├── audio.js             ← sound effects, haptic feedback
│   ├── ads.js               ← ad integration (rewarded, interstitial, banner)
│   └── config.js            ← game constants (timers, thresholds, role counts)
├── assets/
│   ├── sounds/              ← .mp3/.ogg sound effects
│   └── img/                 ← icons, role art, backgrounds
├── style.css                ← global styles, party theme
├── vite.config.js           ← Vite config (build → docs/)
├── package.json
├── docs/                    ← build output (DO NOT EDIT)
├── node_modules/            ← (DO NOT EDIT)
└── .github/
    ├── workflows/           ← CI, PR previews, auto-merge, release, cleanup
    └── ISSUE_TEMPLATE/
        └── build-request.md
```

## Build / run

```bash
npm install                  # one-time
npm run dev                  # local dev server with HMR
npm run build                # production build → docs/
```

The Vite config must output to `docs/` so GitHub Pages can serve it directly. The `base` should be set appropriately for the repo name.

## Game design rules

Every builder agent and contributor must understand the game to build it correctly. These rules are the source of truth.

### Core concept

House Mafia is Mafia/Werewolf distilled to its purest form for mobile. A group of friends at a house party — but some are secretly working against the group. Fast rounds, simple mechanics, maximum social tension.

### Players and roles

- **4–16 players** per game. No bots, no AI players.
- **Role distribution**: Role counts are computed by `distributeRoles(n, preset)` in `src/roles/index.js` from a ratio/table in `config.js`. Never hardcode role counts in game logic. The composer guarantees: Mafia ≥ 1, Guests > Mafia, one Host, special roles (Detective/Doctor/Bodyguard) unlock at player-count thresholds defined in config.
- Six roles:
  - **Mafia** — knows who the other Mafia are (if 2+). Goal: eliminate Guests until Mafia count ≥ Guest count. During Night, secretly picks one player to eliminate.
  - **Host** (the party host, not a game host) — a special Guest. Once per Night, investigates one player and learns whether they are Mafia or not. Appears as "not Mafia" if investigated.
  - **Detective** (town, unlocks at 9 players) — once per Night, investigates one player. Result is INVERTED: Mafia show as "not Mafia", non-Mafia show as "Mafia". Counter-intel tool.
  - **Doctor** (town, unlocks at 11 players) — once per Night, picks a player to save. If Mafia target that player, the kill is blocked. Cannot save the same player on consecutive Nights.
  - **Bodyguard** (town, unlocks at 13 players) — once per Night, picks a player to protect. If Mafia target that player, the Bodyguard dies instead; the protected player lives. One-shot: the Bodyguard is out after their sacrifice.
  - **Guest** — no special powers. Survives by voting correctly during Day. Wins when all Mafia are eliminated.
- The **game host** (the player who created the room) is a separate concept from the Host role. The game host has UI controls to start the game but plays with whatever role they're assigned.

### Game flow

1. **Lobby** — players join via 4-letter room code. Game host sees a "Start" button when 4+ players are present.
2. **Role reveal** — roles assigned randomly. Each player sees their own role with an animation. Mafia players also see who the other Mafia are (if 2 Mafia).
3. **Night phase** (30 seconds) —
   - Mafia: pick a target to eliminate (majority if 2 Mafia; if tied, the first Mafia's pick wins).
   - Host: pick a player to investigate. Result shown privately ("Mafia" or "Not Mafia").
   - Guests: see a "night time" waiting screen. No actions.
4. **Day phase** (60 seconds) —
   - First 40 seconds: discussion. All players see a chat/text screen.
   - Last 20 seconds: voting. Each player votes for one player to eliminate. Cannot vote for yourself. Cannot abstain.
   - Majority eliminates that player. Tie = no elimination.
   - The eliminated player's role is revealed to everyone.
5. **Resolution** — check win conditions after each elimination (Night or Day).
6. **Game over** — show all roles, who was Mafia, final standings. "Play Again" button returns to lobby with same room.

### Win conditions

- **Mafia wins**: living Mafia count ≥ living non-Mafia count.
- **Guests win**: all Mafia eliminated.
- Check after every elimination (both Night kills and Day votes).

### UI/UX principles

- **Mobile-first.** Everything must work on a phone screen held in portrait. Touch targets ≥ 44px.
- **Party theme.** Dark background, neon accent colors (pink, cyan, yellow), bold sans-serif type. Think nightclub, not medieval village.
- **Fast transitions.** Screen changes should feel snappy — 200ms max for UI transitions.
- **No scrolling during gameplay.** Every phase screen must fit in one viewport.
- **Sound and haptics.** Short, punchy sound effects for: vote cast, player eliminated, role reveal, timer warning (10s left), game over. Haptic feedback on vote and elimination.
- **Spectator-friendly.** Eliminated players can watch but not interact.

### Multiplayer architecture (Supabase Realtime)

- Each game room is a Supabase Realtime channel named by the 4-letter room code.
- **Presence** tracks who is in the room (join/leave).
- **Broadcast** sends game events: role assignments, phase transitions, votes, eliminations, investigations.
- **State is authoritative on the game host's client.** The game host's device runs the game loop and broadcasts state changes. Other clients are receivers that send actions (votes, picks) back.
- Room codes: 4 uppercase letters, randomly generated, checked for collision against active channels.
- No persistent backend. Rooms exist only while the Supabase channel is active. When all players leave, the room is gone.

### Constants (in `src/config.js`)

```js
export const GAME = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 16,
  NIGHT_DURATION: 30,         // seconds
  DAY_DURATION: 60,           // seconds
  DISCUSSION_DURATION: 40,    // seconds (first part of day)
  VOTE_DURATION: 20,          // seconds (last part of day)
  ROOM_CODE_LENGTH: 4,
  ROLE_PRESETS: { classic: [/* N-indexed rows of role counts */] },
  // CLASSIC_DISTRIBUTION is the authoritative role table, consumed by
  // distributeRoles(n, 'classic'). See src/config.js for the full data.
};
```

## Code conventions

- **Vanilla JS with ES modules.** `import`/`export`, no CommonJS.
- **No frameworks.** No React, Vue, Svelte, Lit, or any UI library. DOM manipulation via `document.querySelector`, `createElement`, `classList`, etc.
- **No TypeScript.** Plain `.js` files only.
- **CSS variables for theming.** All colors, fonts, spacing defined as CSS custom properties in `:root`.
- **Keep files focused.** Aim for <200 lines per `.js` file. Split by concern.
- **Supabase client initialized once** in `src/main.js` and passed to modules that need it. Never import Supabase credentials in multiple files.
- **All game constants in `src/config.js`.** Timers, thresholds, counts — never hardcode magic numbers in game logic.

## Things to never do

- **Never edit `docs/`.** It is build output. `npm run build` regenerates it.
- **Never edit `node_modules/`.** It is managed by npm.
- **Never commit `.env` or Supabase keys in plain text.** Use environment variables or Vite's `import.meta.env`.
- **Never add a CSS preprocessor (Sass, Less, PostCSS).** Plain CSS with variables is sufficient.
- **Never add a state management library (Redux, Zustand, MobX).** Game state is a plain JS object broadcast via Supabase.
- **Never introduce server-side code.** This is a client-only game. Supabase handles multiplayer. No Express, no Fastify, no serverless functions.
- **Never hardcode role counts in game logic.** Always call `distributeRoles(n, preset)`. The supported range is `MIN_PLAYERS` (4) to `MAX_PLAYERS` (16).
- **Never show one player's secret information to another.** Role reveals, investigation results, and Mafia identity are private. The Supabase broadcast must target the correct player(s).

<!-- STRATOS-AUTOBUILDER:BEGIN -->
## Stratos autobuilder rules (factory-managed — do not hand-edit)

This section is appended by the [Stratos Games Factory](https://github.com/sahilmodi1965/stratos-games-factory). It tells the daemon's headless `claude -p` session AND any direct human contributor how to operate in this repo. The factory owns everything between the BEGIN/END markers.

### When you are invoked by the Stratos daemon

You are running non-interactively under `claude -p`. You have one job: process a single GitHub issue (the daemon will tell you which one in the prompt) and either open a clean change set or refuse with a reason.

#### Hard rules (zero exceptions)

1. **Never edit `docs/`.** It is build output generated by `npm run build`.
2. **Never edit `node_modules/`.** It is managed by npm.
3. **Never commit `.env` or Supabase credentials.** Use `import.meta.env` for secrets.
4. **Run `npm run build` as your final step.** If it fails, fix or revert until it passes. Never push a broken build.
5. **All game constants live in `src/config.js`.** Never hardcode magic numbers.
6. **Respect the game design rules above.** If the issue contradicts a game rule, refuse and explain.

#### Scope discipline

- The issue describes ONE thing. Do that one thing.
- Do not refactor surrounding code. Do not "improve" naming. Do not add comments to code you didn't change.
- Do not add features that weren't requested.

#### Commits

- Conventional commits: `fix:`, `feat:`, `chore:`, `refactor:`, `style:`, `perf:`, `docs:`, `content:`.
- One logical change per commit.
- Every commit message must reference the issue number (e.g. `feat: add night phase timer #5`) so GitHub auto-links it.

#### When to refuse

Refuse (do nothing, leave the working tree clean, and explain in your final summary) if any of these are true:

- The issue is ambiguous and you would have to guess what "good" looks like.
- The issue contradicts the game design rules in this CLAUDE.md.
- The fix requires server-side code or a backend.
- The fix requires adding a framework or major dependency.
- You cannot verify the change builds cleanly with `npm run build`.

Refusing is a successful outcome. The daemon will turn your explanation into an issue comment so a human can decide what to do next.

#### Final-step checklist before you stop

- [ ] Every commit references `#<issue-number>`.
- [ ] No edits inside `docs/` or `node_modules/`.
- [ ] No secrets committed.
- [ ] `npm run build` passes.
- [ ] Your final response is a single paragraph summarizing the change (or the refusal).

---

### Direct contributor mode

Ripon and interns use their own Claude Code ($20 Pro plan) to push directly to this repo. **This is expected and encouraged** — the daemon and direct pushes coexist by design. Rules:

- **Push small changes** (content tweaks, asset updates, CSS, copy edits, config changes, simple bug fixes) directly to `main`. Don't open a PR for a one-line fix.
- **Use feature branches** for anything that changes game mechanics, multiplayer logic, or role assignment. Open a PR for review.
- **Always pull before pushing**: `git pull --rebase origin main`.
- **Use conventional commits**: `fix:`, `feat:`, `chore:`, `content:`. Reference an issue number when one exists.
- **Never delete `auto/*` branches manually.** The daemon owns them and the weekly cleanup workflow sweeps them.
- **If CI fails after your push, fix it immediately or revert**: `git revert HEAD && git push`. Don't leave `main` red.

### Priority of work (for play-testers)

If you are a human play-tester, your job is **NOT to write code**. Your job is, in priority order:

1. **Play the game obsessively.** Host games, recruit friends, find every broken interaction.
2. **File detailed issues** for everything. Use the `Build Request` template. One thing per issue.
3. **Use your own Claude Code ($20 Pro) for quick 2-minute fixes** — CSS tweaks, copy edits, config tuning. Push directly to main.
4. **Test every PR preview.** When the daemon comments with a preview URL, click it on your phone, play through a full round, comment your verdict.
5. **Test every auto-merged change** on the live URL within an hour of the merge.
6. **When the game feels ready for a release**, talk to Sahil and add the `ship-it` label.

What you should NOT spend time on:
- Editing `docs/` or `node_modules/` (off-limits).
- Changing Supabase config or environment variables (needs Sahil).
- Refactoring core game logic without a clear bug.
<!-- STRATOS-AUTOBUILDER:END -->
