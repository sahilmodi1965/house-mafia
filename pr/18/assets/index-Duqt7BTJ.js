(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))r(e);new MutationObserver(e=>{for(const o of e)if(o.type==="childList")for(const a of o.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&r(a)}).observe(document,{childList:!0,subtree:!0});function c(e){const o={};return e.integrity&&(o.integrity=e.integrity),e.referrerPolicy&&(o.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?o.credentials="include":e.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function r(e){if(e.ep)return;e.ep=!0;const o=c(e);fetch(e.href,o)}})();const u={ROOM_CODE_LENGTH:4};let s=!1,i=null;function p(){if(i)return i;try{return i=new(window.AudioContext||window.webkitAudioContext),i}catch{return null}}const b={vote:"assets/sounds/vote.mp3",eliminate:"assets/sounds/eliminate.mp3",reveal:"assets/sounds/reveal.mp3",tick:"assets/sounds/tick.mp3",win:"assets/sounds/win.mp3",night:"assets/sounds/night.mp3"},m={};async function y(t){const n=b[t];if(!n||m[t])return;const c=p();if(c)try{const r=await fetch(n);if(!r.ok){console.log(`[audio] stub: ${t} not found at ${n}`);return}const e=await r.arrayBuffer();m[t]=await c.decodeAudioData(e)}catch{console.log(`[audio] stub: could not load ${t}`)}}function f(){Object.keys(b).forEach(t=>y(t))}function g(){return s=!s,s}function E(){const t=document.createElement("button");return t.className="mute-btn",t.setAttribute("aria-label","Toggle sound"),t.textContent=s?"🔇":"🔊",t.addEventListener("click",()=>{p(),f();const n=g();t.textContent=n?"🔇":"🔊"}),t}function h(t,n){t.innerHTML=`
    <div id="screen-create" class="screen active">
      <h1>Create Room</h1>
      <label class="input-label" for="create-name">Your Name</label>
      <input type="text" id="create-name" class="input" placeholder="Enter display name" maxlength="16" autocomplete="off" />
      <button class="btn btn--pink" id="btn-do-create">Create</button>
      <p id="create-error" class="error-text"></p>
      <button class="btn btn--cyan" id="btn-back-create">Back</button>
    </div>
  `,document.getElementById("btn-back-create").addEventListener("click",()=>{n()}),document.getElementById("btn-do-create").addEventListener("click",async()=>{const r=document.getElementById("create-name").value.trim(),e=document.getElementById("create-error");if(!r){e.textContent="Please enter a display name.";return}{e.textContent="Supabase not configured. Check .env variables.";return}})}function v(t,n){t.innerHTML=`
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
  `,document.getElementById("btn-back-join").addEventListener("click",()=>{n()}),document.getElementById("btn-do-join").addEventListener("click",async()=>{const c=document.getElementById("join-code"),r=document.getElementById("join-name"),e=c.value.trim().toUpperCase(),o=r.value.trim(),a=document.getElementById("join-error");if(!e||e.length!==u.ROOM_CODE_LENGTH){a.textContent=`Enter a ${u.ROOM_CODE_LENGTH}-letter room code.`;return}if(!o){a.textContent="Please enter a display name.";return}{a.textContent="Supabase not configured. Check .env variables.";return}})}const l=document.getElementById("app");function d(){l.innerHTML=`
    <div id="screen-title" class="screen active">
      <h1>House Mafia</h1>
      <button class="btn btn--pink" id="btn-create">Create Room</button>
      <button class="btn btn--cyan" id="btn-join">Join Room</button>
    </div>
  `,document.getElementById("btn-create").addEventListener("click",()=>{h(l,d)}),document.getElementById("btn-join").addEventListener("click",()=>{v(l,d)})}document.body.appendChild(E());document.addEventListener("click",()=>f(),{once:!0});d();
