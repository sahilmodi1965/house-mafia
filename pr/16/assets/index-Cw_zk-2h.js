(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))r(e);new MutationObserver(e=>{for(const t of e)if(t.type==="childList")for(const o of t.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&r(o)}).observe(document,{childList:!0,subtree:!0});function a(e){const t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?t.credentials="include":e.crossOrigin==="anonymous"?t.credentials="omit":t.credentials="same-origin",t}function r(e){if(e.ep)return;e.ep=!0;const t=a(e);fetch(e.href,t)}})();const l={ROOM_CODE_LENGTH:4};function d(c,n){c.innerHTML=`
    <div id="screen-create" class="screen active">
      <h1>Create Room</h1>
      <label class="input-label" for="create-name">Your Name</label>
      <input type="text" id="create-name" class="input" placeholder="Enter display name" maxlength="16" autocomplete="off" />
      <button class="btn btn--pink" id="btn-do-create">Create</button>
      <p id="create-error" class="error-text"></p>
      <button class="btn btn--cyan" id="btn-back-create">Back</button>
    </div>
  `,document.getElementById("btn-back-create").addEventListener("click",()=>{n()}),document.getElementById("btn-do-create").addEventListener("click",async()=>{const r=document.getElementById("create-name").value.trim(),e=document.getElementById("create-error");if(!r){e.textContent="Please enter a display name.";return}{e.textContent="Supabase not configured. Check .env variables.";return}})}function u(c,n){c.innerHTML=`
    <div id="screen-join" class="screen active">
      <h1>Join Room</h1>
      <label class="input-label" for="join-code">Room Code</label>
      <input type="text" id="join-code" class="input" placeholder="e.g. ABCD" maxlength="4" autocomplete="off" style="text-transform: uppercase;" />
      <label class="input-label" for="join-name">Your Name</label>
      <input type="text" id="join-name" class="input" placeholder="Enter display name" maxlength="16" autocomplete="off" />
      <button class="btn btn--cyan" id="btn-do-join">Join</button>
      <p id="join-error" class="error-text"></p>
      <button class="btn btn--pink" id="btn-back-join">Back</button>
    </div>
  `,document.getElementById("btn-back-join").addEventListener("click",()=>{n()}),document.getElementById("btn-do-join").addEventListener("click",async()=>{const a=document.getElementById("join-code"),r=document.getElementById("join-name"),e=a.value.trim().toUpperCase(),t=r.value.trim(),o=document.getElementById("join-error");if(!e||e.length!==l.ROOM_CODE_LENGTH){o.textContent=`Enter a ${l.ROOM_CODE_LENGTH}-letter room code.`;return}if(!t){o.textContent="Please enter a display name.";return}{o.textContent="Supabase not configured. Check .env variables.";return}})}const i=document.getElementById("app");function s(){i.innerHTML=`
    <div id="screen-title" class="screen active">
      <h1>House Mafia</h1>
      <button class="btn btn--pink" id="btn-create">Create Room</button>
      <button class="btn btn--cyan" id="btn-join">Join Room</button>
    </div>
  `,document.getElementById("btn-create").addEventListener("click",()=>{d(i,s)}),document.getElementById("btn-join").addEventListener("click",()=>{u(i,s)})}s();
