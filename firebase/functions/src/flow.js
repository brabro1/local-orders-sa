'use strict';
/*
 * Order status flow and Riyadh dates. Pure, like pricing.js.
 *
 * pickup  (customer orders a pickup from home): new → accepted → picking → counted → cleaning → ready → delivering → done
 * dropoff (customer brings items / in-store order): new → accepted → counted → cleaning → ready → done
 * Any order can end as rejected (by the shop) or cancelled (by the customer, only while it is new).
 */

const FLOW = {
  pickup: ['new', 'accepted', 'picking', 'counted', 'cleaning', 'ready', 'delivering', 'done'],
  dropoff: ['new', 'accepted', 'counted', 'cleaning', 'ready', 'done'],
};
const FINISHED = ['done', 'rejected', 'cancelled'];
/* after accepting, the shop may count (or re-count) the items until washing starts */
const COUNTABLE = ['accepted', 'picking', 'counted'];
/* the shop may decline an order until it has the items */
const REJECTABLE = ['new', 'accepted'];

/** The one status the shop may move this order to next, or null. */
function nextStatus(order) {
  const f = FLOW[order.method];
  if (!f) return null;
  const i = f.indexOf(order.status);
  if (i < 0 || i === f.length - 1) return null;
  return f[i + 1];
}

/** Saudi Arabia is UTC+3 all year (no daylight saving). */
const RIYADH_MS = 3 * 3600e3;

/** { date: 'YYYY-MM-DD', hour: 13.5 } in Riyadh for a timestamp in ms. */
function riyadhNow(ms) {
  const d = new Date(ms + RIYADH_MS);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hour: d.getUTCHours() + d.getUTCMinutes() / 60,
  };
}

/** Riyadh date `days` after the date of ms. */
function riyadhDate(ms, days = 0) {
  return riyadhNow(ms + days * 864e5).date;
}

/**
 * Why a pickup slot cannot be booked, or null if it can.
 * load = orders already booked in that slot.
 */
function slotProblem(shop, slotDate, slotId, load, nowMs) {
  const r = shop.rules || {};
  const live = shop.live || {};
  const slot = (shop.slots || []).find(s => s.id === slotId);
  if (!slot) return 'slot-unknown';
  const now = riyadhNow(nowMs);
  const days = r.bookDays || 3;
  const allowed = Array.from({ length: days }, (_, i) => riyadhDate(nowMs, i));
  if (!allowed.includes(slotDate)) return 'slot-date';
  /* "closed" and "today's pickups paused" only close today; customers can still book from tomorrow */
  if (slotDate === now.date) {
    if (live.open === false) return 'closed';
    if (live.todaySlots === false) return 'slot-paused';
    if (now.hour > slot.start - 1) return 'slot-past';
  }
  if (load >= (r.slotCap || 0)) return 'slot-full';
  return null;
}

/** Saudi mobile in any common form → E.164 (+9665XXXXXXXX), or null. */
function e164(phone) {
  let s = String(phone || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d+]/g, '');
  if (s.startsWith('+966')) s = s.slice(4);
  else if (s.startsWith('00966')) s = s.slice(5);
  else if (s.startsWith('966')) s = s.slice(3);
  else if (s.startsWith('0')) s = s.slice(1);
  return /^5\d{8}$/.test(s) ? `+966${s}` : null;
}

/** +9665XXXXXXXX → 05XXXXXXXX, for showing to staff. */
function localPhone(e) {
  return e ? `0${e.slice(4)}` : '';
}

module.exports = { FLOW, FINISHED, COUNTABLE, REJECTABLE, nextStatus, riyadhNow, riyadhDate, slotProblem, e164, localPhone };
