/* ============================================================
   Audens Route — casca compartilhada (sidebar + topbar + helpers)
   Cada página: define window.PAGE, inclui styles.css, config.js e este app.js,
   e coloca o conteúdo dentro de <template id="page">…</template>.
   ============================================================ */
(function(){
  const CFG = window.AUDENS_CONFIG || {};
  const API = CFG.apiUrl || '';
  const S=(p)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const IC={
    home:S('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-5h5v5"/>'),
    orders:S('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4v2h6V4"/><path d="M9 11h6M9 15h4"/>'),
    group:S('<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>'),
    route:S('<circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="5" r="2.4"/><path d="M8.4 19H14a4 4 0 0 0 0-8h-3a4 4 0 0 1 0-8h4.6"/>'),
    moto:S('<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20.5c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5"/>'),
    chart:S('<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="14"/>'),
    store:S('<path d="M4.5 9 6 4h12l1.5 5"/><path d="M4.5 9h15v1.5a3.2 3.2 0 0 1-6.4 0 3.2 3.2 0 0 1-6.4 0V9Z"/><path d="M6 13v7h12v-7"/>'),
    gear:S('<circle cx="12" cy="12" r="3"/><path d="M19.4 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L16.2 3H8l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L8 21h8l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5A7 7 0 0 0 19.4 12Z"/>'),
    support:S('<path d="M4 13a8 8 0 0 1 16 0"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/><path d="M20 19a3 3 0 0 1-3 3h-3"/>'),
    search:S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/>'),
    cal:S('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>'),
    clock:S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    bell:S('<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
    chev:S('<path d="m6 9 6 6 6-6"/>'), plus:S('<path d="M12 5v14M5 12h14"/>'),
    check:S('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.4 2.4 4.6-5"/>'),
    inbox:S('<path d="M3 13h5l1.5 2.5h5L21 13"/><path d="M5 13V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/>'),
    chef:S('<path d="M7 20h10"/><path d="M6.5 17h11v-2.5a4 4 0 0 0-1.2-8.4A4 4 0 0 0 9 4.6 4 4 0 0 0 6.5 14V17Z"/>'),
    package:S('<path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>'),
    truck:S('<rect x="3" y="7" width="11" height="9" rx="1"/><path d="M14 10h4l3 3v3h-3"/><circle cx="7.5" cy="18" r="1.7"/><circle cx="17.5" cy="18" r="1.7"/>'),
    thumb:S('<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Z"/><path d="M7 11l4-7a2 2 0 0 1 2 2v3h5.2a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17 20H7"/>'),
    logout:S('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 12H3m0 0 3-3m-3 3 3 3"/>'),
    build:S('<path d="M14 6l4 4-8 8H6v-4l8-8Z"/><path d="M13 7l4 4"/>'),
  };
  const LOGO={
    burger:`<svg viewBox="0 0 40 40" style="width:100%;height:100%"><rect width="40" height="40" rx="10" fill="#3a2a10"/><path d="M8 17c0-4.4 5.4-7.5 12-7.5S32 12.6 32 17H8Z" fill="#f5b544"/><rect x="8" y="19" width="24" height="3.4" rx="1.5" fill="#3aa35a"/><rect x="8" y="21.4" width="24" height="3.4" rx="1.5" fill="#d3452e"/><path d="M8 25c0 3.6 5.4 6 12 6s12-2.4 12-6v-1.2H8V25Z" fill="#d79b46"/></svg>`,
    pizza:`<svg viewBox="0 0 40 40" style="width:100%;height:100%"><rect width="40" height="40" rx="10" fill="#3a1414"/><path d="M20 7 33 31a28 28 0 0 1-26 0L20 7Z" fill="#f0b24c"/><path d="M20 12 30 29a22 22 0 0 1-20 0L20 12Z" fill="#e8632e"/><circle cx="17.5" cy="21" r="2.1" fill="#b02020"/><circle cx="23" cy="25" r="2.1" fill="#b02020"/></svg>`,
    store:`<svg viewBox="0 0 40 40" style="width:100%;height:100%"><rect width="40" height="40" rx="10" fill="#1c1730"/><path d="M11 18l1.5-6h15l1.5 6M11 18h18v1.6a3.5 3.5 0 0 1-7 0 3.5 3.5 0 0 1-7 0 3.5 3.5 0 0 1-4 0V18ZM13 22v7h14v-7" stroke="#c084fc" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>`,
  };
  const NAV=[['home','Dashboard','dashboard.html','dashboard'],['orders','Pedidos','pedidos.html','pedidos'],['group','Agrupamento','em-breve.html?s=Agrupamento','agrupamento'],['route','Rotas','em-breve.html?s=Rotas','rotas'],['moto','Motoboys','em-breve.html?s=Motoboys','motoboys'],['chart','Métricas','em-breve.html?s=Métricas','metricas'],['store','Lojas','cardapios.html','lojas'],['gear','Configurações','em-breve.html?s=Configura%C3%A7%C3%B5es','config']];

  function logoHtml(){
    // usa logo.png se existir; senão, o logo padrão em SVG+texto
    return `<img src="logo.png" alt="Audens Route" onerror="this.remove();var d=document.getElementById('logoDefault');if(d)d.style.display='flex'"/>
      <div id="logoDefault" style="display:none;flex-direction:column;align-items:center;gap:10px">
        <svg width="76" height="70" viewBox="0 0 88 80" fill="none"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><g><circle cx="44" cy="38" r="30" stroke="url(#lg)" stroke-width="3.5"/><path d="M22 50 L37 28 L46 41 L52 32 L64 50 Z" fill="url(#lg)"/><path d="M18 54 C31 45 57 45 70 54" stroke="#d8b4fe" stroke-width="3" fill="none" stroke-linecap="round"/></g></svg>
        <div class="txt">AUDENS<small>ROUTE</small></div>
      </div>`;
  }
  function nowStr(){
    const d=new Date();
    const dias=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const meses=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    return {date:`${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`, time:`${dias[d.getDay()]} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`};
  }

  function build(){
    const page = window.PAGE || '';
    const t = nowStr();
    const app=document.createElement('div'); app.className='app';
    app.innerHTML=`
      <aside class="sidebar">
        <div class="logo">${logoHtml()}</div>
        <nav class="nav">${NAV.map(n=>`<a class="${n[3]===page?'active':''}" href="${n[2]}">${IC[n[0]]}<span>${n[1]}</span></a>`).join('')}</nav>
        <div class="side-bottom">
          <div class="plan"><span class="pct">78%</span><div class="t">Plano Profissional</div><div class="v">Válido até 24/07/2025</div><div class="bar"><i></i></div><button>Gerenciar plano</button></div>
          <div class="support">${IC.support}<div><b style="font-size:12px;color:var(--text)">Suporte</b><br><span style="font-size:11px;color:var(--faint)">Central de ajuda</span></div></div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="search">${IC.search} Buscar pedidos, lojas, motoboys… <span class="kbd">⌘K</span></div>
          <div class="spacer"></div>
          <div class="conn" id="connState">Conectando…</div>
          <div class="chip">${IC.cal} ${t.date}</div>
          <div class="chip">${IC.clock} ${t.time}</div>
          <div class="bell">${IC.bell}</div>
          <div class="user" onclick="AudensShell.logout()"><div class="av" id="userAv">A<span class="on"></span></div><div><div class="nm" id="userNm">Audens</div><div class="rl" id="userRl">Operador</div></div>${IC.logout.replace('width="1.8"','')}</div>
        </header>
        <div class="content" id="content"></div>
        <div class="foot"><span>Audens Route · Sistema Inteligente de Logística e Entregas</span><span>© ${new Date().getFullYear()} Audens Route</span></div>
      </div>`;
    document.body.prepend(app);
    const tpl=document.getElementById('page');
    if(tpl) document.getElementById('content').appendChild(tpl.content.cloneNode(true));
    // usuário logado (sessão)
    try{const role=sessionStorage.getItem('audens_role'); if(role){document.getElementById('userRl').textContent={admin:'Administrador',operator:'Operador',kitchen:'Cozinha',driver:'Motoboy'}[role]||role;}}catch(e){}
  }

  function setConn(state){ // 'live' | 'err' | ''
    const el=document.getElementById('connState'); if(!el) return;
    el.className='conn '+(state||'');
    el.textContent = state==='live'?'Conectado':(state==='err'?'Sem conexão':'Conectando…');
  }

  // ---------- API (dados reais / webhooks) ----------
  async function j(url,opts){ const r=await fetch(url,opts); if(!r.ok){let e={};try{e=await r.json()}catch(_){}throw new Error((e.error&&e.error.message)||('HTTP '+r.status));} return r.status===204?null:r.json(); }
  const api={
    hasBackend: !!API,
    orders:()=>j(API+'/api/orders'),
    stores:()=>j(API+'/api/stores'),
    createStore:(b)=>j(API+'/api/stores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),
    patchStore:(id,b)=>j(API+'/api/stores/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),
    delStore:(id)=>j(API+'/api/stores/'+id,{method:'DELETE'}),
    setStatus:(id,st)=>j(`${API}/api/orders/${id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})}),
    webhookUrl:(s)=>`${API}/api/webhooks/orders/${s.id}?key=${s.webhookSecret}`,
  };

  // helpers de formatação/domínio
  const H={
    money:(v)=>'R$ '+(Number(v)||0).toFixed(2).replace('.',','),
    rel:(iso)=>{if(!iso)return '';const m=Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/60000));if(m<1)return 'agora';if(m<60)return m+' min';return Math.floor(m/60)+'h'+String(m%60).padStart(2,'0');},
    logoFor:(o,storeMap)=>{const s=storeMap&&storeMap[o.storeId];if(s&&s.logoUrl)return `<img src="${s.logoUrl}">`;const n=(o.storeName||'').toLowerCase();if(n.includes('burg'))return LOGO.burger;if(n.includes('pizz'))return LOGO.pizza;return LOGO.store;},
    storeBadge:(s)=>{if(s.logoUrl)return `<img src="${s.logoUrl}">`;const t=(s.type||'').toLowerCase();if(t.includes('hambur'))return LOGO.burger;if(t.includes('pizz'))return LOGO.pizza;return LOGO.store;},
  };
  const COLS=[
    {nm:'Recebido',color:'#60a5fa',st:['received','confirmed']},
    {nm:'Em preparo',color:'#fbbf24',st:['preparing']},
    {nm:'Pronto',color:'#34d399',st:['ready']},
    {nm:'Aguardando agrupamento',color:'#a855f7',st:['waiting_grouping','grouped']},
    {nm:'Em rota',color:'#22d3ee',st:['waiting_driver','sent_to_driver','accepted_by_driver','out_for_delivery','arrived_at_customer']},
    {nm:'Entregue',color:'#7a869a',st:['delivered']},
  ];
  const NEXT={received:['preparing','Iniciar preparo','#7c3aed'],confirmed:['preparing','Iniciar preparo','#7c3aed'],preparing:['ready','Marcar pronto','#34d399']};

  function toast(m){let t=document.getElementById('toast');if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t);}t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);}
  function logout(){ try{sessionStorage.removeItem('audens_role');}catch(e){} location.href='index.html'; }

  window.AudensShell={ IC, LOGO, NAV, api, H, COLS, NEXT, setConn, toast, logout, API };
  build();
})();
