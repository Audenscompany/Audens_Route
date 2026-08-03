/* ============================================================
   Audens Route — configuração compartilhada do frontend
   Firebase apontando para o projeto audens-route-501917 (nº 452139275816),
   que é o MESMO projeto do backend (Cloud Run) e onde ficam os dados e os
   usuários criados pelo app. Antes apontava para o projeto errado (406…),
   por isso só o master conseguia logar.
   ============================================================ */
window.AUDENS_CONFIG = {
  // URL do backend (Cloud Run) — Audens Route API.
  apiUrl: "https://audens-route-api-452139275816.southamerica-east1.run.app",

  // firebaseConfig do projeto audens-route-501917 (config de cliente — não é segredo).
  firebase: {
    apiKey: "AIzaSyDGmyAT5cBJK4TUPYbudIl1B_zzLwOwcIo",
    authDomain: "audens-route-501917.firebaseapp.com",
    projectId: "audens-route-501917",
    storageBucket: "audens-route-501917.firebasestorage.app",
    messagingSenderId: "452139275816",
    appId: "1:452139275816:web:5b1146c28e06507271071d"
  }
};

// helper: true quando o Firebase está configurado
window.AUDENS_HAS_FIREBASE = !!(window.AUDENS_CONFIG.firebase && window.AUDENS_CONFIG.firebase.apiKey);
