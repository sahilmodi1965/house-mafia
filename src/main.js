import { createClient } from '@supabase/supabase-js';
import { setSupabase, showCreateScreen, showJoinScreen } from './room.js';
import { DEV_MODE } from './dev.js';
import { startPassAndPlay } from './pass-and-play.js';

// --- Supabase singleton ---
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
  setSupabase(supabase);
}

// --- App root ---
const app = document.getElementById('app');

// --- Dev mode banner ---
if (DEV_MODE) {
  const banner = document.createElement('div');
  banner.id = 'dev-banner';
  banner.textContent = 'DEV MODE (?dev=1)';
  document.body.insertBefore(banner, document.body.firstChild);
}

// --- Title screen ---
function showTitle() {
  app.innerHTML = `
    <div id="screen-title" class="screen active">
      <h1>House Mafia</h1>
      <button class="btn btn--pink" id="btn-create">Create Room</button>
      <button class="btn btn--cyan" id="btn-join">Join Room</button>
      <button class="btn btn--yellow" id="btn-pass-play">Pass &amp; Play</button>
    </div>
  `;
  document.getElementById('btn-create').addEventListener('click', () => {
    showCreateScreen(app, showTitle);
  });
  document.getElementById('btn-join').addEventListener('click', () => {
    showJoinScreen(app, showTitle);
  });
  document.getElementById('btn-pass-play').addEventListener('click', () => {
    startPassAndPlay(app, { onLeave: showTitle });
  });
}

// --- Boot ---
showTitle();
