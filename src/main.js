import { createClient } from '@supabase/supabase-js';
import { setSupabase, showCreateScreen, showJoinScreen } from './room.js';
import { DEV_MODE } from './dev.js';
import { startPassAndPlay } from './pass-and-play.js';
import { showToast } from './ui/toast.js';
// #53: role-reveal animation tunables. Import via JS so Vite bundles
// the CSS into docs/assets — no index.html edit needed.
import './styles/role-reveal-tunables.css';

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
// #48: auto-advance to the Join screen when the URL carries a
// ?room=XXXX param (from a shared link / QR code scan). The join
// input is pre-filled but the user still enters their display name.
//
// #109: if the user was just kicked from a room, sessionStorage has
// the 'hm:just-kicked' flag set. In that case we must NOT auto-advance
// to the Join screen (even if the URL still carries ?room=), because
// that would drop the kicked player right back onto the room they
// were removed from. Read-and-clear the flag once, then stay on title.
let justKicked = false;
try {
  if (typeof sessionStorage !== 'undefined') {
    justKicked = sessionStorage.getItem('hm:just-kicked') === '1';
    if (justKicked) sessionStorage.removeItem('hm:just-kicked');
  }
} catch (_) {
  justKicked = false;
}

const urlRoom = new URLSearchParams(window.location.search).get('room');
if (!justKicked && urlRoom && /^[A-Z0-9]{3,6}$/i.test(urlRoom)) {
  showTitle();
  // Open join screen after the title paints, then pre-fill the code.
  showJoinScreen(app, showTitle);
  const codeInput = document.getElementById('join-code');
  if (codeInput) {
    codeInput.value = urlRoom.toUpperCase();
  }
} else {
  showTitle();
  if (justKicked) {
    // Explain why they're back on the title screen instead of whatever
    // ?room= was in the URL.
    try {
      showToast('You were removed from the last room', { type: 'warn', duration: 3500 });
    } catch (_) {}
  }
}
