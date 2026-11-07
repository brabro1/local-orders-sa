'use strict';
/*
 * Order pricing, shared by every function that creates or changes an order.
 * Pure: no Firestore, no clock. Same rules as the laundry demo (demos/laundry-pwa),
 * but prices come from the shop document and each order line keeps the price it was sold at.
 */

/** Index the shop catalog: item id -> { item, category }. */
function indexCatalog(shop) {
  const idx = {};
  for (const cat of shop.catalog || []) {
    for (const item of cat.items || []) idx[item.id] = { item, cat };
  }
  return idx;
}

/**
 * Turn what the client sent ([{ id, svc, qty }]) into priced order lines.
 * Throws a short reason code when something is not orderable.
 */
function priceLines(shop, raw, { allowPaused = false } = {}) {
  if (!Array.isArray(raw)) throw new Error('items');
  if (raw.length > 50) throw new Error('items-too-many');
  const idx = indexCatalog(shop);
  const paused = (shop.live && shop.live.dryClean === false) ? ['dry'] : [];
  const merged = new Map();
  for (const l of raw) {
    if (!l || typeof l.id !== 'string' || typeof l.svc !== 'string') throw new Error('items');
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new Error('qty');
    const hit = idx[l.id];
    const price = hit && hit.item.prices && hit.item.prices[l.svc];
    if (typeof price !== 'number' || price < 0) throw new Error('item-unknown');
    if (!allowPaused && paused.includes(l.svc)) throw new Error('service-paused');
    const key = `${l.id}|${l.svc}`;
    const prev = merged.get(key);
    if (prev) prev.qty = Math.min(99, prev.qty + qty);
    else merged.set(key, { id: l.id, svc: l.svc, qty, price, name: hit.item.name });
  }
  return [...merged.values()];
}

/**
 * Which pieces the customer's monthly plan pays for.
 * sub = { plan, left } from the customer document; returns { pieces, value } or null.
 */
function subCover(shop, items, sub) {
  if (!sub || !(sub.left > 0)) return null;
  const plan = (shop.plans || []).find(p => p.id === sub.plan);
  if (!plan) return null;
  const svcs = plan.svcs || ['wash', 'press'];
  const idx = indexCatalog(shop);
  let pieces = 0, value = 0;
  for (const l of items) {
    const hit = idx[l.id];
    if (!svcs.includes(l.svc) || (hit && hit.cat.planExcluded)) continue;
    const take = Math.min(l.qty, sub.left - pieces);
    if (take <= 0) break;
    pieces += take;
    value += take * l.price;
  }
  return pieces ? { pieces, value } : null;
}

/**
 * Totals for an order. o = { items, speed, method, firstOrder, perks: { subValue, subPieces, reward } }.
 * Every amount is a whole riyal, like the demo.
 */
function calc(shop, o) {
  const r = shop.rules || {};
  const items = o.items || [];
  const perks = o.perks || {};
  const sub = items.reduce((s, l) => s + l.price * l.qty, 0);
  const count = items.reduce((s, l) => s + l.qty, 0);
  const urgent = o.speed === 'urgent' ? Math.round(sub * (r.urgentRate || 0)) : 0;
  const base = sub + urgent;
  const delivery = o.method === 'pickup' && base > 0 && base < (r.freeOver || 0) ? (r.fee || 0) : 0;
  const discount = o.firstOrder && sub > 0 ? Math.min(r.firstOrderMax || 0, Math.round(sub * (r.firstOrderPct || 0))) : 0;
  const subFree = perks.subValue ? Math.min(perks.subValue, sub) : 0;
  const loyalty = perks.reward ? Math.min(r.stampReward || 0, Math.max(0, sub - subFree - discount)) : 0;
  return {
    sub, count, urgent, delivery, discount, subFree, subPieces: perks.subPieces || 0, loyalty,
    total: Math.max(0, base + delivery - discount - subFree - loyalty),
  };
}

/**
 * Apply the customer's plan and loyalty reward to an order whose items are known.
 * Mutates `customer` (sub.left, rewards) and returns the perks to store on the order.
 */
function applyPerks(shop, order, customer) {
  const perks = { subPieces: 0, subValue: 0, reward: false };
  if (!customer || !order.items || !order.items.length) return perks;
  const cv = subCover(shop, order.items, activeSub(customer.sub, order.today));
  if (cv) {
    perks.subPieces = cv.pieces;
    perks.subValue = cv.value;
    customer.sub.left -= cv.pieces;
  }
  if ((customer.rewards || 0) > 0 && calc(shop, { ...order, perks }).total > 0) {
    perks.reward = true;
    customer.rewards -= 1;
  }
  return perks;
}

/** Give back what an order took from the customer, so it can be recalculated or cancelled. */
function revertPerks(shop, perks, customer) {
  if (!customer || !perks) return;
  if (perks.subPieces && customer.sub) {
    const plan = (shop.plans || []).find(p => p.id === customer.sub.plan);
    const cap = plan ? plan.pieces : Infinity;
    customer.sub.left = Math.min(cap, customer.sub.left + perks.subPieces);
  }
  if (perks.reward) customer.rewards = (customer.rewards || 0) + 1;
}

/** A plan only counts until its renewal date (YYYY-MM-DD, Riyadh). */
function activeSub(sub, today) {
  if (!sub) return null;
  if (today && sub.renews && sub.renews < today) return null;
  return sub;
}

module.exports = { indexCatalog, priceLines, subCover, calc, applyPerks, revertPerks, activeSub };
