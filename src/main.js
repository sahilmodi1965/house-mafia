const app = document.getElementById('app');

// --- Screen definitions ---
const screens = {
  title: `
    <div id="screen-title" class="screen active">
      <h1>House Mafia</h1>
      <button class="btn btn--pink" id="btn-create">Create Room</button>
      <button class="btn btn--cyan" id="btn-join">Join Room</button>
    </div>
  `,
  create: `
    <div id="screen-create" class="screen">
      <h1>Create Room</h1>
      <p style="color: var(--neon-yellow);">Coming soon</p>
      <button class="btn btn--cyan" id="btn-back-create">Back</button>
    </div>
  `,
  join: `
    <div id="screen-join" class="screen">
      <h1>Join Room</h1>
      <p style="color: var(--neon-yellow);">Coming soon</p>
      <button class="btn btn--pink" id="btn-back-join">Back</button>
    </div>
  `,
};

// --- Router ---
function showScreen(name) {
  app.innerHTML = screens[name] || screens.title;
  const active = app.querySelector('.screen');
  if (active) active.classList.add('active');
  bindListeners(name);
}

function bindListeners(name) {
  if (name === 'title') {
    document.getElementById('btn-create')?.addEventListener('click', () => showScreen('create'));
    document.getElementById('btn-join')?.addEventListener('click', () => showScreen('join'));
  }
  if (name === 'create') {
    document.getElementById('btn-back-create')?.addEventListener('click', () => showScreen('title'));
  }
  if (name === 'join') {
    document.getElementById('btn-back-join')?.addEventListener('click', () => showScreen('title'));
  }
}

// --- Boot ---
showScreen('title');
