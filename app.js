/* ============================================================
   Audens Route — Backend (Cloud Run · função única)
   Ponto de entrada da função:  api  (também responde como helloHttp)
   ------------------------------------------------------------
   Webhook agora entende o formato REAL do Cardápio Web (Uoou):
     number, total(centavos), customer{first_name,last_name,cellphone},
     shipping_address{street,number,neighborhood,city,...}, items[].variant.name, state
   E captura TODO webhook recebido em /api/webhook-events p/ diagnóstico.
   ============================================================ */
import { http } from '@google-cloud/functions-framework';
import express from 'express';
import admin from 'firebase-admin';
import crypto from 'node:crypto';

// ---------- Firebase Admin (Firestore + Auth) ----------
// IMPORTANTE: deixar o initializeApp() detectar o projeto sozinho (forçar projectId
// quebra o acesso ao Firestore no Cloud Run).
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const nowIso = () => new Date().toISOString();
const randHex = (n) => crypto.randomBytes(n).toString('hex');
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'cardapio';
}

const SKIP_WEBHOOK_SIGNATURE = (process.env.SKIP_WEBHOOK_SIGNATURE ?? 'true') === 'true';
const DEFAULT_WEBHOOK_SECRET = process.env.WEBHOOK_DEFAULT_SECRET ?? 'dev-secret';

// ---------- Status e regras ----------
const OrderStatus = {
  RECEIVED:'received', CONFIRMED:'confirmed', PREPARING:'preparing', READY:'ready',
  WAITING_GROUPING:'waiting_grouping', GROUPED:'grouped', WAITING_DRIVER:'waiting_driver',
  SENT_TO_DRIVER:'sent_to_driver', ACCEPTED_BY_DRIVER:'accepted_by_driver',
  OUT_FOR_DELIVERY:'out_for_delivery', ARRIVED_AT_CUSTOMER:'arrived_at_customer',
  DELIVERED:'delivered', CANCELED:'canceled', ORDER_ERROR:'order_error',
};
const ALL_STATUSES = Object.values(OrderStatus);
const TRANSITIONS = {
  received: ['confirmed','preparing','canceled','order_error'],
  confirmed: ['preparing','canceled'],
  preparing: ['ready','canceled'],
  ready: ['waiting_grouping','canceled'],
  waiting_grouping: ['grouped','ready','canceled'],
  grouped: ['waiting_driver','waiting_grouping'],
  waiting_driver: ['sent_to_driver'],
  sent_to_driver: ['accepted_by_driver','waiting_driver'],
  accepted_by_driver: ['out_for_delivery'],
  out_for_delivery: ['arrived_at_customer','delivered'],
  arrived_at_customer: ['delivered'],
  delivered: [], canceled: [], order_error: ['received'],
};
const canTransition = (from, to) => from === to || (TRANSITIONS[from] || []).includes(to);

const DEFAULT_SETTINGS = {
  id:'logistics_settings', minOrdersPerRoute:2, maxOrdersPerRoute:3, maxOrdersPerRouteForced:4, groupingWindowMinutes:3,
  storeGeofenceRadiusMeters:150, maxDistanceBetweenGroupedOrdersKm:2.0, maxExtraTimeForGroupingMinutes:8,
  maxBearingDiffDeg:50, maxRouteDetourRatio:1.5, // agrupamento por corredor/direção
  maxReadyWaitingTimeMinutes:10, allowSingleOrderException:true, allowSkipDriverQueue:true,
  allowManualDriverChange:true, defaultMaxDeliveryTimeMinutes:60,
  geofenceArrivalToleranceSeconds:30, geofenceDepartureToleranceSeconds:60,
  deliveryFeePerOrder:5.0, autoDispatch:false, autoGroup:false,
  returnToReadyEnabled:true, returnToReadyMinutes:10, // pedido parado no agrupamento volta p/ Pronto e segue tentando rota
};

// ---------- Seed (apenas settings; cardápios são cadastrados na tela) ----------
let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  const sref = db.collection('settings').doc('logistics_settings');
  if (!(await sref.get()).exists) await sref.set(DEFAULT_SETTINGS);
  seeded = true;
}
async function getSettings() {
  const snap = await db.collection('settings').doc('logistics_settings').get();
  return snap.exists ? { ...DEFAULT_SETTINGS, ...snap.data() } : DEFAULT_SETTINGS;
}
async function getStore(storeId) {
  const snap = await db.collection('stores').doc(storeId).get();
  return snap.exists ? snap.data() : null;
}
async function log(type, actor, entityId, payload = {}) {
  try { await db.collection('logs').add({ type, actor, entityId, payload, createdAt: nowIso() }); } catch (_) {}
}

// ---------- Diagnóstico: guarda TODO webhook recebido ----------
async function captureRaw({ source, storeId, matched, note, req, orderId }) {
  try {
    await db.collection('webhook_events').add({
      receivedAt: nowIso(),
      source: source || '', storeId: storeId || null,
      matched: !!matched, note: note || '', orderId: orderId || null,
      query: (req && req.query) || {},
      contentType: (req && req.get && req.get('content-type')) || '',
      userAgent: (req && req.get && req.get('user-agent')) || '',
      path: (req && (req.originalUrl || req.url)) || '',
      body: (req && req.body) ?? null,
    });
  } catch (_) {}
}

// ---------- Mapeamento do payload do Cardápio Web (Uoou) -> nosso modelo ----------
const centsToBRL = (v) => (v == null || v === '' ? undefined : Number(v) / 100);
// Traduz o status do Cardápio Web (enum oficial) para o nosso pipeline.
const CW_STATUS_MAP = {
  waiting_confirmation: OrderStatus.RECEIVED,
  pending_payment: OrderStatus.RECEIVED,
  pending_online_payment: OrderStatus.RECEIVED,
  scheduled_confirmed: OrderStatus.CONFIRMED,
  confirmed: OrderStatus.PREPARING,          // "confirmado e em preparação"
  ready: OrderStatus.WAITING_GROUPING,       // pronto -> entra no agrupamento
  waiting_to_catch: OrderStatus.WAITING_GROUPING,
  released: OrderStatus.OUT_FOR_DELIVERY,    // saiu para entrega
  delivered: OrderStatus.DELIVERED,
  closed: OrderStatus.DELIVERED,
  canceling: OrderStatus.CANCELED,
  canceled: OrderStatus.CANCELED,
};
function mapExternalState(s) {
  s = String(s || '').toLowerCase().trim();
  if (CW_STATUS_MAP[s]) return CW_STATUS_MAP[s];
  if (s.includes('cancel')) return OrderStatus.CANCELED;
  if (s.includes('deliver') || s.includes('entreg')) return OrderStatus.DELIVERED;
  if (s.includes('conclu') || s.includes('finaliz')) return OrderStatus.DELIVERED;
  return null;
}
// Enquanto o pedido está na "fase de cozinha", o Cardápio Web dirige o status.
// Depois que o operador agrupa (grouped+), só sinais terminais (entregue/cancelado) valem —
// assim uma mudança no Cardápio Web nunca desfaz o que o operador já fez aqui.
const KITCHEN_PHASE = new Set([
  OrderStatus.RECEIVED, OrderStatus.CONFIRMED, OrderStatus.PREPARING,
  OrderStatus.READY, OrderStatus.WAITING_GROUPING,
]);
function resolveStatusFromCardapio(current, incoming) {
  if (!incoming || incoming === current) return null;
  if (incoming === OrderStatus.CANCELED || incoming === OrderStatus.DELIVERED) return incoming;
  if (KITCHEN_PHASE.has(current)) return incoming;
  return null;
}
// Detecta o formato Cardápio Web/Uoou e traduz para os campos que o normalize espera.
function mapIncoming(b) {
  if (!b || typeof b !== 'object') return {};

  // Formato de NOTIFICAÇÃO do Cardápio Web (delivery): avisa que um pedido mudou,
  // mas NÃO traz cliente/itens/endereço. Ex.: {event_type, merchant_id, order_id, order_status}
  if (b.order_id != null && (b.event_type || b.order_status || b.merchant_id != null)) {
    return {
      externalOrderId: String(b.order_id),
      externalState: b.order_status || '',
      merchantId: b.merchant_id != null ? String(b.merchant_id) : undefined,
      eventType: b.event_type || '',
      createdAt: b.created_at || undefined,
      notificationOnly: true, // detalhes (cliente/endereço/valor) só via API do Cardápio Web
    };
  }

  const looksUoou = !!(b.shipping_address || b.billing_address ||
    (b.customer && (b.customer.first_name || b.customer.last_name || b.customer.cellphone)) ||
    (Array.isArray(b.items) && b.items[0] && b.items[0].variant));
  if (!looksUoou) return b; // já está no nosso padrão (testes manuais)

  const c = b.customer || {};
  const a = b.shipping_address || b.billing_address || {};
  const items = (Array.isArray(b.items) ? b.items : []).map((it) => {
    const v = it.variant || {};
    const qty = it.quantity != null ? Number(it.quantity) : 1;
    return {
      name: v.name || v.product_name || it.name || 'Item',
      quantity: qty,
      price: centsToBRL(it.unit_price),
      total: centsToBRL(it.total != null ? it.total : (it.unit_price != null ? it.unit_price * qty : null)),
    };
  });
  const pay = Array.isArray(b.payments) && b.payments[0] ? b.payments[0] : {};
  return {
    externalOrderId: b.number != null ? String(b.number) : (b.id != null ? String(b.id) : undefined),
    customerName: [c.first_name, c.last_name].filter(Boolean).join(' ').trim(),
    customerPhone: c.cellphone || c.telephone || '',
    address: {
      street: a.street || '', number: a.number || '', complement: a.complement || '',
      neighborhood: a.neighborhood || '', city: a.city || '',
      state: a.province_iso || a.province_name || '', zipCode: a.postcode || '',
      lat: a.lat ?? null, lng: a.lng ?? null,
    },
    items,
    total: centsToBRL(b.total),
    paymentMethod: pay.method_type || pay.gateway || b.payment_method || '',
    createdAt: b.created_at || undefined,
    externalState: b.state || b.shipping_state || b.payment_state || '',
  };
}

// ---------- Normalização (input padronizado -> documento do pedido) ----------
function idempotencyKey(source, storeId, externalOrderId) {
  return `${source}:${storeId}:${externalOrderId}`;
}
function normalize(input, store) {
  const now = nowIso();
  const st0 = mapExternalState(input.externalState) || OrderStatus.RECEIVED;
  const key = idempotencyKey(input.source, input.storeId, String(input.externalOrderId));
  const a = input.address || {};
  return {
    id: key.replace(/[^a-zA-Z0-9_-]/g, '_'),
    externalOrderId: String(input.externalOrderId), source: input.source, storeId: input.storeId,
    storeName: store?.name ?? input.storeId, storeGroupId: store?.storeGroupId ?? 'audens_store_group',
    idempotencyKey: key,
    customer: { name: input.customerName ?? '', phone: input.customerPhone ?? '' },
    address: {
      street: a.street ?? '', number: a.number ?? '', complement: a.complement ?? '',
      neighborhood: a.neighborhood ?? '', city: a.city ?? '', state: a.state ?? '',
      zipCode: a.zipCode ?? '', lat: a.lat ?? null, lng: a.lng ?? null,
      geocoded: a.lat != null && a.lng != null,
    },
    items: Array.isArray(input.items) ? input.items : [],
    total: Number(input.total) || 0, paymentMethod: input.paymentMethod ?? '',
    status: st0,
    createdAt: input.createdAt ?? now,
    confirmedAt: st0 === OrderStatus.CONFIRMED ? now : null,
    preparingAt: st0 === OrderStatus.PREPARING ? now : null,
    readyAt: (st0 === OrderStatus.READY || st0 === OrderStatus.WAITING_GROUPING) ? now : null,
    groupingStartedAt: st0 === OrderStatus.WAITING_GROUPING ? now : null,
    assignedRouteId:null, assignedDriverId:null,
    estimatedPrepTimeMinutes: store?.defaultPrepTimeMinutes ?? 25,
    maxDeliveryTimeMinutes: store?.maxDeliveryTimeMinutes ?? 60, distanceFromStoreKm:null,
    riskLevel:'normal', priorityScore:0, isException:false, notes:'',
    merchantId: input.merchantId ?? null, lastEventType: input.eventType ?? null,
    needsEnrichment: !!input.notificationOnly, // true = falta buscar detalhes na API do Cardápio Web
    receivedAtSystem: now, updatedAt: now,
  };
}

// grava o pedido (idempotente). Retorna { orderId, duplicated }.
async function ingestOrder(input, store) {
  const order = normalize(input, store);
  const ref = db.collection('orders').doc(order.id);
  const existing = await ref.get();
  if (existing.exists) {
    const cur = existing.data();
    const now = nowIso();
    // Aviso de status (notification) NÃO sobrescreve cliente/itens/endereço/valor
    // que já tenham sido buscados — só atualiza o status e metadados.
    const patch = input.notificationOnly
      ? {}
      : { customer: order.customer, address: order.address, items: order.items,
          total: order.total, paymentMethod: order.paymentMethod };
    if (input.merchantId) patch.merchantId = input.merchantId;
    if (input.eventType) patch.lastEventType = input.eventType;
    // Trava de propriedade: Cardápio Web só dirige o status na fase de cozinha.
    const st = resolveStatusFromCardapio(cur.status, mapExternalState(input.externalState));
    if (st) {
      patch.status = st;
      if (st === OrderStatus.PREPARING && !cur.preparingAt) patch.preparingAt = now;
      if (st === OrderStatus.WAITING_GROUPING && !cur.groupingStartedAt) { patch.groupingStartedAt = now; patch.readyAt = cur.readyAt || now; }
    }
    patch.updatedAt = now;
    await ref.set(patch, { merge: true });
    await log('webhook_duplicated', `webhook:${input.source}`, order.id, { idempotencyKey: order.idempotencyKey, event: input.eventType || '' });
    return { orderId: order.id, duplicated: true };
  }
  await ref.set(order);
  await log('webhook_received', `webhook:${input.source}`, order.id, { storeId: order.storeId });
  return { orderId: order.id, duplicated: false };
}

// ---------- Enriquecimento: busca o pedido completo na API do Cardápio Web ----------
// GET https://integracao.cardapioweb.com/api/partner/v1/orders/{order_id}
// Header: X-API-KEY: <token da loja>  (o token já identifica o estabelecimento)
const CW_API_BASE = process.env.CW_API_BASE || 'https://integracao.cardapioweb.com';

async function fetchCardapioWebOrder(store, orderId) {
  const token = store && store.apiToken;
  if (!token) return { ok:false, reason:'sem_token' };
  if (typeof fetch !== 'function') return { ok:false, reason:'sem_fetch' };
  const url = `${CW_API_BASE}/api/partner/v1/orders/${encodeURIComponent(orderId)}`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, {
      method:'GET', signal: ctrl.signal,
      headers: { 'X-API-KEY': token, 'Content-Type':'application/json', 'Accept':'application/json' },
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok:false, reason:`http_${resp.status}` };
    const data = await resp.json();
    return { ok:true, data };
  } catch (e) { clearTimeout(timer); return { ok:false, reason:String(e && e.message || e) }; }
}

// Monta um texto de endereço legível. Trata marketplace (99Food/iFood), que
// joga o endereço inteiro no campo "street" e deixa bairro/cidade como lixo.
function composeAddress(a) {
  const street = (a.street || '').trim(), number = (a.number || '').trim();
  const numIsReal = /^\d/.test(number);
  const nb = (a.neighborhood || '').trim(), city = (a.city || '').trim();
  const comp = (a.complement || '').trim(), ref = (a.reference || '').trim();
  let base;
  if (!nb && /,/.test(street)) {
    // "street" já é o endereço completo (formato marketplace)
    base = street + (number && !numIsReal ? (' - ' + number) : '');
  } else {
    const p = [[street, numIsReal ? number : ''].filter(Boolean).join(', ')];
    if (number && !numIsReal) p.push(number);
    if (nb) p.push(nb);
    if (city) p.push(city);
    base = p.filter(Boolean).join(', ');
  }
  const extra = [comp, ref ? ('Ref: ' + ref) : ''].filter(Boolean).join(' · ');
  return [base, extra].filter(Boolean).join(' · ');
}
function mapCardapioWebDetails(o) {
  const c = o.customer || {};
  const a = o.delivery_address || o.address || {};
  const items = (Array.isArray(o.items) ? o.items : []).map((it) => ({
    name: it.name || 'Item',
    quantity: it.quantity != null ? Number(it.quantity) : 1,
    price: Number(it.unit_price) || 0,
    total: Number(it.total_price != null ? it.total_price : (it.unit_price != null && it.quantity != null ? it.unit_price * it.quantity : 0)) || 0,
    notes: it.observation || it.note || it.comment || '',
    options: (Array.isArray(it.options) ? it.options : []).map((op) => ({
      name: op.name || '',
      quantity: op.quantity != null ? Number(op.quantity) : 1,
      price: Number(op.unit_price) || 0,
      group: op.option_group_name || op.group_name || '',
    })),
  }));
  const pay = Array.isArray(o.payments) && o.payments[0] ? o.payments[0] : {};
  const changeFor = Number(pay.change_for || pay.change || o.change_for) || 0;
  const clean = (v) => { v = (v == null ? '' : String(v)).trim(); return /^n[aã]o\s*informad/i.test(v) ? '' : v; };
  const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const addr = {
    street: clean(a.street), number: clean(a.number), complement: clean(a.complement),
    neighborhood: clean(a.neighborhood), city: clean(a.city),
    state: clean(a.state || a.province_iso || a.province_name),
    reference: clean(a.reference), block: clean(a.address_block), lot: clean(a.address_lot),
    zipCode: clean(a.postal_code || a.zip_code || a.postcode || a.zipCode),
    lat: numOrNull(a.latitude != null ? a.latitude : a.lat),
    lng: numOrNull(a.longitude != null ? a.longitude : a.lng),
  };
  addr.text = composeAddress(addr);
  return {
    displayId: o.display_id != null ? String(o.display_id) : undefined,
    customerName: c.name || '', customerPhone: c.phone || c.cellphone || '',
    address: addr,
    items, total: Number(o.total) || 0,
    subtotal: Number(o.subtotal) || items.reduce((s, it) => s + (Number(it.total) || 0), 0),
    deliveryFee: Number(o.delivery_fee) || 0,
    additionalFee: Number(o.additional_fee || o.service_fee || o.extra_fee) || 0,
    paymentMethod: pay.payment_method || pay.method || '',
    paymentType: pay.payment_type || '', paymentStatus: pay.status || '',
    changeFor,
    observation: o.observation || o.notes || o.comment || o.obs || '',
    salesChannel: o.sales_channel || o.channel || o.origin || '',
    marketplaceId: (o.external_display_id != null ? String(o.external_display_id) : '') || (o.external_order_id != null ? String(o.external_order_id) : ''),
    orderType: o.order_type || '', externalState: o.status || '',
  };
}

// Busca os detalhes e grava no pedido já existente (merge). Retorna {ok, reason?}.
async function enrichOrder(store, externalOrderId) {
  const r = await fetchCardapioWebOrder(store, externalOrderId);
  if (!r.ok) { await log('enrich_failed', 'system', String(externalOrderId), { reason: r.reason, storeId: store && store.id }); return r; }
  const d = mapCardapioWebDetails(r.data);
  const key = idempotencyKey('cardapio_web', store.id, String(externalOrderId));
  const id = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Enriquecimento cuida dos detalhes; o status fica por conta do webhook (com a trava).
  let addr = { ...d.address, geocoded: d.address.lat != null && d.address.lng != null };
  if (!addr.geocoded && (addr.street || addr.neighborhood)) {
    const key = await mapsKey();
    if (key) {
      const g = await geocode(addr, key);
      if (g.ok) { addr = { ...addr, lat: g.lat, lng: g.lng, geocoded: true, geoFormatted: g.formatted || '' }; }
      else { await log('geocode_failed', 'system', String(externalOrderId), { reason: g.reason, message: g.message || '' }); }
    }
  }
  const patch = {
    customer: { name: d.customerName, phone: d.customerPhone },
    address: addr,
    items: d.items, total: d.total, subtotal: d.subtotal, paymentMethod: d.paymentMethod,
    paymentType: d.paymentType || null, paymentStatus: d.paymentStatus || null,
    deliveryFee: d.deliveryFee, additionalFee: d.additionalFee || 0, changeFor: d.changeFor || 0,
    observation: d.observation || '', salesChannel: d.salesChannel || '', marketplaceId: d.marketplaceId || '',
    displayId: d.displayId ?? null, orderType: d.orderType || null,
    needsEnrichment: false, enrichedAt: nowIso(), updatedAt: nowIso(),
  };
  await db.collection('orders').doc(id).set(patch, { merge: true });
  await log('enriched', 'system', id, { externalOrderId: String(externalOrderId) });
  return { ok:true };
}

// ---------- Geo (Google Maps Geocoding + distância) ----------
async function mapsKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  try { const s = await getSettings(); return s.googleMapsApiKey || ''; } catch (_) { return ''; }
}
function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null || a.lng == null || b.lng == null) return Infinity;
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// rumo (bearing) inicial de a -> b, em graus (0=Norte, 90=Leste). Usado p/ agrupar por "corredor".
function bearingDeg(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// menor diferença angular entre dois rumos (0..180)
function angDiff(a, b) { if (a == null || b == null) return 0; let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
// distância do trajeto (vizinho mais próximo) partindo de origin passando por todos os pontos
function nnRouteKm(origin, addrs) {
  const rem = addrs.slice(); let cur = origin, total = 0;
  while (rem.length) { let bi = 0, bd = Infinity; rem.forEach((p, i) => { const d = haversineKm(cur, p); if (d < bd) { bd = d; bi = i; } }); total += bd; cur = rem[bi]; rem.splice(bi, 1); }
  return total;
}
function addrString(a) {
  return [[a.street, a.number].filter(Boolean).join(', '), a.neighborhood, a.city, a.state, 'Brasil']
    .filter(Boolean).join(', ');
}
// distância total do trajeto entre as paradas (soma dos trechos consecutivos)
function routeDistanceKm(orders) {
  let total = 0, any = false;
  for (let i = 0; i < orders.length - 1; i++) {
    const d = haversineKm(orders[i].address, orders[i + 1].address);
    if (d !== Infinity) { total += d; any = true; }
  }
  return any ? Math.round(total * 10) / 10 : null;
}
// avisa o Cardápio Web da mudança de status (action = 'ready' | 'delivered')
async function pushCwStatus(order, action) {
  try {
    if (!order || !order.storeId || !order.externalOrderId) { await log('cw_push_skip', 'system', order && order.id, { action, reason: 'sem storeId ou número do pedido', storeId: order && order.storeId, ext: order && order.externalOrderId, store: order && order.storeName }); return; }
    if (typeof fetch !== 'function') { await log('cw_push_skip', 'system', order.id, { action, reason: 'fetch indisponível' }); return; }
    const store = await getStore(order.storeId);
    if (!store) { await log('cw_push_skip', 'system', order.id, { action, reason: 'loja não encontrada', storeId: order.storeId, store: order.storeName }); return; }
    if (!store.apiToken) { await log('cw_push_skip', 'system', order.id, { action, reason: 'loja sem token de API', storeId: order.storeId, store: order.storeName }); return; }
    const url = `${CW_API_BASE}/api/partner/v1/orders/${encodeURIComponent(order.externalOrderId)}/${action}`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'X-API-KEY': store.apiToken } });
    clearTimeout(t);
    let bodyTxt = ''; try { bodyTxt = (await resp.text() || '').slice(0, 300); } catch (_) {}
    await log('cw_push', 'system', order.id, { action, httpStatus: resp.status, ok: resp.ok, ext: order.externalOrderId, store: order.storeName, body: bodyTxt });
  } catch (e) { await log('cw_push_error', 'system', order && order.id, { action, err: String(e && e.message || e), store: order && order.storeName }); }
}
async function geocode(a, key) {
  if (!key) return { ok: false, reason: 'sem_chave' };
  if (typeof fetch !== 'function') return { ok: false, reason: 'sem_fetch' };
  const q = addrString(a || {});
  if (!q || q === 'Brasil') return { ok: false, reason: 'sem_endereco' };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=br&key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal }); clearTimeout(timer);
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results || !data.results[0]) return { ok: false, reason: data.status || 'sem_resultado', message: data.error_message };
    const loc = data.results[0].geometry.location;
    return { ok: true, lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
  } catch (e) { clearTimeout(timer); return { ok: false, reason: String(e && e.message || e) }; }
}
async function geocodeOrder(orderId, key) {
  const ref = db.collection('orders').doc(orderId);
  const sn = await ref.get(); if (!sn.exists) return { ok: false, reason: 'nao_existe' };
  const a = (sn.data().address) || {};
  if (a.lat != null && a.lng != null) return { ok: true, cached: true };
  const g = await geocode(a, key);
  if (!g.ok) { await log('geocode_failed', 'system', orderId, { reason: g.reason, message: g.message || '' }); return g; }
  await ref.set({ address: { ...a, lat: g.lat, lng: g.lng, geocoded: true, geoFormatted: g.formatted || '' }, updatedAt: nowIso() }, { merge: true });
  await log('geocoded', 'system', orderId, {});
  return { ok: true };
}

// ---------- App Express ----------
const app = express();
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-webhook-signature, x-webhook-key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
const err = (res, code, httpStatus, message, details) =>
  res.status(httpStatus).json({ error: { code, message, details } });

app.get('/health', (_req, res) =>
  res.json({ status:'ok', service:'audens-route-api', time: nowIso() }));

app.get('/api/debug', async (_req, res) => {
  try {
    const [st, or, ev] = await Promise.all([
      db.collection('stores').get(), db.collection('orders').get(), db.collection('webhook_events').get(),
    ]);
    const key = await mapsKey();
    const proj = (admin.app().options && admin.app().options.projectId) || process.env.GOOGLE_CLOUD_PROJECT || 'auto';
    res.json({ ok:true, stores: st.size, orders: or.size, webhookEvents: ev.size, googleMapsKey: !!key, projectId: proj, time: nowIso() });
  } catch (e) { res.status(500).json({ ok:false, error: String(e && e.message || e) }); }
});

ensureSeeded().catch(() => {});

// ===================== WEBHOOK =====================
// Cada cardápio tem SUA URL:  /api/webhooks/orders/:storeId?key=CHAVE
// Durante o setup respondemos 200/202 mesmo em problemas de config, para o
// Cardápio Web NÃO pausar a integração. O que aconteceu fica registrado em
// /api/webhook-events para diagnóstico.
app.post('/api/webhooks/orders/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  const store = await getStore(storeId);
  if (!store) {
    await captureRaw({ source:'cardapio_web', storeId, matched:false, note:`Loja não cadastrada: ${storeId}`, req });
    return res.status(200).json({ received:true, warning:`Cardápio "${storeId}" não está cadastrado. Cadastre na tela Lojas e use a URL de webhook de lá.` });
  }
  const key = req.query.key || req.get('x-webhook-key');
  if (store.webhookSecret && key !== store.webhookSecret) {
    await captureRaw({ source: store.source || 'cardapio_web', storeId, matched:false, note:'Chave do webhook inválida ou ausente', req });
    return res.status(200).json({ received:true, warning:'Chave do webhook inválida — copie a URL completa na tela Lojas (ela já vem com ?key=...).' });
  }

  const mapped = mapIncoming(req.body || {});
  const input = { ...mapped, storeId, source: (req.body && req.body.source) || store.source || 'cardapio_web' };
  if (!input.externalOrderId) {
    await captureRaw({ source: input.source, storeId, matched:false, note:'Payload recebido sem número/id do pedido', req });
    return res.status(202).json({ received:true, warning:'Recebido, mas não encontrei o número do pedido no payload (veja /api/webhook-events).' });
  }

  const result = await ingestOrder(input, store);
  // Busca os detalhes completos (cliente/endereço/itens/valor) na API do Cardápio Web.
  let enrich = null;
  if (store.apiToken) enrich = await enrichOrder(store, input.externalOrderId).catch(() => ({ ok:false, reason:'erro' }));
  await captureRaw({ source: input.source, storeId, matched:true, note: (result.duplicated ? 'Pedido atualizado' : 'Pedido criado') + (enrich ? (enrich.ok ? ' + detalhes' : ' (detalhes falharam: ' + enrich.reason + ')') : ' (sem token)'), req, orderId: result.orderId });
  return res.status(202).json({ ...result, enriched: enrich ? enrich.ok : false });
});

// Compatibilidade: webhook antigo (storeId no corpo) — também mapeia formato Uoou
app.post('/api/webhooks/orders', async (req, res) => {
  const b = req.body || {};
  const mapped = mapIncoming(b);
  const storeId = b.storeId || mapped.storeId;
  if (!storeId) { await captureRaw({ source:'legacy', matched:false, note:'Sem storeId no corpo', req }); return err(res, 'INVALID_PAYLOAD', 400, 'Campo obrigatório: storeId'); }
  const store = await getStore(storeId);
  const input = { ...mapped, storeId, source: b.source || (store && store.source) || 'cardapio_web' };
  if (!input.externalOrderId) { await captureRaw({ source: input.source, storeId, matched:false, note:'Sem número/id do pedido', req }); return err(res, 'INVALID_PAYLOAD', 400, 'Falta o número do pedido (number/externalOrderId)'); }
  const result = await ingestOrder(input, store);
  await captureRaw({ source: input.source, storeId, matched:true, note: result.duplicated ? 'Atualizado' : 'Criado', req, orderId: result.orderId });
  return res.status(202).json(result);
});

// Diagnóstico: últimos webhooks recebidos (mais recentes primeiro)
app.get('/api/webhook-events', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const snap = await db.collection('webhook_events').orderBy('receivedAt', 'desc').limit(limit).get();
    res.json(snap.docs.map(d => ({ _id: d.id, ...d.data() })));
  } catch (e) {
    // fallback sem orderBy caso o índice ainda não exista
    try {
      const snap = await db.collection('webhook_events').limit(50).get();
      const rows = snap.docs.map(d => ({ _id: d.id, ...d.data() })).sort((a,b)=> (a.receivedAt < b.receivedAt ? 1 : -1));
      res.json(rows);
    } catch (e2) { res.status(500).json({ error: String(e2 && e2.message || e2) }); }
  }
});
app.delete('/api/webhook-events', async (_req, res) => {
  const snap = await db.collection('webhook_events').limit(400).get();
  const batch = db.batch(); snap.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
  res.json({ deleted: snap.size });
});
// Diagnóstico: últimos registros de log (ex.: ?type=cw_push para ver o envio de status ao Cardápio Web)
app.get('/api/logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const type = req.query.type;
    let rows = (await db.collection('logs').limit(600).get()).docs.map(d => ({ _id: d.id, ...d.data() }));
    if (type) { const wanted = String(type).split(',').map(s => s.trim()); rows = rows.filter(r => wanted.includes(r.type)); }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json(rows.slice(0, limit));
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

// Reprocessa os avisos já capturados e transforma em pedidos (idempotente).
// GET e POST: pode abrir a URL no navegador para disparar.
async function reprocessEvents(_req, res) {
  const snap = await db.collection('webhook_events').limit(500).get();
  let created = 0, updated = 0, skipped = 0;
  for (const d of snap.docs) {
    const ev = d.data(); const body = ev.body || {}; const storeId = ev.storeId;
    if (!storeId) { skipped++; continue; }
    const store = await getStore(storeId);
    if (!store) { skipped++; continue; }
    const mapped = mapIncoming(body);
    const input = { ...mapped, storeId, source: ev.source || store.source || 'cardapio_web' };
    if (!input.externalOrderId) { skipped++; continue; }
    try {
      const r = await ingestOrder(input, store); r.duplicated ? updated++ : created++;
      if (store.apiToken) await enrichOrder(store, input.externalOrderId).catch(() => {});
    } catch (_) { skipped++; }
  }
  res.json({ ok: true, created, updated, skipped, totalEventos: snap.size });
}
app.get('/api/reprocess-events', reprocessEvents);
app.post('/api/reprocess-events', reprocessEvents);

// Busca os detalhes dos pedidos que ainda estão sem enriquecer (needsEnrichment=true).
async function enrichPending(_req, res) {
  const snap = await db.collection('orders').where('needsEnrichment', '==', true).limit(200).get();
  const storeCache = {};
  let enriched = 0, failed = 0, semToken = 0;
  for (const d of snap.docs) {
    const o = d.data();
    const store = storeCache[o.storeId] || (storeCache[o.storeId] = await getStore(o.storeId));
    if (!store || !store.apiToken) { semToken++; continue; }
    const r = await enrichOrder(store, o.externalOrderId).catch(() => ({ ok:false }));
    r.ok ? enriched++ : failed++;
  }
  res.json({ ok:true, pendentes: snap.size, enriched, failed, semToken });
}
app.get('/api/enrich-pending', enrichPending);
app.post('/api/enrich-pending', enrichPending);

// Re-busca os detalhes de TODOS os pedidos (p/ trazer a taxa de entrega nos já existentes).
async function reenrichHandler(_req, res) {
  const snap = await db.collection('orders').limit(200).get();
  const storeCache = {};
  let done = 0, skipped = 0;
  for (const d of snap.docs) {
    const o = d.data();
    if (!o.externalOrderId || !o.storeId) { skipped++; continue; }
    const store = storeCache[o.storeId] || (storeCache[o.storeId] = await getStore(o.storeId));
    if (!store || !store.apiToken) { skipped++; continue; }
    const r = await enrichOrder(store, o.externalOrderId).catch(() => ({ ok: false }));
    r.ok ? done++ : skipped++;
  }
  res.json({ ok: true, reenriquecidos: done, pulados: skipped, total: snap.size });
}
app.get('/api/reenrich', reenrichHandler);
app.post('/api/reenrich', reenrichHandler);

// Diagnóstico: mostra o endereço que guardamos + a resposta crua da API para um pedido.
app.get('/api/order-raw', async (req, res) => {
  const ext = String(req.query.ext || '').trim();
  if (!ext) return err(res, 'INVALID', 400, 'Passe ?ext=NUMERO (o Nº ou o número interno do pedido)');
  let snap = await db.collection('orders').where('externalOrderId', '==', ext).limit(1).get();
  if (snap.empty) snap = await db.collection('orders').where('displayId', '==', ext).limit(1).get();
  if (snap.empty) return res.json({ found: false, msg: 'Pedido não encontrado no sistema' });
  const o = snap.docs[0].data();
  const store = await getStore(o.storeId);
  const r = await fetchCardapioWebOrder(store, o.externalOrderId);
  const d = r.ok ? (r.data || {}) : null;
  // campos que costumam distinguir pedido próprio x marketplace (iFood/99Food)
  const canais = d ? {
    order_type: d.order_type, status: d.status, origin: d.origin, source: d.source,
    sales_channel: d.sales_channel, channel: d.channel, integration: d.integration,
    partner: d.partner, marketplace: d.marketplace, provider: d.provider,
    external_id: d.external_id, brand: d.brand, delivery_by: d.delivery_by,
  } : null;
  res.json({ found: true, storeId: o.storeId, storeName: o.storeName, nossoOrderType: o.orderType || null, nossoExternalState: o.externalState || null, nossoEndereco: o.address || null, respostaApi: r.ok ? { canais, delivery_address: d && d.delivery_address, chavesTopo: Object.keys(d || {}) } : r });
});

// ===================== PEDIDOS =====================
app.get('/api/orders', async (req, res) => {
  let q = db.collection('orders');
  if (req.query.status) q = q.where('status', '==', req.query.status);
  if (req.query.storeId) q = q.where('storeId', '==', req.query.storeId);
  const snap = await q.limit(300).get();
  const orders = snap.docs.map(d => d.data()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(orders);
});
// Histórico: pedidos entregues/finalizados, por dia (para conferência e edição posterior)
app.get('/api/orders/history', async (req, res) => {
  const snap = await db.collection('orders').where('status', '==', 'delivered').limit(3000).get();
  let list = snap.docs.map(d => d.data());
  const day = req.query.day; // YYYY-MM-DD (fuso BR); vazio = todos (limitado)
  if (day) list = list.filter(o => dayKeyBR(o.finalizedAt || o.deliveredAt || o.updatedAt || o.createdAt) === day);
  list.sort((a, b) => ((a.finalizedAt || a.deliveredAt || a.updatedAt || '') < (b.finalizedAt || b.deliveredAt || b.updatedAt || '') ? 1 : -1));
  res.json(list.slice(0, 500));
});
app.get('/api/orders/:id', async (req, res) => {
  const snap = await db.collection('orders').doc(req.params.id).get();
  if (!snap.exists) return err(res, 'ORDER_NOT_FOUND', 404, 'Pedido não encontrado');
  res.json(snap.data());
});
app.patch('/api/orders/:id/status', async (req, res) => {
  const to = req.body?.status;
  if (!ALL_STATUSES.includes(to)) return err(res, 'INVALID_STATUS', 400, `Status inválido: ${to}`);
  const ref = db.collection('orders').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'ORDER_NOT_FOUND', 404, 'Pedido não encontrado');
  const order = snap.data();
  if (!canTransition(order.status, to))
    return err(res, 'INVALID_TRANSITION', 400, `Transição inválida: ${order.status} → ${to}`);
  const now = nowIso();
  const patch = { status: to, updatedAt: now };
  if (to === OrderStatus.CONFIRMED) patch.confirmedAt = now;
  if (to === OrderStatus.PREPARING) patch.preparingAt = now;
  if (to === OrderStatus.READY) { patch.readyAt = now; patch.status = OrderStatus.WAITING_GROUPING; patch.groupingStartedAt = now; }
  await ref.set(patch, { merge: true });
  await log('status_changed', 'operator', req.params.id, { from: order.status, to: patch.status });
  res.json({ ...order, ...patch });
});

// Troca o motoboy de um pedido JÁ ENTREGUE (corrige a atribuição/financeiro sem mexer no status).
app.post('/api/orders/:id/reassign-driver', async (req, res) => {
  const driverId = req.body && req.body.driverId;
  if (!driverId) return err(res, 'INVALID', 400, 'Selecione um motoboy');
  const ref = db.collection('orders').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'ORDER_NOT_FOUND', 404, 'Pedido não encontrado');
  const order = snap.data();
  const ds = await db.collection('drivers').doc(driverId).get();
  if (!ds.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const prev = order.assignedDriverId || null;
  if (prev === driverId) return res.json({ ok: true, unchanged: true, driverName: ds.data().name });
  await ref.set({ assignedDriverId: driverId, updatedAt: nowIso() }, { merge: true });
  // se já entregue, ajusta o contador de entregas do dia dos dois motoboys
  if (order.status === 'delivered') {
    if (prev) { const pd = (await db.collection('drivers').doc(prev).get()).data(); if (pd) await setDriver(prev, { todayDeliveries: Math.max(0, (pd.todayDeliveries || 0) - 1) }); }
    const nd = ds.data(); await setDriver(driverId, { todayDeliveries: (nd.todayDeliveries || 0) + 1 });
  }
  await log('order_driver_reassigned', 'operator', req.params.id, { from: prev, to: driverId });
  res.json({ ok: true, driverName: ds.data().name });
});

// FINALIZAR pedido (conferência da loja): mantém status 'delivered', só marca finalized.
// Assim o Financeiro/Métricas continuam contando o entregue normalmente.
app.post('/api/orders/:id/finalize', async (req, res) => {
  const ref = db.collection('orders').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'ORDER_NOT_FOUND', 404, 'Pedido não encontrado');
  const order = snap.data();
  const b = req.body || {};
  const finalized = b.finalized === false ? false : true;
  if (finalized && order.status !== 'delivered') return err(res, 'NOT_DELIVERED', 400, 'Só é possível finalizar um pedido já entregue');
  const now = nowIso();
  const patch = { finalized, finalizedAt: finalized ? now : null, finalizedBy: finalized ? (b.by || 'admin') : null, updatedAt: now };
  await ref.set(patch, { merge: true });
  await log(finalized ? 'order_finalized' : 'order_unfinalized', b.by || 'admin', req.params.id, {});
  res.json({ ...order, ...patch });
});

// atribui um pedido a um motoboy e marca como ENTREGUE (para entregas feitas fora do fluxo normal)
app.post('/api/orders/:id/deliver-manual', async (req, res) => {
  const driverId = req.body && req.body.driverId;
  if (!driverId) return err(res, 'INVALID', 400, 'Selecione o motoboy que entregou');
  const ref = db.collection('orders').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'ORDER_NOT_FOUND', 404, 'Pedido não encontrado');
  const order = snap.data();
  const ds = await db.collection('drivers').doc(driverId).get();
  if (!ds.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const driver = ds.data();
  const now = nowIso();
  // se o pedido estava numa rota, tira ele de lá para não bagunçar a rota
  if (order.assignedRouteId) {
    const rref = db.collection('routes').doc(order.assignedRouteId);
    const rs = await rref.get();
    if (rs.exists) {
      const remaining = (rs.data().orders || []).filter(x => x !== req.params.id);
      if (remaining.length) { await rref.set({ orders: remaining, updatedAt: now }, { merge: true }); await recomputeRoute(order.assignedRouteId); }
      else await rref.delete();
    }
  }
  await ref.set({ status: 'delivered', assignedDriverId: driverId, assignedRouteId: null, deliveredAt: now, updatedAt: now, manualDelivery: true }, { merge: true });
  // conta a entrega para o motoboy
  await setDriver(driverId, { todayDeliveries: (driver.todayDeliveries || 0) + 1 });
  // avisa o Cardápio Web (melhor esforço). O 'delivered' só é aceito se o pedido estiver
  // 'released', então mandamos 'ready' antes (se ainda não tinha saído numa rota).
  const orderForPush = { ...order, id: req.params.id };
  if (!['sent_to_driver', 'accepted_by_driver', 'out_for_delivery', 'in_progress'].includes(order.status)) {
    await pushCwStatus(orderForPush, 'ready');
  }
  await pushCwStatus(orderForPush, 'delivered');
  await log('order_delivered_manual', 'operator', req.params.id, { driverId, driverName: driver.name });
  res.json({ ok: true, driverName: driver.name });
});

// ===================== CARDÁPIOS (stores) =====================
app.get('/api/stores', async (_req, res) => {
  const snap = await db.collection('stores').get();
  res.json(snap.docs.map(d => d.data()).sort((a, b) => (a.name > b.name ? 1 : -1)));
});
app.post('/api/stores', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return err(res, 'INVALID', 400, 'O nome do cardápio é obrigatório');
  const id = b.id ? slugify(b.id) : `${slugify(b.name)}-${randHex(2)}`;
  if ((await db.collection('stores').doc(id).get()).exists)
    return err(res, 'DUPLICATE', 409, 'Já existe um cardápio com esse identificador');
  const store = {
    id, name: b.name, type: b.type || '', address: b.address || '',
    lat: b.lat ?? null, lng: b.lng ?? null, active: true,
    defaultPrepTimeMinutes: Number(b.defaultPrepTimeMinutes) || 25,
    maxDeliveryTimeMinutes: Number(b.maxDeliveryTimeMinutes) || 60,
    webhookSecret: randHex(16), storeGroupId: b.storeGroupId || 'audens_store_group',
    source: b.source || 'cardapio_web', createdAt: nowIso(),
  };
  await db.collection('stores').doc(id).set(store);
  await log('store_created', 'admin', id, { name: store.name });
  res.status(201).json(store);
});
app.patch('/api/stores/:id', async (req, res) => {
  const ref = db.collection('stores').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Cardápio não encontrado');
  const patch = { ...req.body, updatedAt: nowIso() };
  delete patch.id; delete patch.webhookSecret;
  // se veio um endereço, geocodifica para obter a localização da loja (base do geofence)
  if (typeof patch.address === 'string' && patch.address.trim()) {
    const key = await mapsKey();
    if (key) {
      const g = await geocode({ street: patch.address.trim() }, key);
      if (g.ok) { patch.lat = g.lat; patch.lng = g.lng; patch.geoFormatted = g.formatted || ''; }
      else { patch.geocodeError = g.reason || 'falha'; }
    }
  }
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
app.post('/api/stores/:id/rotate-key', async (req, res) => {
  const ref = db.collection('stores').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Cardápio não encontrado');
  const webhookSecret = randHex(16);
  await ref.set({ webhookSecret, updatedAt: nowIso() }, { merge: true });
  res.json((await ref.get()).data());
});
app.delete('/api/stores/:id', async (req, res) => {
  await db.collection('stores').doc(req.params.id).delete();
  await log('store_deleted', 'admin', req.params.id, {});
  res.json({ deleted: true });
});

// ===================== ROTAS / AGRUPAMENTO =====================
function nkey(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

// pedidos aguardando agrupamento e ainda não atribuídos a rota (mais antigos primeiro)
async function getGroupableOrders() {
  // inclui 'ready' (Pronto) além de 'waiting_grouping': pedidos que estouraram o tempo
  // voltam p/ Pronto e continuam disponíveis para montar rota
  const snap = await db.collection('orders').where('status', 'in', ['waiting_grouping', 'ready']).limit(300).get();
  return snap.docs.map(d => d.data()).filter(o => !o.assignedRouteId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

app.get('/api/routes', async (req, res) => {
  const snap = await db.collection('routes').limit(200).get();
  let routes = snap.docs.map(d => d.data());
  if (req.query.active === 'true') routes = routes.filter(r => !['canceled', 'finished'].includes(r.status));
  routes.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(routes);
});

function buildSug(chunk, basis, maxKm) {
  const bairros = [...new Set(chunk.map(o => (o.address && o.address.neighborhood) || '—'))];
  // distância máxima entre pares do grupo (só informativa)
  let dmax = 0;
  for (let i = 0; i < chunk.length; i++) for (let j = i + 1; j < chunk.length; j++) {
    const d = haversineKm(chunk[i].address, chunk[j].address); if (d !== Infinity && d > dmax) dmax = d;
  }
  return {
    orderIds: chunk.map(o => o.id),
    neighborhood: bairros.join(', '),
    city: (chunk[0].address && chunk[0].address.city) || '',
    basis, maxKm: (basis === 'proximidade' || basis === 'corredor') ? Math.round(dmax * 10) / 10 : null,
    totalValue: chunk.reduce((t, o) => t + (Number(o.total) || 0), 0),
    orders: chunk.map(o => ({ id: o.id, displayId: o.displayId || o.externalOrderId, storeName: o.storeName, storeId: o.storeId, neighborhood: (o.address && o.address.neighborhood) || '', total: o.total || 0 })),
  };
}

// Sugestões: agrupamento INTELIGENTE por CORREDOR/direção a partir da loja + fallback por bairro. NÃO persiste.
app.get('/api/routes/suggestions', async (_req, res) => {
  const s = await getSettings();
  const min = s.minOrdersPerRoute || 2, max = s.maxOrdersPerRoute || 3;
  const maxKm = Number(s.maxDistanceBetweenGroupedOrdersKm) || 2.0;
  const maxBearing = Number(s.maxBearingDiffDeg) || 50;   // quão "no mesmo sentido" precisam estar
  const maxDetour = Number(s.maxRouteDetourRatio) || 1.5; // trajeto vs ir só ao mais distante (1=perfeito)
  const orders = await getGroupableOrders();
  const withGeo = orders.filter(o => o.address && o.address.lat != null && o.address.lng != null);
  const noGeo = orders.filter(o => !(o.address && o.address.lat != null && o.address.lng != null));
  const suggestions = [];

  // origem (loja) de cada pedido — base para direção e desvio
  const stSnap = await db.collection('stores').get();
  const storeById = {}; stSnap.docs.forEach(d => { const x = d.data(); storeById[x.id] = x; });
  const originOf = (o) => { const st = storeById[o.storeId]; return (st && st.lat != null && st.lng != null) ? { lat: st.lat, lng: st.lng } : null; };

  // 1) Agrupamento por CORREDOR: mesmo sentido a partir da loja + baixo desvio de trajeto ("no caminho")
  const used = new Set();
  for (const seed of withGeo) {
    if (used.has(seed.id)) continue;
    const origin = originOf(seed) || seed.address; // sem loja geocodificada, usa o próprio pedido como origem
    const seedBearing = bearingDeg(origin, seed.address);
    used.add(seed.id);
    const group = [seed];
    // candidatos: no mesmo sentido (rumo próximo) e dentro do raio entre pedidos
    let cands = withGeo.filter(o => !used.has(o.id) && haversineKm(seed.address, o.address) <= maxKm * 1.5)
      .filter(o => { const b = bearingDeg(origin, o.address); return seedBearing == null || b == null || angDiff(seedBearing, b) <= maxBearing; });
    // vai juntando quem mantém o trajeto eficiente (menor desvio), até o máximo
    while (group.length < max && cands.length) {
      let best = null, bestDetour = Infinity;
      for (const c of cands) {
        const members = group.concat(c).map(o => o.address);
        const routeKm = nnRouteKm(origin, members);
        const maxStoreKm = Math.max(...group.concat(c).map(o => haversineKm(origin, o.address)));
        const detour = maxStoreKm > 0.05 ? routeKm / maxStoreKm : 1;
        if (detour < bestDetour) { bestDetour = detour; best = c; }
      }
      if (best && bestDetour <= maxDetour) { group.push(best); used.add(best.id); cands = cands.filter(c => c.id !== best.id); }
      else break;
    }
    if (group.length >= min) suggestions.push(buildSug(group, 'corredor', maxKm));
    else used.delete(seed.id); // não formou grupo: deixa livre p/ ser candidato de outro
  }

  // 2) Fallback por bairro (para pedidos ainda sem coordenada)
  const buckets = {};
  for (const o of noGeo) {
    const k = (o.storeGroupId || 'g') + '|' + nkey(o.address && o.address.city) + '|' + nkey(o.address && o.address.neighborhood);
    (buckets[k] = buckets[k] || []).push(o);
  }
  for (const k of Object.keys(buckets)) {
    const arr = buckets[k];
    for (let i = 0; i < arr.length; i += max) {
      const chunk = arr.slice(i, i + max);
      if (chunk.length >= min) suggestions.push(buildSug(chunk, 'bairro', maxKm));
    }
  }
  res.json(suggestions);
});

// cria uma rota automaticamente (sistema) a partir de ids de pedidos
async function autoCreateRoute(orderIds) {
  const refs = orderIds.map(id => db.collection('orders').doc(id));
  const snaps = await db.getAll(...refs);
  const orders = [];
  for (const sn of snaps) { if (!sn.exists) throw new Error('pedido não existe'); const o = sn.data(); if (o.assignedRouteId) throw new Error('já agrupado'); orders.push(o); }
  const routeId = 'route_' + randHex(6); const now = nowIso();
  const route = {
    id: routeId, orders: orderIds, orderCount: orderIds.length,
    storeGroupId: orders[0].storeGroupId || 'audens_store_group', status: 'approved', isException: false,
    neighborhoods: [...new Set(orders.map(o => (o.address && o.address.neighborhood) || '—'))],
    stores: [...new Set(orders.map(o => o.storeName))],
    totalValue: orders.reduce((t, o) => t + (Number(o.total) || 0), 0), totalDistanceKm: routeDistanceKm(orders),
    driverId: null, driverName: null, createdBySystem: true, manuallyEdited: false, createdAt: now, approvedAt: now, exceptionReason: null,
  };
  const batch = db.batch(); batch.set(db.collection('routes').doc(routeId), route);
  orders.forEach((o, i) => batch.set(refs[i], { status: 'grouped', assignedRouteId: routeId, groupedAt: now, updatedAt: now }, { merge: true }));
  await batch.commit();
  await log('route_created', 'system', routeId, { orders: orderIds, auto: true });
  return route;
}

// Tick de automação: agrupa sozinho (se autoGroup ligado, após a janela) e devolve alertas de "pedido sozinho".
// Pode ser chamado pelo Cloud Scheduler (sem operador) e também pelo painel a cada atualização.
app.post('/api/grouping/tick', async (_req, res) => {
  const s = await getSettings();
  const min = s.minOrdersPerRoute || 2, max = s.maxOrdersPerRoute || 3;
  const maxKm = Number(s.maxDistanceBetweenGroupedOrdersKm) || 2;
  const windowMin = Number(s.groupingWindowMinutes) || 3;
  const loneMin = Number(s.maxReadyWaitingTimeMinutes) || 10;
  const waited = (o) => { const t = Date.parse(o.readyAt || o.groupingStartedAt || o.createdAt || ''); return isNaN(t) ? 0 : (Date.now() - t) / 60000; };
  const created = [];
  if (s.autoGroup) {
    const orders = await getGroupableOrders();
    const withGeo = orders.filter(o => o.address && o.address.lat != null && o.address.lng != null);
    const used = new Set();
    for (const seed of withGeo) {
      if (used.has(seed.id)) continue;
      if (waited(seed) < windowMin) continue; // ainda dentro da janela de espera
      used.add(seed.id);
      const group = [seed];
      const cands = withGeo.filter(o => !used.has(o.id)).map(o => ({ o, d: haversineKm(seed.address, o.address) })).filter(x => x.d <= maxKm).sort((a, b) => a.d - b.d);
      for (const c of cands) { if (group.length >= max) break; group.push(c.o); used.add(c.o.id); }
      if (group.length >= min) {
        const ids = group.map(o => o.id);
        try {
          const route = await autoCreateRoute(ids);
          let assignedTo = null;
          if (s.autoDispatch) { const drv = await firstInQueue(); if (drv) { await doAssign(route.id, drv, ids); assignedTo = drv.name; } }
          created.push({ routeId: route.id, orders: ids.length, assignedTo });
        } catch (e) { group.forEach(o => used.delete(o.id)); }
      } else { group.forEach(o => used.delete(o.id)); used.add(seed.id); }
    }
  }
  // Devolve p/ "Pronto" os pedidos que ficaram tempo demais tentando montar rota.
  // Eles seguem no pool de agrupamento (getGroupableOrders inclui 'ready'), então continuam
  // sendo tentados/sugeridos para rota — só o cronômetro é reiniciado.
  const returned = [];
  if (s.returnToReadyEnabled) {
    const backMin = Number(s.returnToReadyMinutes) || 10;
    const stuck = (await getGroupableOrders()).filter(o => o.status === OrderStatus.WAITING_GROUPING && waited(o) >= backMin);
    const nowI = nowIso();
    for (const o of stuck) {
      try {
        await db.collection('orders').doc(o.id).set({
          status: OrderStatus.READY, readyAt: nowI, groupingStartedAt: null,
          backToReadyAt: nowI, backToReadyCount: (Number(o.backToReadyCount) || 0) + 1,
          updatedAt: nowI,
        }, { merge: true });
        returned.push({ id: o.id, displayId: o.displayId || o.externalOrderId, waitedMin: Math.round(waited(o)) });
      } catch (e) {}
    }
    if (returned.length) { try { await log('return_to_ready', 'system', null, { count: returned.length, orders: returned }); } catch (e) {} }
  }
  const remaining = await getGroupableOrders();
  const lone = remaining.filter(o => waited(o) >= loneMin).map(o => ({ id: o.id, displayId: o.displayId || o.externalOrderId, neighborhood: (o.address && o.address.neighborhood) || '', waitedMin: Math.round(waited(o)) }));
  res.json({ autoGroup: !!s.autoGroup, windowMin, loneMin, created, returned, lone });
});

// Geocodifica pedidos que têm endereço mas ainda não têm coordenadas.
async function geocodePendingHandler(_req, res) {
  const key = await mapsKey();
  if (!key) return res.json({ ok: false, error: 'Sem chave do Google Maps. Defina GOOGLE_MAPS_API_KEY no Cloud Run (Variáveis) ou googleMapsApiKey em settings.' });
  const snap = await db.collection('orders').limit(300).get();
  const all = snap.docs.map(d => d.data());
  const geocodavel = (o) => o.address && (o.address.street || o.address.neighborhood);
  const diag = {
    totalPedidos: all.length,
    comEndereco: all.filter(geocodavel).length,
    jaComCoordenada: all.filter(o => o.address && o.address.lat != null).length,
    semEnderecoNenhum: all.filter(o => !geocodavel(o)).length,
  };
  const pend = all.filter(o => geocodavel(o) && o.address.lat == null).slice(0, 80);
  let done = 0, fail = 0; const erros = [];
  for (const o of pend) { const r = await geocodeOrder(o.id, key); if (r.ok) done++; else { fail++; if (erros.length < 5) erros.push(r.reason + (r.message ? (': ' + r.message) : '')); } }
  res.json({ ok: true, pendentes: pend.length, geocodificados: done, falhas: fail, erros, diagnostico: diag });
}
app.get('/api/geocode-pending', geocodePendingHandler);
app.post('/api/geocode-pending', geocodePendingHandler);

// Cria uma rota a partir de pedidos selecionados (criação manual = já aprovada).
app.post('/api/routes', async (req, res) => {
  const b = req.body || {};
  const orderIds = Array.isArray(b.orderIds) ? b.orderIds : [];
  const s = await getSettings();
  const min = s.minOrdersPerRoute || 2, max = s.maxOrdersPerRoute || 3;
  const hardMax = Number(s.maxOrdersPerRouteForced) || 4;
  const force = !!b.force;
  const cap = force ? hardMax : max; // forçando, permite até o teto (padrão 4)
  if (orderIds.length < 1) return err(res, 'INVALID', 400, 'Selecione ao menos um pedido');
  if (orderIds.length > cap) return err(res, 'TOO_MANY', 400, `Máximo de ${cap} pedidos por rota${force ? '' : ' (use forçar para até ' + hardMax + ')'}`);
  if (orderIds.length < min && !force) return err(res, 'TOO_FEW', 400, `Mínimo de ${min} pedidos por rota (regra R1). Use a exceção para forçar 1.`);

  const refs = orderIds.map(id => db.collection('orders').doc(id));
  const snaps = await db.getAll(...refs);
  const orders = [];
  for (const sn of snaps) {
    if (!sn.exists) return err(res, 'ORDER_NOT_FOUND', 404, `Pedido não encontrado: ${sn.id}`);
    const o = sn.data();
    if (o.assignedRouteId) return err(res, 'ALREADY_GROUPED', 409, `Pedido ${o.displayId || o.externalOrderId} já está em outra rota`);
    orders.push(o);
  }
  const routeId = 'route_' + randHex(6);
  const now = nowIso();
  const route = {
    id: routeId, orders: orderIds, orderCount: orderIds.length,
    storeGroupId: orders[0].storeGroupId || 'audens_store_group',
    status: 'approved', isException: orderIds.length < min,
    neighborhoods: [...new Set(orders.map(o => (o.address && o.address.neighborhood) || '—'))],
    stores: [...new Set(orders.map(o => o.storeName))],
    totalValue: orders.reduce((t, o) => t + (Number(o.total) || 0), 0),
    totalDistanceKm: routeDistanceKm(orders),
    driverId: null, driverName: null,
    createdBySystem: !!b.fromSuggestion, manuallyEdited: false,
    createdAt: now, approvedAt: now, exceptionReason: b.exceptionReason || null,
  };
  const batch = db.batch();
  batch.set(db.collection('routes').doc(routeId), route);
  orders.forEach((o, i) => batch.set(refs[i], { status: 'grouped', assignedRouteId: routeId, groupedAt: now, updatedAt: now }, { merge: true }));
  await batch.commit();
  await log('route_created', 'operator', routeId, { orders: orderIds, exception: route.isException });
  // despacho automático: se ligado, envia direto pro 1º da fila
  let autoAssigned = null;
  if (s.autoDispatch) {
    const drv = await firstInQueue();
    if (drv) { await doAssign(routeId, drv, orderIds); autoAssigned = drv.name; await log('route_autodispatched', 'system', routeId, { driverId: drv.id }); }
  }
  const finalRoute = (await db.collection('routes').doc(routeId).get()).data();
  res.status(201).json({ ...finalRoute, autoAssigned });
});

app.post('/api/routes/:id/approve', async (req, res) => {
  const ref = db.collection('routes').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  await ref.set({ status: 'approved', approvedAt: nowIso(), updatedAt: nowIso() }, { merge: true });
  await log('route_approved', 'operator', req.params.id, {});
  res.json((await ref.get()).data());
});

// Desfaz a rota: devolve os pedidos para "aguardando agrupamento".
app.delete('/api/routes/:id', async (req, res) => {
  const ref = db.collection('routes').doc(req.params.id);
  const sn = await ref.get();
  if (!sn.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const route = sn.data();
  const batch = db.batch();
  for (const oid of (route.orders || [])) {
    batch.set(db.collection('orders').doc(oid), { status: 'waiting_grouping', assignedRouteId: null, groupedAt: null, updatedAt: nowIso() }, { merge: true });
  }
  batch.delete(ref);
  await batch.commit();
  await log('route_deleted', 'operator', req.params.id, { orders: route.orders });
  res.json({ deleted: true, released: (route.orders || []).length });
});

// recalcula os totais da rota (bairros, lojas, valor, distância) a partir dos pedidos atuais
async function recomputeRoute(routeId) {
  const rref = db.collection('routes').doc(routeId);
  const rs = await rref.get();
  if (!rs.exists) return null;
  const route = rs.data();
  const ids = route.orders || [];
  let orders = [];
  if (ids.length) {
    const snaps = await db.getAll(...ids.map(id => db.collection('orders').doc(id)));
    orders = snaps.filter(s => s.exists).map(s => s.data());
  }
  const patch = {
    orderCount: ids.length,
    neighborhoods: [...new Set(orders.map(o => (o.address && o.address.neighborhood) || '—'))],
    stores: [...new Set(orders.map(o => o.storeName))],
    totalValue: orders.reduce((t, o) => t + (Number(o.total) || 0), 0),
    totalDistanceKm: routeDistanceKm(orders),
    manuallyEdited: true,
    updatedAt: nowIso(),
  };
  await rref.set(patch, { merge: true });
  return { ...route, ...patch };
}
// mapeia o status da rota para o status que o pedido deve ter dentro dela
const ROUTE_TO_ORDER_STATUS = { approved: 'grouped', sent_to_driver: 'sent_to_driver', accepted_by_driver: 'accepted_by_driver', in_progress: 'out_for_delivery' };

// remove um pedido de uma rota (mesmo já despachada) e devolve o pedido p/ "aguardando agrupamento"
app.post('/api/routes/:id/remove-order', async (req, res) => {
  const orderId = req.body && req.body.orderId;
  if (!orderId) return err(res, 'INVALID', 400, 'Informe o pedido a remover');
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const route = rs.data();
  const ids = route.orders || [];
  if (!ids.includes(orderId)) return err(res, 'NOT_IN_ROUTE', 404, 'Esse pedido não está nesta rota');
  const now = nowIso();
  // devolve o pedido para "aguardando agrupamento" (disponível p/ nova rota)
  await db.collection('orders').doc(orderId).set({ status: 'waiting_grouping', assignedRouteId: null, assignedDriverId: null, groupedAt: null, updatedAt: now }, { merge: true });
  const remaining = ids.filter(x => x !== orderId);
  if (!remaining.length) {
    // rota ficou vazia -> apaga e libera o motoboy
    if (route.driverId) await setDriver(route.driverId, { activeRouteId: null, status: 'online' });
    await rref.delete();
    await log('route_order_removed', 'operator', req.params.id, { orderId, routeDeleted: true });
    return res.json({ ok: true, routeDeleted: true });
  }
  await rref.set({ orders: remaining, updatedAt: now }, { merge: true });
  const updated = await recomputeRoute(req.params.id);
  await log('route_order_removed', 'operator', req.params.id, { orderId });
  res.json({ ok: true, route: updated });
});

// adiciona um pedido disponível a uma rota existente (mesmo já despachada); espelha o estado da rota no pedido
app.post('/api/routes/:id/add-order', async (req, res) => {
  const orderId = req.body && req.body.orderId;
  if (!orderId) return err(res, 'INVALID', 400, 'Informe o pedido a adicionar');
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const route = rs.data();
  const ids = route.orders || [];
  if (ids.includes(orderId)) return err(res, 'ALREADY_IN_ROUTE', 409, 'Esse pedido já está na rota');
  const s = await getSettings();
  const max = s.maxOrdersPerRoute || 3;
  if (ids.length >= max) return err(res, 'TOO_MANY', 400, `Máximo de ${max} pedidos por rota (regra R2)`);
  const oref = db.collection('orders').doc(orderId);
  const os = await oref.get();
  if (!os.exists) return err(res, 'ORDER_NOT_FOUND', 404, 'Pedido não encontrado');
  const order = os.data();
  if (order.assignedRouteId && order.assignedRouteId !== req.params.id) return err(res, 'ALREADY_GROUPED', 409, `Pedido ${order.displayId || order.externalOrderId} já está em outra rota`);
  const now = nowIso();
  const newStatus = ROUTE_TO_ORDER_STATUS[route.status] || 'grouped';
  await oref.set({ status: newStatus, assignedRouteId: req.params.id, assignedDriverId: route.driverId || null, groupedAt: now, updatedAt: now }, { merge: true });
  await rref.set({ orders: [...ids, orderId], updatedAt: now }, { merge: true });
  const updated = await recomputeRoute(req.params.id);
  await log('route_order_added', 'operator', req.params.id, { orderId, status: newStatus });
  res.json({ ok: true, route: updated });
});

// ===================== USUÁRIOS (login + papel) =====================
const ROLES = ['admin', 'operator', 'kitchen', 'driver'];

// cria um login (Firebase Auth) + papel (custom claim). Se motoboy, cria o driver.
app.post('/api/users', async (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim(), email = (b.email || '').trim().toLowerCase();
  const password = b.password || '', role = ROLES.includes(b.role) ? b.role : 'operator';
  if (!name) return err(res, 'INVALID', 400, 'Nome é obrigatório');
  if (!email) return err(res, 'INVALID', 400, 'E-mail é obrigatório');
  if (password.length < 6) return err(res, 'WEAK_PASSWORD', 400, 'A senha precisa ter ao menos 6 caracteres');
  let user;
  try { user = await admin.auth().createUser({ email, password, displayName: name }); }
  catch (e) {
    const code = String(e && e.code || '');
    if (code.includes('email-already-exists')) return err(res, 'EMAIL_EXISTS', 409, 'Já existe um usuário com esse e-mail');
    if (code.includes('permission') || code.includes('PERMISSION')) return err(res, 'NO_PERMISSION', 500, 'O backend não tem permissão para criar logins. Conceda o papel "Administrador do Firebase Authentication" à conta de serviço.');
    return err(res, 'AUTH_ERROR', 500, 'Erro ao criar login: ' + (e && e.message || e));
  }
  const uid = user.uid;
  let driverId = null;
  if (role === 'driver') {
    driverId = 'drv_' + randHex(4);
    await db.collection('drivers').doc(driverId).set({
      id: driverId, name, phone: b.phone || '', email, uid, role: 'driver',
      status: 'offline', online: false, arrivedAtStore: null, activeRouteId: null,
      todayDeliveries: 0, acceptanceRate: null, active: true, createdAt: nowIso(),
    });
  }
  try { await admin.auth().setCustomUserClaims(uid, { role, driverId }); } catch (_) {}
  await db.collection('users').doc(uid).set({ uid, name, email, role, driverId, phone: b.phone || '', active: true, createdAt: nowIso() });
  await log('user_created', 'admin', uid, { email, role });
  res.status(201).json({ uid, name, email, role, driverId });
});

app.get('/api/users', async (_req, res) => {
  const snap = await db.collection('users').get();
  res.json(snap.docs.map(d => d.data()).sort((a, b) => (a.name > b.name ? 1 : -1)));
});

app.patch('/api/users/:uid/role', async (req, res) => {
  const uid = req.params.uid, role = req.body && req.body.role;
  if (!ROLES.includes(role)) return err(res, 'INVALID', 400, 'Papel inválido');
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Usuário não encontrado');
  const u = snap.data();
  let driverId = u.driverId || null;
  if (role === 'driver' && !driverId) {
    driverId = 'drv_' + randHex(4);
    await db.collection('drivers').doc(driverId).set({
      id: driverId, name: u.name, phone: u.phone || '', email: u.email, uid, role: 'driver',
      status: 'offline', online: false, arrivedAtStore: null, activeRouteId: null,
      todayDeliveries: 0, acceptanceRate: null, active: true, createdAt: nowIso(),
    });
  }
  try { await admin.auth().setCustomUserClaims(uid, { role, driverId }); } catch (_) {}
  await ref.set({ role, driverId, updatedAt: nowIso() }, { merge: true });
  res.json({ ...u, role, driverId });
});

app.delete('/api/users/:uid', async (req, res) => {
  const uid = req.params.uid;
  const snap = await db.collection('users').doc(uid).get();
  const u = snap.exists ? snap.data() : null;
  try { await admin.auth().deleteUser(uid); } catch (_) {}
  if (u && u.driverId) await db.collection('drivers').doc(u.driverId).delete().catch(() => {});
  await db.collection('users').doc(uid).delete().catch(() => {});
  await log('user_deleted', 'admin', uid, {});
  res.json({ deleted: true });
});

// quem sou eu (para o login/tela do motoboy saber o papel e o driverId pelo e-mail)
app.get('/api/whoami', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ role: null, driverId: null });
  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) {
    const dsnap = await db.collection('drivers').where('email', '==', email).limit(1).get();
    if (!dsnap.empty) { const d = dsnap.docs[0].data(); return res.json({ role: 'driver', driverId: d.id, name: d.name }); }
    return res.json({ role: null, driverId: null });
  }
  const u = snap.docs[0].data();
  res.json({ role: u.role, driverId: u.driverId || null, name: u.name });
});

// ===================== MOTOBOYS =====================
app.get('/api/drivers', async (_req, res) => {
  const snap = await db.collection('drivers').get();
  res.json(snap.docs.map(d => d.data()).sort((a, b) => (a.name > b.name ? 1 : -1)));
});
app.get('/api/drivers/queue', async (_req, res) => {
  const list = (await queueList()).map((d, i) => ({ ...d, queuePosition: i + 1 }));
  res.json(list);
});
app.get('/api/drivers/by-email/:email', async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const snap = await db.collection('drivers').where('email', '==', email).limit(1).get();
  if (snap.empty) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  res.json(snap.docs[0].data());
});
app.get('/api/drivers/:id', async (req, res) => {
  const snap = await db.collection('drivers').doc(req.params.id).get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  res.json(snap.data());
});
app.post('/api/drivers', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return err(res, 'INVALID', 400, 'Nome é obrigatório');
  const id = 'drv_' + randHex(4);
  const driver = {
    id, name: b.name, phone: b.phone || '', email: (b.email || '').toLowerCase(), uid: b.uid || null, role: 'driver',
    status: 'offline', online: false, arrivedAtStore: null, activeRouteId: null,
    todayDeliveries: 0, acceptanceRate: null, active: true, createdAt: nowIso(),
  };
  await db.collection('drivers').doc(id).set(driver);
  res.status(201).json(driver);
});
app.patch('/api/drivers/:id', async (req, res) => {
  const ref = db.collection('drivers').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const patch = { ...req.body, updatedAt: nowIso() }; delete patch.id;
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
app.delete('/api/drivers/:id', async (req, res) => {
  await db.collection('drivers').doc(req.params.id).delete();
  res.json({ deleted: true });
});
// online / offline (base da fila por chegada)
app.patch('/api/drivers/:id/status', async (req, res) => {
  const ref = db.collection('drivers').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const online = !!(req.body && req.body.online);
  const now = nowIso();
  const patch = { online, status: online ? 'online' : 'offline', updatedAt: now };
  if (online) { patch.wentOnlineAt = now; }               // GPS/geofence define a chegada na loja
  else { patch.arrivedAtStore = null; patch.isInsideStoreGeofence = false; patch.manualAtStore = false; patch.queueOrder = null; }
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
// Motoboy marca que CHEGOU NA LOJA — confirmação manual, mas VALIDADA por proximidade (raio).
app.post('/api/drivers/:id/arrive', async (req, res) => {
  const ref = db.collection('drivers').doc(req.params.id);
  const snap = await ref.get(); if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const d = snap.data();
  const arrived = !(req.body && req.body.arrived === false);
  const now = nowIso();
  if (arrived) {
    // precisa estar dentro do raio da loja (com folga p/ ruído de GPS)
    const s = await getSettings();
    const radius = Number(s.storeGeofenceRadiusMeters) || 150;
    const maxMeters = Math.round(radius * 1.6);
    const stSnap = await db.collection('stores').get();
    const locs = stSnap.docs.map(x => x.data()).filter(x => x.lat != null && x.lng != null);
    if (locs.length) { // se nenhuma loja tem coordenada, não dá p/ validar -> permite
      const loc = d.currentLocation;
      if (!loc || loc.lat == null) return err(res, 'NO_LOCATION', 400, 'Ative a localização do celular para confirmar que você está na loja.');
      let nearest = Infinity;
      for (const st of locs) { const km = haversineKm({ lat: loc.lat, lng: loc.lng }, { lat: st.lat, lng: st.lng }); if (km < nearest) nearest = km; }
      const meters = Math.round(nearest * 1000);
      if (meters > maxMeters) return err(res, 'TOO_FAR', 400, `Você está a ${meters} m da loja. Aproxime-se (até ${maxMeters} m) para entrar na fila.`);
    }
  }
  const patch = arrived
    ? { manualAtStore: true, isInsideStoreGeofence: true, arrivedAtStore: d.arrivedAtStore || now, updatedAt: now }
    : { manualAtStore: false, isInsideStoreGeofence: false, arrivedAtStore: null, updatedAt: now };
  await ref.set(patch, { merge: true });
  await log(arrived ? 'driver_arrived' : 'driver_left_store', req.params.id, req.params.id, {});
  res.json((await ref.get()).data());
});
// Operador reordena a fila manualmente (arrastar). ids = ordem desejada dos motoboys.
app.post('/api/drivers/queue/reorder', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return err(res, 'INVALID', 400, 'Informe a nova ordem da fila (ids)');
  const now = nowIso(); const batch = db.batch();
  ids.forEach((id, i) => batch.set(db.collection('drivers').doc(id), { queueOrder: i, updatedAt: now }, { merge: true }));
  await batch.commit();
  await log('queue_reordered', 'operator', 'queue', { ids });
  res.json({ ok: true, count: ids.length });
});
// GPS do motoboy -> geofence de chegada na loja
app.post('/api/drivers/:id/location', async (req, res) => {
  const lat = req.body && req.body.lat, lng = req.body && req.body.lng;
  if (lat == null || lng == null) return err(res, 'INVALID', 400, 'lat/lng obrigatórios');
  const ref = db.collection('drivers').doc(req.params.id);
  const snap = await ref.get(); if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const d = snap.data(); const now = nowIso();
  const s = await getSettings(); const radius = Number(s.storeGeofenceRadiusMeters) || 150;
  const stSnap = await db.collection('stores').get();
  const locs = stSnap.docs.map(x => x.data()).filter(x => x.lat != null && x.lng != null);
  let nearest = Infinity;
  for (const st of locs) { const km = haversineKm({ lat, lng }, { lat: st.lat, lng: st.lng }); if (km < nearest) nearest = km; }
  const meters = nearest === Infinity ? null : Math.round(nearest * 1000);
  const wasInside = !!d.isInsideStoreGeofence;
  let inside = wasInside;
  if (meters != null) {
    if (!wasInside && meters <= radius) inside = true;              // entrou no raio
    else if (wasInside && meters > radius * 1.4) inside = false;    // histerese p/ não oscilar
  }
  if (d.manualAtStore) inside = true;                               // "cheguei na loja" manual manda no GPS
  const patch = { currentLocation: { lat, lng, at: now }, isInsideStoreGeofence: inside, distanceToStoreMeters: meters, updatedAt: now };
  if (inside && !wasInside) patch.arrivedAtStore = now;   // acabou de chegar -> entra na fila agora
  if (!inside && wasInside) patch.arrivedAtStore = null;  // saiu da loja -> sai da ordem
  await ref.set(patch, { merge: true });
  res.json({ ok: true, inside, distanceMeters: meters, hasStoreLocation: locs.length > 0, radius });
});
// rota atual do motoboy (com os pedidos)
app.get('/api/drivers/:id/route', async (req, res) => {
  const snap = await db.collection('routes').where('driverId', '==', req.params.id).limit(20).get();
  const active = snap.docs.map(d => d.data())
    .filter(r => ['sent_to_driver', 'accepted_by_driver', 'in_progress'].includes(r.status))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!active.length) return res.json(null);
  const route = active[0];
  const orderSnaps = await db.getAll(...(route.orders || []).map(id => db.collection('orders').doc(id)));
  route.orderDetails = orderSnaps.filter(s => s.exists).map(s => s.data());
  res.json(route);
});
// histórico do dia do motoboy
app.get('/api/drivers/:id/history', async (req, res) => {
  const snap = await db.collection('orders').where('assignedDriverId', '==', req.params.id).limit(100).get();
  const list = snap.docs.map(d => d.data()).filter(o => o.status === 'delivered')
    .sort((a, b) => ((a.deliveredAt || a.updatedAt) < (b.deliveredAt || b.updatedAt) ? 1 : -1)).slice(0, 30);
  res.json(list);
});

// ===================== CICLO DA ROTA (despacho -> entrega) =====================
async function setDriver(driverId, patch) { if (driverId) await db.collection('drivers').doc(driverId).set({ ...patch, updatedAt: nowIso() }, { merge: true }); }
// avaliação real do motoboy: aceita/recusa -> taxa de aceitação + nota (3.0 a 5.0)
async function bumpDriverStats(driverId, { accepted = 0, declined = 0 } = {}) {
  if (!driverId) return;
  const ref = db.collection('drivers').doc(driverId);
  const snap = await ref.get(); if (!snap.exists) return;
  const d = snap.data();
  const acc = (d.routesAccepted || 0) + accepted, dec = (d.routesDeclined || 0) + declined;
  const total = acc + dec;
  const acceptanceRate = total ? Math.round(acc / total * 100) : null;
  const rating = total ? Math.round((3 + (acc / total) * 2) * 10) / 10 : null; // 3.0..5.0
  await ref.set({ routesAccepted: acc, routesDeclined: dec, acceptanceRate, rating, updatedAt: nowIso() }, { merge: true });
}

// ordena a fila: quem está NA LOJA (geofence) primeiro, por ordem de chegada;
// depois os online que ainda não chegaram, por ordem de ficar online.
function atStore(d) { return !!(d.isInsideStoreGeofence || d.manualAtStore); }
function queueSort(a, b) {
  // 1) ordem MANUAL do operador (arrastar) vence tudo
  const aHas = a.queueOrder != null, bHas = b.queueOrder != null;
  if (aHas && bHas) return a.queueOrder - b.queueOrder;
  if (aHas !== bHas) return aHas ? -1 : 1;
  // 2) automático: quem está NA LOJA (geofence ou "cheguei" manual) primeiro, por ordem de chegada
  const ai = atStore(a) ? 0 : 1, bi = atStore(b) ? 0 : 1;
  if (ai !== bi) return ai - bi;
  const at = (ai === 0 ? a.arrivedAtStore : a.wentOnlineAt) || '';
  const bt = (bi === 0 ? b.arrivedAtStore : b.wentOnlineAt) || '';
  return at < bt ? -1 : 1;
}
async function queueList() {
  const snap = await db.collection('drivers').where('online', '==', true).get();
  return snap.docs.map(d => d.data()).filter(d => !d.activeRouteId)
    .map(d => ({ ...d, atStore: atStore(d) })).sort(queueSort);
}
// primeiro motoboy disponível na fila
async function firstInQueue() { const q = await queueList(); return q[0] || null; }
// atribui a rota a um motoboy (batch)
async function doAssign(routeId, driver, orderIds) {
  const now = nowIso(); const batch = db.batch();
  batch.set(db.collection('routes').doc(routeId), { driverId: driver.id, driverName: driver.name, status: 'sent_to_driver', assignedAt: now, updatedAt: now }, { merge: true });
  for (const oid of (orderIds || [])) batch.set(db.collection('orders').doc(oid), { assignedDriverId: driver.id, status: 'sent_to_driver', updatedAt: now }, { merge: true });
  batch.set(db.collection('drivers').doc(driver.id), { activeRouteId: routeId, status: 'route_suggested', queueOrder: null, manualAtStore: false, isInsideStoreGeofence: false, arrivedAtStore: null, updatedAt: now }, { merge: true });
  await batch.commit();
}

// operador despacha a rota para um motoboy
app.post('/api/routes/:id/assign', async (req, res) => {
  const driverId = req.body && req.body.driverId;
  if (!driverId) return err(res, 'INVALID', 400, 'Selecione um motoboy');
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const ds = await db.collection('drivers').doc(driverId).get();
  if (!ds.exists) return err(res, 'NOT_FOUND', 404, 'Motoboy não encontrado');
  const driver = ds.data(); const now = nowIso();
  const prevDriverId = rs.data().driverId || null;
  // se estava com outro motoboy (troca), libera o anterior
  if (prevDriverId && prevDriverId !== driverId) await setDriver(prevDriverId, { activeRouteId: null, status: 'online' });
  const batch = db.batch();
  batch.set(rref, { driverId, driverName: driver.name, status: 'sent_to_driver', assignedAt: now, updatedAt: now }, { merge: true });
  for (const oid of (rs.data().orders || [])) batch.set(db.collection('orders').doc(oid), { assignedDriverId: driverId, status: 'sent_to_driver', updatedAt: now }, { merge: true });
  batch.set(db.collection('drivers').doc(driverId), { activeRouteId: req.params.id, status: 'route_suggested', queueOrder: null, manualAtStore: false, isInsideStoreGeofence: false, arrivedAtStore: null, updatedAt: now }, { merge: true });
  await batch.commit();
  await log('route_assigned', 'operator', req.params.id, { driverId, prevDriverId, swap: !!(prevDriverId && prevDriverId !== driverId) });
  res.json((await rref.get()).data());
});
// despacha para o PRÓXIMO da fila (quem ficou disponível primeiro)
app.post('/api/routes/:id/assign-next', async (req, res) => {
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const driver = await firstInQueue();
  if (!driver) return err(res, 'NO_DRIVER', 409, 'Nenhum motoboy disponível na fila. Peça para um motoboy ficar online.');
  await doAssign(req.params.id, driver, rs.data().orders || []);
  await log('route_assigned_next', 'operator', req.params.id, { driverId: driver.id });
  res.json({ ...(await rref.get()).data(), assignedTo: driver.name });
});
// motoboy recusa a rota -> volta pro operador (pedidos voltam a "montada")
app.post('/api/routes/:id/decline', async (req, res) => {
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const route = rs.data(); const now = nowIso();
  const batch = db.batch();
  batch.set(rref, { status: 'approved', driverId: null, driverName: null, assignedAt: null, declinedAt: now, updatedAt: now }, { merge: true });
  for (const oid of (route.orders || [])) batch.set(db.collection('orders').doc(oid), { assignedDriverId: null, status: 'grouped', updatedAt: now }, { merge: true });
  await batch.commit();
  if (route.driverId) { await setDriver(route.driverId, { activeRouteId: null, status: 'online' }); await bumpDriverStats(route.driverId, { declined: 1 }); }
  await log('route_declined', route.driverId || 'driver', req.params.id, {});
  res.json({ ok: true });
});
// motoboy aceita
app.post('/api/routes/:id/accept', async (req, res) => {
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const now = nowIso();
  await rref.set({ status: 'accepted_by_driver', acceptedAt: now, updatedAt: now }, { merge: true });
  const batch = db.batch();
  for (const oid of (rs.data().orders || [])) batch.set(db.collection('orders').doc(oid), { status: 'accepted_by_driver', updatedAt: now }, { merge: true });
  await batch.commit();
  await setDriver(rs.data().driverId, { status: 'route_accepted' });
  await bumpDriverStats(rs.data().driverId, { accepted: 1 });
  res.json((await rref.get()).data());
});
// motoboy sai para entrega
app.post('/api/routes/:id/start', async (req, res) => {
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const now = nowIso();
  const orderIds = rs.data().orders || [];
  const orderSnaps = await db.getAll(...orderIds.map(id => db.collection('orders').doc(id)));
  await rref.set({ status: 'in_progress', startedAt: now, updatedAt: now }, { merge: true });
  const batch = db.batch();
  for (const oid of orderIds) batch.set(db.collection('orders').doc(oid), { status: 'out_for_delivery', outForDeliveryAt: now, updatedAt: now }, { merge: true });
  await batch.commit();
  await setDriver(rs.data().driverId, { status: 'delivering' });
  // avisa o Cardápio Web que saiu para entrega
  for (const s of orderSnaps) if (s.exists) await pushCwStatus(s.data(), 'ready');
  res.json((await rref.get()).data());
});
// motoboy marca um pedido entregue; se todos entregues, finaliza a rota
app.post('/api/routes/:id/complete-order', async (req, res) => {
  const orderId = req.body && req.body.orderId;
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const route = rs.data(); const now = nowIso();
  const oref = db.collection('orders').doc(orderId);
  await oref.set({ status: 'delivered', deliveredAt: now, updatedAt: now }, { merge: true });
  await pushCwStatus((await oref.get()).data(), 'delivered'); // avisa o Cardápio Web
  const snaps = await db.getAll(...(route.orders || []).map(id => db.collection('orders').doc(id)));
  const allDone = snaps.every(s => s.exists && s.data().status === 'delivered');
  if (allDone) {
    await rref.set({ status: 'finished', finishedAt: now, updatedAt: now }, { merge: true });
    const delivered = (route.orders || []).length;
    if (route.driverId) { const d = (await db.collection('drivers').doc(route.driverId).get()).data() || {}; await setDriver(route.driverId, { activeRouteId: null, status: 'online', todayDeliveries: (d.todayDeliveries || 0) + delivered }); }
  }
  res.json({ ok: true, allDone });
});
// motoboy finaliza a rota (entrega o que faltar)
app.post('/api/routes/:id/finish', async (req, res) => {
  const rref = db.collection('routes').doc(req.params.id);
  const rs = await rref.get(); if (!rs.exists) return err(res, 'NOT_FOUND', 404, 'Rota não encontrada');
  const route = rs.data(); const now = nowIso();
  const orderSnaps = await db.getAll(...(route.orders || []).map(id => db.collection('orders').doc(id)));
  const batch = db.batch();
  for (const oid of (route.orders || [])) batch.set(db.collection('orders').doc(oid), { status: 'delivered', deliveredAt: now, updatedAt: now }, { merge: true });
  batch.set(rref, { status: 'finished', finishedAt: now, updatedAt: now }, { merge: true });
  await batch.commit();
  if (route.driverId) { const d = (await db.collection('drivers').doc(route.driverId).get()).data() || {}; await setDriver(route.driverId, { activeRouteId: null, status: 'online', todayDeliveries: (d.todayDeliveries || 0) + (route.orders || []).length }); }
  // avisa o Cardápio Web dos que ainda não estavam entregues
  for (const s of orderSnaps) if (s.exists && s.data().status !== 'delivered') await pushCwStatus(s.data(), 'delivered');
  res.json((await rref.get()).data());
});

// ===================== FINANCEIRO (taxas dos motoboys por dia) =====================
function dayKeyBR(iso) { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); } catch (e) { return String(iso || '').slice(0, 10); } }
app.get('/api/finance/driver-fees', async (_req, res) => {
  const s = await getSettings(); const fallback = Number(s.deliveryFeePerOrder) || 5;
  // diária por motoboy que entregou no dia — varia por dia da semana
  const rateWeekday = Number(s.driverDailyRateWeekday != null ? s.driverDailyRateWeekday : 45) || 0; // seg a qui
  const rateWeekend = Number(s.driverDailyRateWeekend != null ? s.driverDailyRateWeekend : 55) || 0; // sex, sáb, dom
  const dailyRateFor = (dayKey) => {
    const p = String(dayKey).split('-'); const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    const wd = dt.getDay(); // 0=dom,1=seg,...,5=sex,6=sáb
    return (wd === 5 || wd === 6 || wd === 0) ? rateWeekend : rateWeekday;
  };
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const drv = {}; (await db.collection('drivers').get()).docs.forEach(d => { const x = d.data(); drv[x.id] = x.name; });
  const snap = await db.collection('orders').where('status', '==', 'delivered').limit(2000).get();
  const days = {};
  snap.docs.forEach(doc => {
    // agrupa pelo dia de CHEGADA do pedido (createdAt), não pelo de conclusão —
    // um pedido que chega perto da meia-noite conta no dia em que entrou.
    const o = doc.data(); const when = o.createdAt || o.deliveredAt || o.updatedAt; if (!when) return;
    const day = dayKeyBR(when);
    const fee = (Number(o.deliveryFee) > 0) ? Number(o.deliveryFee) : fallback;
    const did = o.assignedDriverId || null;
    const D = days[day] = days[day] || { day, count: 0, feesTotal: 0, byDriver: {}, unassignedCount: 0, unassignedFees: 0 };
    // pedidos sem motoboy não entram no pagamento (só informativo)
    if (!did) { D.unassignedCount += 1; D.unassignedFees += fee; return; }
    D.count += 1; D.feesTotal += fee;
    const B = D.byDriver[did] = D.byDriver[did] || { driverId: did, name: drv[did] || '(motoboy removido)', fees: 0, count: 0 };
    B.fees += fee; B.count += 1;
  });
  const list = Object.values(days).map(d => {
    const dailyRate = dailyRateFor(d.day);
    const byDriver = Object.values(d.byDriver).map(b => ({
      driverId: b.driverId, name: b.name, count: b.count,
      fees: r2(b.fees), daily: dailyRate, total: r2(b.fees + dailyRate),
    })).sort((a, b) => b.total - a.total);
    const total = r2(byDriver.reduce((acc, b) => acc + b.total, 0));
    return {
      day: d.day, total, count: d.count, dailyRate, driversCount: byDriver.length, byDriver,
      feesTotal: r2(d.feesTotal), dailyTotal: r2(byDriver.length * dailyRate),
      unassignedCount: d.unassignedCount, unassignedFees: r2(d.unassignedFees),
    };
  }).sort((a, b) => (a.day < b.day ? 1 : -1));
  res.json(list);
});

// ===================== MÉTRICAS / PERFORMANCE =====================
app.get('/api/metrics', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
  const s = await getSettings();
  const maxDeliv = Number(s.defaultMaxDeliveryTimeMinutes) || 45;
  const nowMs = Date.now(), dayMs = 86400000;
  const curStart = nowMs - days * dayMs, prevStart = nowMs - 2 * days * dayMs;
  const msOf = (iso) => { const t = Date.parse(iso || ''); return isNaN(t) ? null : t; };
  const inWin = (iso, a, b) => { const t = msOf(iso); return t != null && t >= a && t < b; };
  const diffMin = (a, b) => { const ta = msOf(a), tb = msOf(b); if (ta == null || tb == null) return null; const m = (tb - ta) / 60000; return m >= 0 ? m : null; };
  const avg = (arr) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;

  const [ordersSnap, routesSnap, driversSnap, storesSnap] = await Promise.all([
    db.collection('orders').limit(5000).get(),
    db.collection('routes').limit(4000).get(),
    db.collection('drivers').get(),
    db.collection('stores').get(),
  ]);
  const orders = ordersSnap.docs.map(d => d.data());
  const routes = routesSnap.docs.map(d => d.data());
  const drvName = {}; driversSnap.docs.forEach(d => { const x = d.data(); drvName[x.id] = x.name; });
  const stores = storesSnap.docs.map(d => d.data());
  const routeById = {}; routes.forEach(r => routeById[r.id] = r);
  const rCount = (r) => r.orderCount || (r.orders || []).length;
  const outTime = (o) => o.outForDeliveryAt || (o.assignedRouteId && routeById[o.assignedRouteId] && routeById[o.assignedRouteId].startedAt) || null;
  const delta = (c, p, invert) => { if (c == null || p == null || p === 0) return null; const d = (c - p) / p * 100; return Math.round((invert ? -d : d) * 10) / 10; };
  const pp = (c, p) => (c == null || p == null) ? null : Math.round((c - p) * 10) / 10;

  function kpiFor(a, b) {
    const created = orders.filter(o => inWin(o.createdAt, a, b));
    const deliv = orders.filter(o => o.status === 'delivered' && inWin(o.deliveredAt || o.updatedAt, a, b));
    const rts = routes.filter(r => inWin(r.createdAt, a, b));
    const grouped = rts.filter(r => rCount(r) >= 2).length, excs = rts.filter(r => rCount(r) === 1).length;
    const dc = Math.max(1, Math.round((b - a) / dayMs));
    return {
      ordersPerDay: created.length / dc,
      avgPrep: avg(deliv.map(o => diffMin(o.preparingAt, o.readyAt)).filter(x => x != null)),
      avgReadyOut: avg(deliv.map(o => diffMin(o.readyAt, outTime(o))).filter(x => x != null)),
      avgTotal: avg(deliv.map(o => diffMin(o.createdAt, o.deliveredAt)).filter(x => x != null)),
      groupingRate: rts.length ? grouped / rts.length * 100 : null,
      exceptionRate: rts.length ? excs / rts.length * 100 : null,
    };
  }
  const cur = kpiFor(curStart, nowMs), prev = kpiFor(prevStart, curStart);

  // séries por dia (BR)
  const dayKeys = []; for (let i = days - 1; i >= 0; i--) dayKeys.push(dayKeyBR(new Date(nowMs - i * dayMs).toISOString()));
  const dayIndex = {}; dayKeys.forEach((k, i) => dayIndex[k] = i);
  const sp = { orders: Array(days).fill(0), prep: dayKeys.map(() => []), readyOut: dayKeys.map(() => []), total: dayKeys.map(() => []), grp: dayKeys.map(() => ({ g: 0, e: 0, n: 0 })) };
  orders.forEach(o => { const i = dayIndex[dayKeyBR(o.createdAt)]; if (i != null) sp.orders[i]++; });
  orders.filter(o => o.status === 'delivered').forEach(o => {
    const i = dayIndex[dayKeyBR(o.deliveredAt || o.updatedAt)]; if (i == null) return;
    const p = diffMin(o.preparingAt, o.readyAt); if (p != null) sp.prep[i].push(p);
    const t = diffMin(o.createdAt, o.deliveredAt); if (t != null) sp.total[i].push(t);
    const ro = diffMin(o.readyAt, outTime(o)); if (ro != null) sp.readyOut[i].push(ro);
  });
  routes.forEach(r => { const i = dayIndex[dayKeyBR(r.createdAt)]; if (i == null) return; sp.grp[i].n++; if (rCount(r) >= 2) sp.grp[i].g++; if (rCount(r) === 1) sp.grp[i].e++; });
  const sMean = (arr) => arr.map(a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const sparklines = {
    ordersPerDay: sp.orders, avgPrep: sMean(sp.prep), avgReadyOut: sMean(sp.readyOut), avgTotal: sMean(sp.total),
    groupingRate: sp.grp.map(a => a.n ? Math.round(a.g / a.n * 100) : 0),
    exceptionRate: sp.grp.map(a => a.n ? Math.round(a.e / a.n * 100) : 0),
  };
  const ordersPerDaySeries = dayKeys.map((k, i) => ({ day: k, count: sp.orders[i] }));

  // conjuntos do período atual
  const delivCur = orders.filter(o => o.status === 'delivered' && inWin(o.deliveredAt || o.updatedAt, curStart, nowMs));
  const rtsCur = routes.filter(r => inWin(r.createdAt, curStart, nowMs));

  // entregas por motoboy
  const bd = {}; delivCur.forEach(o => { if (!o.assignedDriverId) return; bd[o.assignedDriverId] = (bd[o.assignedDriverId] || 0) + 1; });
  const byDriver = Object.entries(bd).map(([id, c]) => ({ name: drvName[id] || '(removido)', count: c })).sort((a, b) => b.count - a.count).slice(0, 7);

  // rotas por quantidade
  const two = rtsCur.filter(r => rCount(r) === 2).length, three = rtsCur.filter(r => rCount(r) >= 3).length;

  // gargalo por horário
  let brHour; try { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false, hourCycle: 'h23' }); brHour = (t) => Number(f.format(new Date(t))); } catch (e) { brHour = (t) => new Date(t).getUTCHours(); }
  const hAgg = {}; for (let h = 0; h < 24; h++) hAgg[h] = { sum: 0, n: 0 };
  delivCur.forEach(o => { const t = msOf(o.createdAt); const m = diffMin(o.createdAt, o.deliveredAt); if (t != null && m != null) { const h = brHour(t); hAgg[h].sum += m; hAgg[h].n++; } });
  const bottleneck = []; for (let h = 0; h < 24; h++) bottleneck.push({ hour: h, avg: hAgg[h].n ? Math.round(hAgg[h].sum / hAgg[h].n) : 0, count: hAgg[h].n });

  // atrasos por bairro
  const hoodAgg = {};
  delivCur.forEach(o => { const b = (o.address && o.address.neighborhood) || '—'; const m = diffMin(o.createdAt, o.deliveredAt); const A = hoodAgg[b] = hoodAgg[b] || { hood: b, orders: 0, delays: 0, delaySum: 0 }; A.orders++; if (m != null && m > maxDeliv) { A.delays++; A.delaySum += (m - maxDeliv); } });
  const delaysByHood = Object.values(hoodAgg).map(a => ({ hood: a.hood, orders: a.orders, delays: a.delays, pct: a.orders ? Math.round(a.delays / a.orders * 100) : 0, avgDelay: a.delays ? Math.round(a.delaySum / a.delays) : 0 })).sort((a, b) => b.delays - a.delays || b.pct - a.pct).slice(0, 8);

  // comparativo por loja
  function storeStats(name, a, b) {
    const os = orders.filter(o => o.storeName === name);
    const created = os.filter(o => inWin(o.createdAt, a, b));
    const deliv = os.filter(o => o.status === 'delivered' && inWin(o.deliveredAt || o.updatedAt, a, b));
    const rts = routes.filter(r => inWin(r.createdAt, a, b) && Array.isArray(r.stores) && r.stores.includes(name));
    const grouped = rts.filter(r => rCount(r) >= 2).length, excs = rts.filter(r => rCount(r) === 1).length;
    return { orders: created.length, avgPrep: avg(deliv.map(o => diffMin(o.preparingAt, o.readyAt)).filter(x => x != null)), avgDeliv: avg(deliv.map(o => diffMin(o.createdAt, o.deliveredAt)).filter(x => x != null)), groupingRate: rts.length ? grouped / rts.length * 100 : null, exceptionRate: rts.length ? excs / rts.length * 100 : null };
  }
  const byStore = stores.map(st => {
    const c = storeStats(st.name, curStart, nowMs), p = storeStats(st.name, prevStart, curStart);
    return {
      name: st.name, type: st.type || 'Cardápio Web', active: st.active !== false, logoUrl: st.logoUrl || null,
      orders: c.orders, ordersDelta: delta(c.orders, p.orders),
      avgPrep: c.avgPrep != null ? Math.round(c.avgPrep) : null, avgPrepDelta: delta(c.avgPrep, p.avgPrep, true),
      avgDeliv: c.avgDeliv != null ? Math.round(c.avgDeliv) : null, avgDelivDelta: delta(c.avgDeliv, p.avgDeliv, true),
      groupingRate: c.groupingRate != null ? Math.round(c.groupingRate) : null, groupingDelta: pp(c.groupingRate, p.groupingRate),
      exceptionRate: c.exceptionRate != null ? Math.round(c.exceptionRate) : null, exceptionDelta: pp(c.exceptionRate, p.exceptionRate),
    };
  }).sort((a, b) => b.orders - a.orders);

  res.json({
    days, generatedAt: nowIso(), deliveryTargetMin: maxDeliv,
    kpis: {
      ordersPerDay: { value: Math.round(cur.ordersPerDay), delta: delta(cur.ordersPerDay, prev.ordersPerDay), unit: '', goodDown: false },
      avgPrep: { value: cur.avgPrep != null ? Math.round(cur.avgPrep) : null, delta: delta(cur.avgPrep, prev.avgPrep), unit: 'min', goodDown: true },
      avgReadyOut: { value: cur.avgReadyOut != null ? Math.round(cur.avgReadyOut) : null, delta: delta(cur.avgReadyOut, prev.avgReadyOut), unit: 'min', goodDown: true },
      avgTotal: { value: cur.avgTotal != null ? Math.round(cur.avgTotal) : null, delta: delta(cur.avgTotal, prev.avgTotal), unit: 'min', goodDown: true },
      groupingRate: { value: cur.groupingRate != null ? Math.round(cur.groupingRate) : null, delta: pp(cur.groupingRate, prev.groupingRate), unit: '%', deltaPp: true, goodDown: false },
      exceptionRate: { value: cur.exceptionRate != null ? Math.round(cur.exceptionRate) : null, delta: pp(cur.exceptionRate, prev.exceptionRate), unit: '%', deltaPp: true, goodDown: true },
    },
    sparklines, ordersPerDaySeries, byDriver,
    routesBySize: { two, three, total: rtsCur.length },
    bottleneck, delaysByHood, byStore,
  });
});

// ===================== CONFIGURAÇÕES =====================
app.get('/api/settings', async (_req, res) => res.json(await getSettings()));
app.patch('/api/settings', async (req, res) => {
  await db.collection('settings').doc('logistics_settings').set(req.body || {}, { merge: true });
  res.json(await getSettings());
});

// ===================== CATCH-ALL =====================
// ============================================================
// ESTOQUE — Contagem diária + Listas de compras (módulo simples)
// Coleções: stock_products, stock_suppliers, stock_categories,
//           stock_counts, stock_lists
// ============================================================
const STOCK_UNITS = ['un','kg','g','l','cx','pct','fardo','galao','bandeja','saco','maco'];

// próximo dia de funcionamento: sex/sáb/dom => alvo de fim de semana
function stockNextIsWeekend(dayKey) {
  try {
    const base = new Date((dayKey || dayKeyBR(nowIso())) + 'T12:00:00-03:00');
    const nd = new Date(base.getTime() + 24 * 3600 * 1000);
    const wd = nd.getDay(); // 0 dom .. 6 sáb
    return wd === 5 || wd === 6 || wd === 0;
  } catch (e) { return false; }
}
function stockTargetFor(product, dayKey) {
  const weekend = stockNextIsWeekend(dayKey);
  const t = weekend ? product.weekendTarget : product.weekdayTarget;
  return Number(t) || 0;
}
function stockRoundPurchase(qty, product) {
  let q = Math.max(0, Number(qty) || 0);
  const pkg = Number(product.packageQuantity) || 0;
  if (product.purchaseMultiple && pkg > 0) q = Math.ceil(q / pkg) * pkg;
  return Math.round(q * 100) / 100;
}

async function resolveStockStores() {
  const snap = await db.collection('stores').get();
  const stores = snap.docs.map(d => d.data());
  const find = (kw) => { const s = stores.find(x => (x.name || '').toLowerCase().includes(kw)); return s ? s.id : null; };
  return { burger: find('burg') || 'burger', pizza: find('pizz') || 'pizza', stores };
}

// ---- Seed dos produtos das listas reais (Pizza FC e Burger FC) ----
const SEED_PIZZA = [
  ['Farinha','pct','Mercearia'],['Massa','kg','Mercearia'],['Molho de Tomate','un','Mercearia'],
  ['Ketchup','un','Mercearia'],['Maionese','un','Mercearia'],['Açúcar','kg','Mercearia'],
  ['Fermento','un','Mercearia'],['Óleo','un','Mercearia'],['Sal','kg','Mercearia'],
  ['Orégano','kg','Mercearia'],['Ovo','un','Mercearia'],['Gelo','un','Mercearia'],
  ['Mussarela','kg','Queijos'],['Cheddar','kg','Queijos'],['Catupiry com Amido','kg','Queijos'],
  ['Catupiry sem Amido','kg','Queijos'],['Parmesão','kg','Queijos'],['Provolone','kg','Queijos'],
  ['Carne de Costela','pct','Carnes'],['Carne Seca','pct','Carnes'],['Bacon','kg','Carnes'],
  ['Presunto','kg','Carnes'],['Calabresa','kg','Carnes'],['Frango','kg','Carnes'],
  ['Lombinho Canadense','kg','Carnes'],
  ['Cebola','kg','Hortifruti'],['Pimentão','kg','Hortifruti'],['Tomate','kg','Hortifruti'],
  ['Azeitona','kg','Hortifruti'],['Milho','kg','Hortifruti'],['Manjericão','maco','Hortifruti'],
  ['Cebola Crispy','kg','Hortifruti'],
  ['Caixa 25 cm','un','Embalagens'],['Caixa 35 cm','un','Embalagens'],
];
const SEED_BURGER = [
  ['Vasilha Carne de boi 120G','un','Carne e Pão'],['Vasilha Carne de boi 70G','un','Carne e Pão'],
  ['Vasilha Carne de boi Mini rodízio','un','Carne e Pão'],['Pão','un','Carne e Pão'],['Pão mini','un','Carne e Pão'],
  ['Alface','un','Sacolão'],['Salsinha','maco','Sacolão'],['Tomate','kg','Sacolão'],['Laranja','kg','Sacolão'],
  ['Limão','kg','Sacolão'],['Cebolinha','maco','Sacolão'],['Cebola roxa','kg','Sacolão'],
  ['Anéis de Cebola','un','Freezer'],['Batata','cx','Freezer'],['Empanado de Queijo','un','Freezer'],
  ['Sorvete','un','Freezer'],['Açaí','kg','Freezer'],['Morango congelado','kg','Freezer'],
  ['Barbecue Hermmer 1kg','un','Insumos hambúrguer'],['Catchup Heinz sachê','un','Insumos hambúrguer'],
  ['Maionese Heinz sachê','un','Insumos hambúrguer'],['Cheddar Cream','un','Insumos hambúrguer'],
  ['Catupiry','kg','Insumos hambúrguer'],['Cream cheese','un','Insumos hambúrguer'],
  ['Cheddar Fatiado','un','Insumos hambúrguer'],['Queijo prato','kg','Insumos hambúrguer'],
  ['Mussarela','kg','Insumos hambúrguer'],['Ovo','un','Insumos hambúrguer'],['Bacon','kg','Insumos hambúrguer'],
  ['Picles','un','Insumos hambúrguer'],['Pimenta jalapeño','un','Insumos hambúrguer'],
  ['Óleo de algodão','un','Insumos hambúrguer'],['Sal refinado sachê','un','Insumos hambúrguer'],
  ['Pimenta do reino','un','Molhos'],['Pó de bacon','un','Molhos'],['Tempero grill','un','Molhos'],
  ['Orégano','un','Molhos'],['Sal pacote 1Kg','pct','Molhos'],['Óleo de soja','un','Molhos'],
  ['Molho Chipotle Zafran','un','Molhos'],['Geléia de pimenta','un','Molhos'],
  ['Leite em pó','un','Doces'],['Ovomaltine','un','Doces'],['Chantilly','un','Doces'],
  ['Cobertura de chocolate','un','Doces'],['Charope de Morango soda','un','Doces'],
  ['Charope de maçã verde soda','un','Doces'],['Calda de frutas vermelhas','un','Doces'],
  ['Embalagem 5kg','un','Embalagens e Descartáveis'],['Embalagem 15Kg','un','Embalagens e Descartáveis'],
  ['Embalagem Batata Comum','un','Embalagens e Descartáveis'],['Emb Batata Cheddar 125g','un','Embalagens e Descartáveis'],
  ['Emb Batata Cheddar 250g','un','Embalagens e Descartáveis'],['Guardanapo','un','Embalagens e Descartáveis'],
  ['Papel toalha','un','Embalagens e Descartáveis'],
  ['Papel acoplado térmico laminado','un','Descartáveis'],['Papel acoplado comum para mesa','un','Descartáveis'],
  ['Caixa box','un','Descartáveis'],['Pote cheddar c/ tampa 250ml','un','Descartáveis'],
  ['Espeto de hambúrguer pequeno','un','Descartáveis'],['Espeto de hambúrguer grande','un','Descartáveis'],
  ['Copo 300ml','un','Descartáveis'],['Copo 550ml','un','Descartáveis'],['Canudo','un','Descartáveis'],
  ['Pote de molho','un','Descartáveis'],['Mini colher','un','Descartáveis'],['Barca','un','Descartáveis'],
  ['Lacre','un','Descartáveis'],['Filme de pvc esticável','un','Descartáveis'],['Gás para maçarico','un','Descartáveis'],
  ['Touca','un','Descartáveis'],['Vinagre de molho','un','Descartáveis'],['Gás para a chapa','un','Descartáveis'],
  ['Água para colaboradores','un','Descartáveis'],
  ['Grampo para grampeador','un','Papelaria'],['Grampeador','un','Papelaria'],['Pincel','un','Papelaria'],
  ['Bobina maquininha','un','Papelaria'],['Bobina impressora','un','Papelaria'],['Durex','un','Papelaria'],
  ['Papel higiênico','un','Higiene e Limpeza'],['Veja','un','Higiene e Limpeza'],['Detergente','un','Higiene e Limpeza'],
  ['Pano multiuso rolo','un','Higiene e Limpeza'],['Saco para lixo 100L','un','Higiene e Limpeza'],
  ['Saco para lixo 200L','un','Higiene e Limpeza'],['Álcool em gel','un','Higiene e Limpeza'],
  ['Coca-Cola 2L','un','Bebidas'],['Coca-Cola Lata','un','Bebidas'],['Coca-Cola Lata Zero','un','Bebidas'],
  ['Guaraná 2L','un','Bebidas'],['Kuat 2L','un','Bebidas'],['Guaraná ou Matecouro 1L','un','Bebidas'],
  ['Guaraná Lata','un','Bebidas'],['Água com gás','un','Bebidas'],['Água','un','Bebidas'],
  ['Suco DelValle Uva','un','Bebidas'],['Suco DelValle Pêssego','un','Bebidas'],
];
const PIZZA_CAT_ORDER = ['Queijos','Carnes','Hortifruti','Mercearia','Embalagens'];
const BURGER_CAT_ORDER = ['Carne e Pão','Sacolão','Freezer','Insumos hambúrguer','Molhos','Doces','Embalagens e Descartáveis','Descartáveis','Papelaria','Higiene e Limpeza','Bebidas'];

let stockSeeded = false;
async function stockSeedIfEmpty() {
  if (stockSeeded) return;
  const c = await db.collection('stock_products').limit(1).get();
  if (!c.empty) { stockSeeded = true; return; }
  const { burger, pizza } = await resolveStockStores();
  const batch = db.batch();
  const now = nowIso();
  const mk = (storeId, arr) => arr.forEach(([name, unit, category], i) => {
    const id = 'sp_' + randHex(6);
    batch.set(db.collection('stock_products').doc(id), {
      id, storeId, name, unit, category, weekdayTarget: 0, weekendTarget: 0,
      packageQuantity: 0, purchaseMultiple: false, supplierId: null,
      storageLocation: '', displayOrder: i, notes: '', imageUrl: '', active: true,
      lastCounted: null, lastCountedAt: null, createdAt: now, updatedAt: now,
    });
  });
  mk(pizza, SEED_PIZZA); mk(burger, SEED_BURGER);
  const mkcats = (storeId, order) => order.forEach((name, i) => {
    const id = 'sc_' + randHex(5);
    batch.set(db.collection('stock_categories').doc(id), { id, storeId, name, displayOrder: i, createdAt: now });
  });
  mkcats(pizza, PIZZA_CAT_ORDER); mkcats(burger, BURGER_CAT_ORDER);
  await batch.commit();
  stockSeeded = true;
}
app.post('/api/stock/seed', async (_req, res) => { stockSeeded = false; await stockSeedIfEmpty(); res.json({ ok: true }); });

// ---------- Produtos ----------
app.get('/api/stock/products', async (req, res) => {
  await stockSeedIfEmpty();
  const snap = await db.collection('stock_products').get();
  let list = snap.docs.map(d => d.data());
  if (req.query.store) list = list.filter(p => p.storeId === req.query.store);
  if (req.query.active === 'true') list = list.filter(p => p.active !== false);
  list.sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.displayOrder || 0) - (b.displayOrder || 0) || (a.name > b.name ? 1 : -1));
  res.json(list);
});
app.post('/api/stock/products', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.storeId) return err(res, 'INVALID', 400, 'Nome e loja são obrigatórios');
  const id = 'sp_' + randHex(6); const now = nowIso();
  const p = {
    id, storeId: b.storeId, name: b.name, unit: b.unit || 'un', category: b.category || 'Geral',
    weekdayTarget: Number(b.weekdayTarget) || 0, weekendTarget: Number(b.weekendTarget) || 0,
    packageQuantity: Number(b.packageQuantity) || 0, purchaseMultiple: !!b.purchaseMultiple,
    supplierId: b.supplierId || null, storageLocation: b.storageLocation || '',
    displayOrder: Number(b.displayOrder) || 0, notes: b.notes || '', imageUrl: b.imageUrl || '',
    active: b.active !== false, lastCounted: null, lastCountedAt: null, createdAt: now, updatedAt: now,
  };
  await db.collection('stock_products').doc(id).set(p);
  res.status(201).json(p);
});
app.patch('/api/stock/products/:id', async (req, res) => {
  const ref = db.collection('stock_products').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Produto não encontrado');
  const patch = { ...req.body, updatedAt: nowIso() }; delete patch.id;
  ['weekdayTarget', 'weekendTarget', 'packageQuantity', 'displayOrder'].forEach(k => { if (patch[k] != null) patch[k] = Number(patch[k]) || 0; });
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
app.delete('/api/stock/products/:id', async (req, res) => {
  await db.collection('stock_products').doc(req.params.id).delete();
  res.json({ deleted: true });
});

// ---------- Categorias ----------
app.get('/api/stock/categories', async (req, res) => {
  await stockSeedIfEmpty();
  const snap = await db.collection('stock_categories').get();
  let list = snap.docs.map(d => d.data());
  if (req.query.store) list = list.filter(c => c.storeId === req.query.store);
  list.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0) || (a.name > b.name ? 1 : -1));
  res.json(list);
});
app.post('/api/stock/categories', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.storeId) return err(res, 'INVALID', 400, 'Nome e loja são obrigatórios');
  const id = 'sc_' + randHex(5);
  const c = { id, storeId: b.storeId, name: b.name, displayOrder: Number(b.displayOrder) || 0, createdAt: nowIso() };
  await db.collection('stock_categories').doc(id).set(c);
  res.status(201).json(c);
});
app.patch('/api/stock/categories/:id', async (req, res) => {
  const ref = db.collection('stock_categories').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Categoria não encontrada');
  const patch = { ...req.body }; delete patch.id; if (patch.displayOrder != null) patch.displayOrder = Number(patch.displayOrder) || 0;
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
app.delete('/api/stock/categories/:id', async (req, res) => {
  await db.collection('stock_categories').doc(req.params.id).delete();
  res.json({ deleted: true });
});

// ---------- Fornecedores ----------
app.get('/api/stock/suppliers', async (req, res) => {
  const snap = await db.collection('stock_suppliers').get();
  let list = snap.docs.map(d => d.data());
  if (req.query.store) list = list.filter(s => !s.storeId || s.storeId === req.query.store);
  list.sort((a, b) => (a.name > b.name ? 1 : -1));
  res.json(list);
});
app.post('/api/stock/suppliers', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return err(res, 'INVALID', 400, 'Nome é obrigatório');
  const id = 'sup_' + randHex(6); const now = nowIso();
  const s = {
    id, storeId: b.storeId || null, name: b.name, contactName: b.contactName || '',
    phone: b.phone || '', whatsapp: b.whatsapp || '', orderDays: b.orderDays || [],
    orderDeadline: b.orderDeadline || '', deliveryDays: b.deliveryDays || [],
    notes: b.notes || '', active: b.active !== false, createdAt: now,
  };
  await db.collection('stock_suppliers').doc(id).set(s);
  res.status(201).json(s);
});
app.patch('/api/stock/suppliers/:id', async (req, res) => {
  const ref = db.collection('stock_suppliers').doc(req.params.id);
  if (!(await ref.get()).exists) return err(res, 'NOT_FOUND', 404, 'Fornecedor não encontrado');
  const patch = { ...req.body }; delete patch.id;
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
app.delete('/api/stock/suppliers/:id', async (req, res) => {
  await db.collection('stock_suppliers').doc(req.params.id).delete();
  res.json({ deleted: true });
});

// ---------- Contagem ----------
async function stockGetCount(storeId, day) {
  const snap = await db.collection('stock_counts').where('storeId', '==', storeId).where('dayKey', '==', day).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}
app.post('/api/stock/counts/open', async (req, res) => {
  const b = req.body || {};
  const storeId = b.storeId; const day = b.day || dayKeyBR(nowIso());
  if (!storeId) return err(res, 'INVALID', 400, 'Loja é obrigatória');
  const existing = await stockGetCount(storeId, day);
  if (existing) return res.json(existing);
  const id = 'cnt_' + randHex(6); const now = nowIso();
  const doc = {
    id, storeId, dayKey: day, status: 'draft', startedBy: b.by || '', startedAt: now,
    finishedBy: null, finishedAt: null, counts: {}, notes: '', listId: null, createdAt: now, updatedAt: now,
  };
  await db.collection('stock_counts').doc(id).set(doc);
  res.status(201).json(doc);
});
app.get('/api/stock/counts/history', async (req, res) => {
  const snap = await db.collection('stock_counts').limit(400).get();
  let list = snap.docs.map(d => d.data());
  if (req.query.store) list = list.filter(c => c.storeId === req.query.store);
  list.sort((a, b) => ((a.startedAt || '') < (b.startedAt || '') ? 1 : -1));
  res.json(list.slice(0, 120));
});
app.get('/api/stock/counts/:id', async (req, res) => {
  const snap = await db.collection('stock_counts').doc(req.params.id).get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Contagem não encontrada');
  res.json(snap.data());
});
app.patch('/api/stock/counts/:id', async (req, res) => {
  const ref = db.collection('stock_counts').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Contagem não encontrada');
  if (snap.data().status === 'finalized') return err(res, 'LOCKED', 409, 'Contagem já finalizada');
  const b = req.body || {};
  const patch = { updatedAt: nowIso() };
  if (b.counts && typeof b.counts === 'object') patch.counts = { ...snap.data().counts, ...b.counts };
  if (b.notes != null) patch.notes = b.notes;
  if (b.by) patch.startedBy = snap.data().startedBy || b.by;
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});

async function stockGenerateList(cnt, opts) {
  opts = opts || {};
  const mode = opts.uncountedMode || 'zero'; // zero | keep | ignore
  const psnap = await db.collection('stock_products').where('storeId', '==', cnt.storeId).get();
  const products = psnap.docs.map(d => d.data()).filter(p => p.active !== false);
  const now = nowIso();
  const items = [];
  const prodUpdates = db.batch();
  for (const p of products) {
    const raw = cnt.counts && cnt.counts[p.id];
    let counted = raw && raw.qty != null ? Number(raw.qty) : null;
    const uncounted = counted == null;
    if (uncounted) {
      if (mode === 'ignore') continue;
      counted = mode === 'keep' ? (Number(p.lastCounted) || 0) : 0;
    }
    const target = stockTargetFor(p, cnt.dayKey);
    const suggested = stockRoundPurchase(Math.max(0, target - counted), p);
    // guarda última contagem física como oficial
    if (!uncounted) prodUpdates.set(db.collection('stock_products').doc(p.id), { lastCounted: counted, lastCountedAt: now, updatedAt: now }, { merge: true });
    items.push({
      productId: p.id, name: p.name, unit: p.unit, category: p.category || 'Geral',
      supplierId: p.supplierId || null, counted, target, suggested, final: suggested,
      manuallyEdited: false, uncounted, notes: (raw && raw.notes) || '',
    });
  }
  try { await prodUpdates.commit(); } catch (e) {}
  // uma lista por contagem: cria ou substitui
  let listId = cnt.listId;
  if (!listId) listId = 'lst_' + randHex(6);
  const list = {
    id: listId, storeId: cnt.storeId, stockCountId: cnt.id, dayKey: cnt.dayKey,
    status: 'draft', items, createdBy: opts.by || cnt.finishedBy || '', finalizedBy: null,
    createdAt: now, finalizedAt: null, notes: '',
  };
  await db.collection('stock_lists').doc(listId).set(list);
  await db.collection('stock_counts').doc(cnt.id).set({ listId, updatedAt: now }, { merge: true });
  return list;
}
app.post('/api/stock/counts/:id/finalize', async (req, res) => {
  const ref = db.collection('stock_counts').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Contagem não encontrada');
  const cnt = snap.data();
  const b = req.body || {};
  await ref.set({ status: 'finalized', finishedBy: b.by || cnt.finishedBy || '', finishedAt: nowIso(), notes: b.notes != null ? b.notes : cnt.notes, updatedAt: nowIso() }, { merge: true });
  const fresh = (await ref.get()).data();
  const list = await stockGenerateList(fresh, { uncountedMode: b.uncountedMode || 'zero', by: b.by });
  res.json({ count: (await ref.get()).data(), list });
});

// ---------- Listas de compras ----------
app.get('/api/stock/lists/history', async (req, res) => {
  const snap = await db.collection('stock_lists').limit(400).get();
  let list = snap.docs.map(d => d.data());
  if (req.query.store) list = list.filter(l => l.storeId === req.query.store);
  list.sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
  res.json(list.slice(0, 120).map(l => ({ ...l, items: undefined, itemCount: (l.items || []).length })));
});
app.get('/api/stock/lists/:id', async (req, res) => {
  const snap = await db.collection('stock_lists').doc(req.params.id).get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Lista não encontrada');
  res.json(snap.data());
});
app.patch('/api/stock/lists/:id', async (req, res) => {
  const ref = db.collection('stock_lists').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Lista não encontrada');
  if (snap.data().status === 'finalized' && !req.body._allowLocked) return err(res, 'LOCKED', 409, 'Lista finalizada não pode ser alterada. Duplique para corrigir.');
  const b = req.body || {}; const patch = { updatedAt: nowIso() };
  if (Array.isArray(b.items)) patch.items = b.items;
  if (b.status) { patch.status = b.status; if (b.status === 'finalized') { patch.finalizedAt = nowIso(); patch.finalizedBy = b.by || ''; } }
  if (b.notes != null) patch.notes = b.notes;
  await ref.set(patch, { merge: true });
  res.json((await ref.get()).data());
});
app.post('/api/stock/lists/:id/duplicate', async (req, res) => {
  const snap = await db.collection('stock_lists').doc(req.params.id).get();
  if (!snap.exists) return err(res, 'NOT_FOUND', 404, 'Lista não encontrada');
  const src = snap.data(); const id = 'lst_' + randHex(6); const now = nowIso();
  const copy = { ...src, id, status: 'draft', finalizedAt: null, finalizedBy: null, createdAt: now, notes: (src.notes || '') + ' (cópia)' };
  await db.collection('stock_lists').doc(id).set(copy);
  res.status(201).json(copy);
});
app.get('/api/stock/lists', async (req, res) => {
  const snap = await db.collection('stock_lists').limit(200).get();
  let list = snap.docs.map(d => d.data());
  if (req.query.store) list = list.filter(l => l.storeId === req.query.store);
  if (req.query.day) list = list.filter(l => l.dayKey === req.query.day);
  list.sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
  res.json(list);
});

// ---------- Dashboard do estoque ----------
app.get('/api/stock/dashboard', async (req, res) => {
  await stockSeedIfEmpty();
  const store = req.query.store; const day = dayKeyBR(nowIso());
  const [psnap, ssnap] = await Promise.all([
    db.collection('stock_products').get(),
    db.collection('stock_suppliers').get(),
  ]);
  let products = psnap.docs.map(d => d.data()).filter(p => p.active !== false);
  let suppliers = ssnap.docs.map(d => d.data());
  if (store) { products = products.filter(p => p.storeId === store); suppliers = suppliers.filter(s => !s.storeId || s.storeId === store); }
  const count = store ? await stockGetCount(store, day) : null;
  const lsnap = await db.collection('stock_lists').limit(200).get();
  let lists = lsnap.docs.map(d => d.data());
  if (store) lists = lists.filter(l => l.storeId === store);
  const listsToday = lists.filter(l => l.dayKey === day);
  const drafts = lists.filter(l => l.status === 'draft');
  const wdMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const todayWd = wdMap[new Date(day + 'T12:00:00-03:00').getDay()];
  const suppliersToday = suppliers.filter(s => Array.isArray(s.orderDays) && s.orderDays.includes(todayWd));
  res.json({
    day, countStatus: count ? count.status : 'pending', countPct: count ? Math.round(Object.keys(count.counts || {}).length / Math.max(1, products.length) * 100) : 0,
    countBy: count ? count.startedBy : null, productCount: products.length,
    listsToday: listsToday.length, drafts: drafts.length, suppliersToday: suppliersToday.map(s => ({ id: s.id, name: s.name })),
  });
});


// Captura qualquer POST não roteado (ex.: URL de webhook cadastrada errada, sem o
// caminho /api/webhooks/orders/:storeId). Responde 200 e registra p/ diagnóstico.
app.post('*', async (req, res) => {
  await captureRaw({ source:'unmatched', matched:false, note:`POST não roteado: ${req.originalUrl}`, req });
  res.status(200).json({ received:true, warning:'Esta URL não é o endpoint de webhook. Use /api/webhooks/orders/SEU-CARDAPIO?key=CHAVE (copie na tela Lojas).', path:req.originalUrl });
});

// registra o app sob os dois nomes de entrada possíveis
http('api', app);
http('helloHttp', app);
