import { createClient } from '@supabase/supabase-js';
import { setSupabase, showCreateScreen, showJoinScreen } from './room.js';

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

// --- Title screen ---
function showTitle() {
  app.innerHTML = `
    <div id="screen-title" class="screen active">
      <h1>House Mafia</h1>
      <button class="btn btn--pink" id="btn-create">Create Room</button>
      <button class="btn btn--cyan" id="btn-join">Join Room</button>
    </div>
  `;
  document.getElementById('btn-create').addEventListener('click', () => {
    showCreateScreen(app, showTitle);
  });
  document.getElementById('btn-join').addEventListener('click', () => {
    showJoinScreen(app, showTitle);
  });
}

// --- Boot ---
showTitle();
