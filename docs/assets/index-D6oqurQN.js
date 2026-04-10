(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))i(e);new MutationObserver(e=>{for(const t of e)if(t.type==="childList")for(const s of t.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&i(s)}).observe(document,{childList:!0,subtree:!0});function r(e){const t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?t.credentials="include":e.crossOrigin==="anonymous"?t.credentials="omit":t.credentials="same-origin",t}function i(e){if(e.ep)return;e.ep=!0;const t=r(e);fetch(e.href,t)}})();const l=document.getElementById("app"),d={title:`
    <div id="screen-title" class="screen active">
      <h1>House Mafia</h1>
      <button class="btn btn--pink" id="btn-create">Create Room</button>
      <button class="btn btn--cyan" id="btn-join">Join Room</button>
    </div>
  `,create:`
    <div id="screen-create" class="screen">
      <h1>Create Room</h1>
      <p style="color: var(--neon-yellow);">Coming soon</p>
      <button class="btn btn--cyan" id="btn-back-create">Back</button>
    </div>
  `,join:`
    <div id="screen-join" class="screen">
      <h1>Join Room</h1>
      <p style="color: var(--neon-yellow);">Coming soon</p>
      <button class="btn btn--pink" id="btn-back-join">Back</button>
    </div>
  `};function c(o){l.innerHTML=d[o]||d.title;const n=l.querySelector(".screen");n&&n.classList.add("active"),a(o)}function a(o){var n,r,i,e;o==="title"&&((n=document.getElementById("btn-create"))==null||n.addEventListener("click",()=>c("create")),(r=document.getElementById("btn-join"))==null||r.addEventListener("click",()=>c("join"))),o==="create"&&((i=document.getElementById("btn-back-create"))==null||i.addEventListener("click",()=>c("title"))),o==="join"&&((e=document.getElementById("btn-back-join"))==null||e.addEventListener("click",()=>c("title")))}c("title");
