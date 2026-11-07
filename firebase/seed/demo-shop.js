'use strict';
/*
 * A made-up laundry for local testing. Prices are the demo's assumed prices, not a real shop's.
 * A real shop gets its own document with its own price list (never committed here: the repo is public).
 */
module.exports = {
  id: 'demo-laundry',
  /* emulator only. A real shop's PIN is set on the server and never written in the repo. */
  pin: '2468',
  shop: {
    name: 'مغسلة تجريبية',
    nameEn: 'Demo Laundry',
    phone: '0500000000',
    live: { open: true, dryClean: true, todaySlots: true },
    services: {
      wash: { ar: 'غسيل وكوي', en: 'Wash & press' },
      press: { ar: 'كوي فقط', en: 'Press only' },
      dry: { ar: 'تنظيف جاف', en: 'Dry clean' },
    },
    catalog: [
      { id: 'men', name: 'رجالي', en: 'Men', items: [
        { id: 'thobe', name: 'ثوب', en: 'Thobe', prices: { wash: 7, press: 4, dry: 12 } },
        { id: 'thobe-w', name: 'ثوب شتوي', en: 'Winter thobe', prices: { wash: 9, press: 5, dry: 15 } },
        { id: 'shmagh', name: 'شماغ / غترة', en: 'Shemagh / ghutra', prices: { wash: 5, press: 3, dry: 8 } },
        { id: 'bisht', name: 'بشت', en: 'Bisht', prices: { dry: 45 } },
        { id: 'suit', name: 'بدلة (قطعتان)', en: 'Suit (2 pcs)', prices: { press: 15, dry: 30 } },
        { id: 'shirt', name: 'قميص', en: 'Shirt', prices: { wash: 5, press: 3, dry: 9 } },
        { id: 'pants', name: 'بنطلون', en: 'Trousers', prices: { wash: 5, press: 3, dry: 9 } },
      ] },
      { id: 'women', name: 'نسائي', en: 'Women', items: [
        { id: 'abaya', name: 'عباءة', en: 'Abaya', prices: { wash: 12, press: 6, dry: 18 } },
        { id: 'dress', name: 'فستان يومي', en: 'Day dress', prices: { wash: 12, press: 7, dry: 20 } },
        { id: 'evening', name: 'فستان سهرة', en: 'Evening dress', prices: { dry: 60 } },
      ] },
      { id: 'kids', name: 'أطفال', en: 'Kids', items: [
        { id: 'kthobe', name: 'ثوب أطفال', en: 'Kids thobe', prices: { wash: 5, press: 3 } },
        { id: 'uniform', name: 'زي مدرسي (قطعتان)', en: 'School uniform (2 pcs)', prices: { wash: 8, press: 5 } },
      ] },
      /* monthly plans do not cover home linens */
      { id: 'home', name: 'مفروشات', en: 'Home linens', planExcluded: true, items: [
        { id: 'blanket1', name: 'بطانية مفرد', en: 'Single blanket', prices: { wash: 25 } },
        { id: 'blanket2', name: 'بطانية مزدوج', en: 'Double blanket', prices: { wash: 35 } },
        { id: 'sheet', name: 'شرشف سرير', en: 'Bed sheet', prices: { wash: 8, press: 5 } },
      ] },
    ],
    districts: [
      { ar: 'النرجس', en: 'Al Narjis' }, { ar: 'الياسمين', en: 'Al Yasmin' }, { ar: 'الملقا', en: 'Al Malqa' },
    ],
    slots: [
      { id: 'm', ar: '9–11 ص', en: '9–11 AM', start: 9 },
      { id: 'a', ar: '4–6 م', en: '4–6 PM', start: 16 },
      { id: 'e', ar: '6–8 م', en: '6–8 PM', start: 18 },
      { id: 'n', ar: '8–10 م', en: '8–10 PM', start: 20 },
    ],
    rules: {
      fee: 15, freeOver: 100, minPickup: 40, urgentRate: 0.5, slotCap: 3, bookDays: 3,
      firstOrderPct: 0.1, firstOrderMax: 20, stampGoal: 6, stampReward: 30, firstOrderNo: 1000,
    },
    plans: [
      { id: 'solo', name: { ar: 'باقة الأفراد', en: 'Solo plan' }, pieces: 30, price: 149 },
      { id: 'family', name: { ar: 'باقة العائلة', en: 'Family plan' }, pieces: 70, price: 299 },
      { id: 'press', name: { ar: 'باقة الكوي', en: 'Press plan' }, pieces: 40, price: 99, svcs: ['press'] },
    ],
    rejectReasons: [
      { ar: 'الحي خارج نطاق الاستلام', en: 'Area is outside our pickup zone' },
      { ar: 'لا يوجد مندوب في هذا الموعد', en: 'No driver available at that time' },
      { ar: 'الخدمة المطلوبة متوقفة اليوم', en: 'That service is paused today' },
      { ar: 'المغسلة مغلقة مؤقتًا', en: 'The laundry is temporarily closed' },
    ],
  },
};
