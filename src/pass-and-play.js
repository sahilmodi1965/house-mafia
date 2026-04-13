import { GAME } from './config.js';
import { assignRoles, ROLES } from './roles.js';

/**
 * Pass & Play — single-device local mode.
 * No Supabase, no network. Entire game state lives in this module.
 * Flow: name entry → role reveal (per player) → day discuss → vote → resolve → game over
 *
 * @param {HTMLElement} container - Root app element
 * @param {Object} opts
 * @param {Function} opts.onLeave - Called to return to the title screen
 */
export function startPassAndPlay(container, { onLeave }) {
  showNameEntry(container, onLeave);
}

// ---------------------------------------------------------------------------
// Phase 1 — Name Entry
// ---------------------------------------------------------------------------

function showNameEntry(container, onLeave) {
  const min = GAME.MIN_PLAYERS;
  const max = GAME.MAX_PLAYERS;

  function render(names) {
    container.innerHTML = `
      <div id="screen-pnp-names" class="screen active">
        <h1>Pass &amp; Play</h1>
        <p style="color: var(--neon-cyan); margin-bottom: 1rem; font-size: 0.9rem;">
          Enter ${min}–${max} player names
        </p>
        <div id="name-fields">
          ${names.map((n, i) => `
            <input
              type="text"
              class="input pnp-name-input"
              data-index="${i}"
              placeholder="Player ${i + 1}"
              value="${n}"
              maxlength="16"
              autocomplete="off"
            />
          `).join('')}
        </div>
        <p id="name-error" class="error-text"></p>
        <button class="btn btn--cyan" id="btn-add-player" ${names.length >= max ? 'disabled' : ''}>
          + Add Player
        </button>
        <button class="btn btn--pink" id="btn-start-pnp">Start Game</button>
        <button class="btn" id="btn-pnp-leave" style="background: var(--surface); color: var(--text);">
          Back
        </button>
      </div>
    `;

    // Keep current state in sync as user types
    document.querySelectorAll('.pnp-name-input').forEach((input) => {
      input.addEventListener('input', () => {
        names[Number(input.dataset.index)] = input.value;
      });
    });

    document.getElementById('btn-add-player').addEventListener('click', () => {
      if (names.length < max) {
        names.push('');
        render(names);
        // Focus the newly added input
        const inputs = document.querySelectorAll('.pnp-name-input');
        inputs[inputs.length - 1].focus();
      }
    });

    document.getElementById('btn-start-pnp').addEventListener('click', () => {
      // Collect current input values
      const currentNames = Array.from(document.querySelectorAll('.pnp-name-input'))
        .map((el) => el.value.trim())
        .filter((n) => n.length > 0);

      const errorEl = document.getElementById('name-error');

      if (currentNames.length < min) {
        errorEl.textContent = `Need at least ${min} players.`;
        return;
      }

      const unique = new Set(currentNames.map((n) => n.toLowerCase()));
      if (unique.size !== currentNames.length) {
        errorEl.textContent = 'All player names must be unique.';
        return;
      }

      // Build player objects (use index-based IDs — no UUIDs needed offline)
      const players = currentNames.map((name, i) => ({ id: `p${i}`, name }));
      const assignments = assignRoles(players);

      // Build game state
      const gameState = {
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          role: assignments[p.id].role,
          mafiaPartners: assignments[p.id].mafiaPartners,
          alive: true,
        })),
      };

      startRoleRevealPhase(container, gameState, onLeave);
    });

    document.getElementById('btn-pnp-leave').addEventListener('click', onLeave);
  }

  render(['', '', '', '']); // Start with 4 blank slots
}

// ---------------------------------------------------------------------------
// Phase 2 — Role Reveal (pass-the-phone)
// ---------------------------------------------------------------------------

function startRoleRevealPhase(container, gameState, onLeave) {
  revealNextPlayer(container, gameState, 0, onLeave);
}

function revealNextPlayer(container, gameState, index, onLeave) {
  const { players } = gameState;

  if (index >= players.length) {
    // All roles seen — move to Day
    startDayPhase(container, gameState, null, onLeave);
    return;
  }

  const player = players[index];

  // "Pass to <Name>" handoff screen
  container.innerHTML = `
    <div id="screen-pnp-handoff" class="screen active">
      <h1>Pass to</h1>
      <p style="font-size: 2rem; font-weight: 900; color: var(--neon-yellow); margin: 1.5rem 0;">
        ${player.name}
      </p>
      <p style="color: var(--neon-cyan); margin-bottom: 2rem; font-size: 0.9rem;">
        Hand the phone to <strong>${player.name}</strong>, then tap below.
      </p>
      <button class="btn btn--pink" id="btn-im-player">I'm ${player.name}</button>
    </div>
  `;

  document.getElementById('btn-im-player').addEventListener('click', () => {
    showPlayerRole(container, gameState, index, onLeave);
  });
}

function showPlayerRole(container, gameState, index, onLeave) {
  const player = gameState.players[index];
  const { role, mafiaPartners } = player;

  let description = '';
  if (role.id === 'mafia') {
    description = 'Eliminate the Guests before they find you. Do NOT react to this screen.';
    if (mafiaPartners.length > 0) {
      const partnerNames = mafiaPartners.map((p) => p.name).join(', ');
      description += ` Your Mafia partner: <strong>${partnerNames}</strong>.`;
    }
  } else if (role.id === 'host') {
    description =
      'You are the Host. Each Night, you may secretly investigate one player to learn if they are Mafia.';
  } else {
    description = 'You are a Guest. Survive by voting out the Mafia during the Day.';
  }

  container.innerHTML = `
    <div id="screen-pnp-role" class="screen active">
      <h1>Your Role</h1>
      <div class="role-card" style="--role-color: ${role.color}">
        <div class="role-card__inner flipped">
          <div class="role-card__front">
            <span class="role-card__question">?</span>
          </div>
          <div class="role-card__back">
            <span class="role-card__emoji">${role.emoji}</span>
            <span class="role-card__name">${role.name}</span>
          </div>
        </div>
      </div>
      <p class="role-description">${description}</p>
      <button class="btn btn--cyan" id="btn-done-role">Done — clear screen</button>
    </div>
  `;

  document.getElementById('btn-done-role').addEventListener('click', () => {
    revealNextPlayer(container, gameState, index + 1, onLeave);
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — Night (Mafia pick + Host investigate)
// ---------------------------------------------------------------------------

function startNightPhase(container, gameState, roundNum, onLeave) {
  const alivePlayers = gameState.players.filter((p) => p.alive);
  const aliveMafia = alivePlayers.filter((p) => p.role.id === 'mafia');
  const aliveHost = alivePlayers.find((p) => p.role.id === 'host');

  // Night actions: mafia picks a target, host picks a target to investigate
  const nightActions = {
    mafiaTarget: null, // player id
    mafiaVotes: {},    // mafiaPlayerId -> targetId
    hostTarget: null,  // player id
    hostResult: null,  // 'mafia' | 'not mafia'
  };

  // Build queue of players who need to act at night
  const actorQueue = [...aliveMafia.map((p) => ({ player: p, role: 'mafia' }))];
  if (aliveHost) actorQueue.push({ player: aliveHost, role: 'host' });

  function processNextActor(queueIndex) {
    if (queueIndex >= actorQueue.length) {
      // Resolve night actions
      resolveNight(container, gameState, nightActions, roundNum, onLeave);
      return;
    }

    const { player, role } = actorQueue[queueIndex];

    if (role === 'mafia') {
      showNightMafiaPick(container, gameState, player, nightActions, () => {
        processNextActor(queueIndex + 1);
      });
    } else {
      showNightHostInvestigate(container, gameState, player, nightActions, () => {
        processNextActor(queueIndex + 1);
      });
    }
  }

  // Intro screen
  container.innerHTML = `
    <div id="screen-pnp-night-intro" class="screen active">
      <h1>Night Falls</h1>
      <p style="color: var(--neon-cyan); margin: 1.5rem 0; line-height: 1.5;">
        Everyone close your eyes. The Mafia${aliveHost ? ' and the Host' : ''} will be
        summoned one at a time.
      </p>
      <button class="btn btn--pink" id="btn-night-begin">Begin Night</button>
    </div>
  `;

  document.getElementById('btn-night-begin').addEventListener('click', () => {
    processNextActor(0);
  });
}

function showNightMafiaPick(container, gameState, mafiaPlayer, nightActions, onDone) {
  const alivePlayers = gameState.players.filter((p) => p.alive);
  const targets = alivePlayers.filter((p) => p.role.id !== 'mafia');

  // Handoff
  container.innerHTML = `
    <div id="screen-pnp-handoff" class="screen active">
      <h1>Night — Mafia</h1>
      <p style="font-size: 1.5rem; font-weight: 900; color: var(--neon-pink); margin: 1.5rem 0;">
        ${mafiaPlayer.name}
      </p>
      <p style="color: var(--neon-cyan); margin-bottom: 2rem; font-size: 0.9rem;">
        Pass the phone to <strong>${mafiaPlayer.name}</strong> secretly.
      </p>
      <button class="btn btn--pink" id="btn-mafia-ready">I'm ${mafiaPlayer.name}</button>
    </div>
  `;

  document.getElementById('btn-mafia-ready').addEventListener('click', () => {
    container.innerHTML = `
      <div id="screen-pnp-mafia-pick" class="screen active">
        <h1>Choose your target</h1>
        <p style="color: var(--neon-pink); margin-bottom: 1.5rem; font-size: 0.9rem;">
          Pick someone to eliminate tonight. Your choice is secret.
        </p>
        <div id="mafia-targets">
          ${targets.map((t) => `
            <button class="btn btn--pink vote-btn" data-id="${t.id}" data-name="${t.name}">
              ${t.name}
            </button>
          `).join('')}
        </div>
        <p id="mafia-pick-status" class="vote-status"></p>
      </div>
    `;

    document.getElementById('mafia-targets').addEventListener('click', (e) => {
      const btn = e.target.closest('.vote-btn');
      if (!btn) return;

      const targetId = btn.dataset.id;
      const targetName = btn.dataset.name;

      // Record vote
      nightActions.mafiaVotes[mafiaPlayer.id] = targetId;

      // Show confirmation, then clear
      container.innerHTML = `
        <div id="screen-pnp-mafia-done" class="screen active">
          <h1>Noted</h1>
          <p style="color: var(--neon-cyan); margin: 1.5rem 0;">
            Your pick has been recorded. Hand the phone back face-down.
          </p>
          <button class="btn btn--cyan" id="btn-mafia-done">Done</button>
        </div>
      `;
      document.getElementById('btn-mafia-done').addEventListener('click', onDone);
    });
  });
}

function showNightHostInvestigate(container, gameState, hostPlayer, nightActions, onDone) {
  const alivePlayers = gameState.players.filter((p) => p.alive);
  const targets = alivePlayers.filter((p) => p.id !== hostPlayer.id);

  container.innerHTML = `
    <div id="screen-pnp-handoff" class="screen active">
      <h1>Night — Host</h1>
      <p style="font-size: 1.5rem; font-weight: 900; color: var(--neon-cyan); margin: 1.5rem 0;">
        ${hostPlayer.name}
      </p>
      <p style="color: var(--neon-cyan); margin-bottom: 2rem; font-size: 0.9rem;">
        Pass the phone to <strong>${hostPlayer.name}</strong> secretly.
      </p>
      <button class="btn btn--cyan" id="btn-host-ready">I'm ${hostPlayer.name}</button>
    </div>
  `;

  document.getElementById('btn-host-ready').addEventListener('click', () => {
    container.innerHTML = `
      <div id="screen-pnp-host-investigate" class="screen active">
        <h1>Investigate</h1>
        <p style="color: var(--neon-cyan); margin-bottom: 1.5rem; font-size: 0.9rem;">
          Pick a player to investigate. You'll see if they are Mafia or not.
        </p>
        <div id="host-targets">
          ${targets.map((t) => `
            <button class="btn btn--cyan vote-btn" data-id="${t.id}" data-is-mafia="${t.role.id === 'mafia' ? '1' : '0'}">
              ${t.name}
            </button>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById('host-targets').addEventListener('click', (e) => {
      const btn = e.target.closest('.vote-btn');
      if (!btn) return;

      const targetId = btn.dataset.id;
      const isMafia = btn.dataset.isMafia === '1';
      nightActions.hostTarget = targetId;
      nightActions.hostResult = isMafia ? 'Mafia' : 'Not Mafia';

      const targetPlayer = gameState.players.find((p) => p.id === targetId);

      container.innerHTML = `
        <div id="screen-pnp-host-result" class="screen active">
          <h1>Investigation</h1>
          <p style="font-size: 1.5rem; font-weight: 900; margin: 1.5rem 0; color: ${isMafia ? 'var(--neon-pink)' : 'var(--neon-yellow)'};">
            ${targetPlayer ? targetPlayer.name : 'That player'} is
            <strong>${nightActions.hostResult}</strong>.
          </p>
          <p style="color: var(--neon-cyan); margin-bottom: 2rem; font-size: 0.9rem;">
            Remember this. Hand the phone back face-down.
          </p>
          <button class="btn btn--cyan" id="btn-host-done">Done</button>
        </div>
      `;
      document.getElementById('btn-host-done').addEventListener('click', onDone);
    });
  });
}

function resolveNight(container, gameState, nightActions, roundNum, onLeave) {
  // Resolve Mafia votes — majority wins; tie = first-mafia's pick
  const voteMap = nightActions.mafiaVotes;
  const tally = {};
  for (const targetId of Object.values(voteMap)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  let eliminatedId = null;
  let maxVotes = 0;
  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count;
      eliminatedId = id;
    }
  }

  // If no votes recorded (e.g. no mafia alive — shouldn't happen but guard)
  let eliminatedName = null;
  if (eliminatedId) {
    const target = gameState.players.find((p) => p.id === eliminatedId);
    if (target) {
      target.alive = false;
      eliminatedName = target.name;
    }
  }

  const winner = checkWin(gameState.players);
  if (winner) {
    showGameOver(container, gameState, winner, onLeave);
    return;
  }

  startDayPhase(container, gameState, eliminatedName, onLeave);
}

// ---------------------------------------------------------------------------
// Phase 4 — Day Discussion (IRL — phone shows a prompt + done button)
// ---------------------------------------------------------------------------

function startDayPhase(container, gameState, nightEliminatedName, onLeave) {
  const alivePlayers = gameState.players.filter((p) => p.alive);

  const announcement = nightEliminatedName
    ? `During the night, <strong>${nightEliminatedName}</strong> was eliminated.`
    : `No one was eliminated during the night.`;

  const playerListHTML = gameState.players.map((p) => {
    const classes = ['day-player-item'];
    if (!p.alive) classes.push('day-player-item--dead');
    return `<li class="${classes.join(' ')}">${p.name}${!p.alive ? ' <span class="day-player-status">eliminated</span>' : ''}</li>`;
  }).join('');

  container.innerHTML = `
    <div id="screen-pnp-day" class="screen active">
      <h1>Day — Discuss!</h1>
      <p class="day-announcement">${announcement}</p>
      <ul class="day-player-list">${playerListHTML}</ul>
      <p style="color: var(--neon-yellow); margin: 1rem 0; line-height: 1.5; font-size: 0.95rem;">
        ${alivePlayers.length} players alive. Discuss out loud — who is Mafia? When ready, tap below to vote.
      </p>
      <button class="btn btn--pink" id="btn-go-vote">Ready to Vote</button>
    </div>
  `;

  document.getElementById('btn-go-vote').addEventListener('click', () => {
    startVotePhase(container, gameState, onLeave);
  });
}

// ---------------------------------------------------------------------------
// Phase 5 — Vote (pass-the-phone per alive player)
// ---------------------------------------------------------------------------

function startVotePhase(container, gameState, onLeave) {
  const alivePlayers = gameState.players.filter((p) => p.alive);
  const votes = {}; // voterId -> targetId

  function collectVote(playerIndex) {
    if (playerIndex >= alivePlayers.length) {
      resolveVote(container, gameState, votes, onLeave);
      return;
    }

    const voter = alivePlayers[playerIndex];
    const targets = alivePlayers.filter((p) => p.id !== voter.id);

    // Handoff
    container.innerHTML = `
      <div id="screen-pnp-handoff" class="screen active">
        <h1>Vote</h1>
        <p style="font-size: 1.5rem; font-weight: 900; color: var(--neon-yellow); margin: 1.5rem 0;">
          ${voter.name}
        </p>
        <p style="color: var(--neon-cyan); margin-bottom: 2rem; font-size: 0.9rem;">
          Pass the phone to <strong>${voter.name}</strong> to cast their vote.
        </p>
        <button class="btn btn--pink" id="btn-voter-ready">I'm ${voter.name}</button>
      </div>
    `;

    document.getElementById('btn-voter-ready').addEventListener('click', () => {
      container.innerHTML = `
        <div id="screen-pnp-vote" class="screen active">
          <h1>Vote to Eliminate</h1>
          <p style="color: var(--neon-cyan); margin-bottom: 1rem; font-size: 0.9rem;">
            ${voter.name}, choose who to eliminate:
          </p>
          <div id="vote-targets">
            ${targets.map((t) => `
              <button class="btn btn--pink vote-btn" data-id="${t.id}" data-name="${t.name}">
                ${t.name}
              </button>
            `).join('')}
          </div>
        </div>
      `;

      document.getElementById('vote-targets').addEventListener('click', (e) => {
        const btn = e.target.closest('.vote-btn');
        if (!btn) return;

        votes[voter.id] = btn.dataset.id;

        container.innerHTML = `
          <div id="screen-pnp-vote-done" class="screen active">
            <h1>Vote Cast</h1>
            <p style="color: var(--neon-cyan); margin: 1.5rem 0;">
              Vote recorded. Hand the phone back face-down.
            </p>
            <button class="btn btn--cyan" id="btn-next-voter">Next</button>
          </div>
        `;
        document.getElementById('btn-next-voter').addEventListener('click', () => {
          collectVote(playerIndex + 1);
        });
      });
    });
  }

  collectVote(0);
}

function resolveVote(container, gameState, votes, onLeave) {
  const alivePlayers = gameState.players.filter((p) => p.alive);

  // Tally votes
  const tally = {};
  for (const targetId of Object.values(votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  // Majority: > half of alive voters
  const majorityThreshold = Math.floor(alivePlayers.length / 2) + 1;
  let maxVotes = 0;
  let eliminatedId = null;
  let isTie = false;

  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count;
      eliminatedId = id;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  }

  let eliminatedPlayer = null;
  if (!isTie && maxVotes >= majorityThreshold && eliminatedId) {
    eliminatedPlayer = gameState.players.find((p) => p.id === eliminatedId);
    if (eliminatedPlayer) eliminatedPlayer.alive = false;
  }

  // Show result
  if (eliminatedPlayer) {
    container.innerHTML = `
      <div id="screen-pnp-day-result" class="screen active">
        <h1>Eliminated</h1>
        <p class="vote-result-name">${eliminatedPlayer.name}</p>
        <p class="vote-result-role">
          Role: <span style="color: ${eliminatedPlayer.role.color}">
            ${eliminatedPlayer.role.emoji} ${eliminatedPlayer.role.name}
          </span>
        </p>
        <button class="btn btn--pink" id="btn-after-elim" style="margin-top: 2rem;">Continue</button>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div id="screen-pnp-day-result" class="screen active">
        <h1>No Elimination</h1>
        <p class="vote-result-name">The vote was tied — no one is eliminated.</p>
        <button class="btn btn--cyan" id="btn-after-elim" style="margin-top: 2rem;">Continue</button>
      </div>
    `;
  }

  document.getElementById('btn-after-elim').addEventListener('click', () => {
    const winner = checkWin(gameState.players);
    if (winner) {
      showGameOver(container, gameState, winner, onLeave);
    } else {
      // Next round: Night phase
      startNightPhase(container, gameState, null, onLeave);
    }
  });
}

// ---------------------------------------------------------------------------
// Win condition check (pure, no Supabase)
// ---------------------------------------------------------------------------

function checkWin(players) {
  const alive = players.filter((p) => p.alive);
  const mafiaAlive = alive.filter((p) => p.role.id === 'mafia').length;
  const nonMafiaAlive = alive.length - mafiaAlive;

  if (mafiaAlive === 0) return 'guests';
  if (mafiaAlive >= nonMafiaAlive) return 'mafia';
  return null;
}

// ---------------------------------------------------------------------------
// Game Over
// ---------------------------------------------------------------------------

function showGameOver(container, gameState, winner, onLeave) {
  const winnerLabel = winner === 'mafia' ? 'Mafia Wins!' : 'Guests Win!';
  const winnerColor = winner === 'mafia' ? 'var(--neon-pink)' : 'var(--neon-yellow)';

  const roleListHTML = gameState.players.map((p) => `
    <li class="player-item" style="display: flex; justify-content: space-between; align-items: center;">
      <span>${p.name}${!p.alive ? ' <span class="day-player-status">eliminated</span>' : ''}</span>
      <span style="color: ${p.role.color}; font-size: 0.9rem;">
        ${p.role.emoji} ${p.role.name}
      </span>
    </li>
  `).join('');

  container.innerHTML = `
    <div id="screen-pnp-game-over" class="screen active">
      <h1 style="color: ${winnerColor};">${winnerLabel}</h1>
      <p style="color: var(--neon-cyan); margin-bottom: 1.5rem;">Final roles:</p>
      <ul class="player-list">${roleListHTML}</ul>
      <button class="btn btn--pink" id="btn-play-again" style="margin-top: 1rem;">Play Again</button>
      <button class="btn" id="btn-leave-pnp" style="background: var(--surface); color: var(--text);">
        Back to Title
      </button>
    </div>
  `;

  document.getElementById('btn-play-again').addEventListener('click', () => {
    startPassAndPlay(container, { onLeave });
  });

  document.getElementById('btn-leave-pnp').addEventListener('click', onLeave);
}
