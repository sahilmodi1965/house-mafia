# house-mafia

A mobile-first multiplayer social deduction party game. Think Mafia/Werewolf but set at a house party: lighter, funnier, faster. 4–8 players, 3–5 minute rounds, web-first.

## Build and run

```bash
npm install        # one-time setup
npm run dev        # local dev server with HMR at http://localhost:5173
npm run build      # production build → docs/
```

The live build is hosted on GitHub Pages. PR previews are deployed to `/pr/<number>/` automatically by CI.

---

## Solo-tester playbook

You are the only person at your laptop and you need to verify a multiplayer change before merging. This section is your complete walkthrough.

### 1. Open 4 incognito windows on one laptop

Incognito (private) windows give each tab a fresh storage context — each one gets its own `localStorage`/`sessionStorage`, so they don't share player identity or room state.

| Browser | Shortcut (macOS) | Shortcut (Win/Linux) |
|---|---|---|
| Chrome / Brave | Cmd-Shift-N | Ctrl-Shift-N |
| Firefox | Cmd-Shift-P | Ctrl-Shift-P |
| Safari | Cmd-Shift-N | — |
| Edge | Cmd-Shift-N | Ctrl-Shift-N |

Open four such windows (or tabs within one incognito window — each tab still has separate session storage). Point all four at your dev server: `http://localhost:5173`.

### 2. Use `?dev=1` for solo testing

Appending `?dev=1` to any URL activates dev mode. What it does:

- **Lobby threshold drops to 1 player.** You can create a room and start a game alone — no need to fill all 4 seats manually.
- **"Add Stub Player" button** appears in the lobby. Each click spawns a local NPC that auto-acknowledges ready, auto-votes randomly during day phase, and auto-picks during night phase. Add 3 stubs to reach the 4-player minimum.
- **`sessionStorage` instead of `localStorage`** for player identity. This means each incognito tab (or even regular tabs in the same browser) gets its own identity automatically — no tab will claim to be the same player as another.

**Walkthrough:**

1. In window 1, visit `http://localhost:5173/?dev=1`
2. Tap **Create Room** — note the 4-letter room code (e.g. `XKCD`)
3. Tap **Add Stub Player** three times — you now have 4 players
4. Tap **Start** — the game plays through automatically with the stubs handling NPC actions
5. Use windows 2–4 to join the same room (`http://localhost:5173/?dev=1`) if you want to test a specific player's view during a phase

> Tip: to test role-private information (Mafia identity, Host investigation results), open window 2, join the room, and watch the network panel in DevTools — verify that Supabase broadcast messages targeting one player are not visible to others.

### 3. Use Pass & Play mode for offline / IRL testing

Pass & Play is a single-device mode with no Supabase, no network, no room codes. It is the cleanest way to test role logic and game flow without any network setup, and it is the intended mode for actual house parties.

**Walkthrough:**

1. Tap **Pass & Play** on the title screen
2. Enter 4–8 player names (one per line or one per input field)
3. The game assigns roles privately — hand the device to each player in turn for their role reveal (the screen clears between reveals so others can't peek)
4. Day discussion happens IRL — the app shows a discussion timer
5. Voting happens on the device — the screen clears between each player's vote
6. Elimination and win condition checks happen automatically

Use Pass & Play to verify:
- Role distribution is correct for the player count (e.g. 4 players = 1 Mafia, 1 Host, 2 Guests)
- Mafia partners can see each other (when 2 Mafia)
- Host investigation result is shown only to the Host player
- Elimination reveals the correct role

### 4. What to test for each PR type

#### Multiplayer change
_Touches `src/room.js`, `src/game.js`, `src/curator.js`, or `src/phases/*`_

- Open 4 incognito tabs, all at `?dev=1`
- Window 1: create room, add 3 stubs, start game
- Watch each phase transition in all 4 windows — verify all tabs advance together
- Open DevTools Network panel → WS tab in windows 2–4. Confirm that Supabase Realtime messages carrying role or investigation data are not broadcast to wrong players
- Play through at least one full round (Night → Day → Vote → Resolution)

#### UI change
_Touches `src/ui/*` or `style.css`_

- Test on a phone-sized viewport: Chrome DevTools → Toggle device toolbar → iPhone 14 Pro or similar (390 × 844)
- Check touch target sizes — every button must be ≥ 44px tall
- Verify no horizontal scroll at 390px width
- Play through one full round on the simulated mobile viewport
- Also spot-check at 768px (tablet) to catch anything that breaks between breakpoints

#### Role change
_Touches `src/roles.js` or any file under `src/roles/*`_

- Play a 4-player game (1 Mafia, 1 Host, 2 Guests) — verify distribution
- Play a 6-player game (2 Mafia, 1 Host, 3 Guests) — verify Mafia partners can see each other
- Confirm that the Host's investigation result says "Mafia" or "Not Mafia" correctly
- Confirm that eliminated players' roles are revealed to everyone at elimination

#### Bug fix
_Addresses a specific issue_

- Reproduce the original bug using the steps in the linked issue before applying the fix
- Apply the fix and confirm the bug is gone
- Check the manual test steps written in the PR body — run each one
- Smoke-test adjacent functionality (if the bug was in voting, also test elimination)

#### Build / CI change
_Touches `vite.config.js`, `package.json`, `.github/workflows/*`, or `playwright.config.js`_

- Run `npm run build` locally — confirm it exits 0 and `docs/` is populated
- Run the Playwright smoke test: `npx playwright test` — confirm all tests pass
- If a workflow changed, push to a branch and check the Actions tab on GitHub

---

## Contributing

See [CLAUDE.md](CLAUDE.md) for full conventions, game design rules, and agent operating constraints. File bugs and feature requests as GitHub Issues using the `Build Request` template.
