/* ============================================================
   Audens Route — configuração compartilhada do frontend
   Preenchido com o projeto Firebase "audens-route".
   Enquanto apiUrl estiver vazio, o painel usa o Firebase em tempo real
   e as ações que exigem regra de negócio (mudar status) ficam locais.
   ============================================================ */
window.AUDENS_CONFIG = {
  // URL do backend (Cloud Run) — Audens Route API.
  apiUrl: "https://audens-route-api-452139275816.southamerica-east1.run.app",

  // firebaseConfig do projeto audens-route (config de cliente — não é segredo).
  firebase: {
    apiKey: "AIzaSyALkNr5ufB8DQ54DJFHAX7-obcg8N7SM8o",
    authDomain: "audens-route.firebaseapp.com",
    projectId: "audens-route",
    storageBucket: "audens-route.firebasestorage.app",
    messagingSenderId: "406257478885",
    appId: "1:406257478885:web:b2eb532fd23f575e34780c",
    measurementId: "G-9JL27K3LTE"
  }
};

// helper: true quando o Firebase está configurado
window.AUDENS_HAS_FIREBASE = !!(window.AUDENS_CONFIG.firebase && window.AUDENS_CONFIG.firebase.apiKey);
