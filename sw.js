/* bik-dispatch service worker (card #376; its own origin since card #388).
 *
 * WHY ITS OWN ORIGIN, https://bik-dispatch.github.io/ (card #388, 2026-10-02):
 * served from bmh-almanac.github.io/dispatch/ it could never be installed as
 * its own app — bik-almanac's installed manifest has scope '/' on that
 * origin, so Chrome on his Fold handed every /dispatch/ link to bik-almanac.
 * A second GitHub org gives Dispatch its own address, its own install, its
 * own storage and key, and its own notifications and launcher badge.
 *
 * 1. Push attribution and the launcher badge belong to the registration that
 *    owns the subscription. Android draws the badge on the TOP RIGHT of an
 *    app's icon from that app's notifications still in the tray, and that
 *    badge is the warning Bryan asked for.
 *
 * 2. Every cache key this worker makes starts 'almanac-dispatch-', and it
 *    deletes nothing else.
 *
 * 3. The manifest id is '/', this origin's root: Dispatch is the only app on
 *    bik-dispatch.github.io, so the identity cannot collide with Almanac's.
 *
 * The same two rules as the root worker hold: never cache an API answer (the
 * fetch handler only ever touches URLs inside this scope, and /api/ is never
 * inside it), and always bypass the HTTP cache for the shell (cache:'reload').
 */
// v2 (card #386): the line now carries Almanac's alerts — app.js tags them
// ALERT and index.html styles them hot.
// app.js carries this same string as BUILD: the two must match and are bumped together.
const VERSION = 'almanac-dispatch-v4';   // bump whenever ANY dispatch file changes; the root VERSION is separate
const PREFIX = 'almanac-dispatch-';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest',
               './icons/icon-192.png', './icons/icon-512.png',
               './icons/maskable-192.png', './icons/maskable-512.png',
               './icons/badge-96.png', './icons/apple-touch-icon.png',
               './icons/favicon.png'];

// The version stamp that cannot lie (Almanac #8): the page asks, the worker
// answers with what is actually installed.
self.addEventListener('message', e => {
  if (e.data?.type === 'VERSION')
    e.source?.postMessage({type: 'VERSION', version: VERSION});
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', e => {
  // ALL OR NOTHING (the root's card #99 rule): one missed file fails the whole
  // install, so the old worker and its complete cache stay live and the
  // browser retries later. A holey cache is worse than an old one.
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.all(SHELL.map(u =>
        fetch(u, {cache: 'reload'}).then(r => {
          if (!r.ok) throw new Error('dispatch shell fetch failed: ' + u + ' ' + r.status);
          return c.put(u, r);
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Only our own old caches. 'almanac-shell-*' is Almanac's, and wiping it
  // would take the desk's offline shell down with ours.
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIX) && k !== VERSION)
                                .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Inside our scope only. That one test keeps out /api/ (data, never cached),
  // every other origin, and the root Almanac app, which has its own worker.
  if (!e.request.url.startsWith(self.registration.scope)) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(new Request(e.request.url, {cache: 'reload'}))
      .then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      // Offline: our own cache only. caches.match() would search every cache on
      // the origin and could hand back a copy the root worker made of us.
      .catch(() => caches.open(VERSION).then(c =>
        c.match(e.request).then(r => r || c.match('./'))))
  );
});

// The doorbell (card #376). The payload is written by spine/push.py's
// send_line: {kind:'dispatch', title, body, url, tag, renotify, silent,
// require, unread, msg_id, at}. The line's own row is the truth; this is only
// the ring.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) {
    // A payload that is not JSON still rings, with its text as the body:
    // a lost ring is worse than a plain one.
    try { d = {body: e.data ? e.data.text() : ''}; } catch (err2) { d = {}; }
  }
  if (!d || typeof d !== 'object') d = {};
  const scope = self.registration.scope;
  // A tap only ever opens a page inside Dispatch, whatever the payload says.
  let url = scope;
  try {
    const u = new URL(d.url || './', scope).href;
    if (u.startsWith(scope)) url = u;
  } catch (err) {}
  // ALWAYS show a notification: the subscription is userVisibleOnly, and the
  // notification left in the tray is what draws the launcher badge.
  // The two-tap vibrate is deliberately unlike Almanac's long buzz, so his
  // pocket can tell the runner from the desk without looking.
  const shown = self.registration.showNotification(String(d.title || 'Dispatch'), {
    body: String(d.body || ''),
    tag: String(d.tag || 'dispatch'),
    renotify: !!d.renotify,
    silent: !!d.silent,
    requireInteraction: !!d.require,
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    // Chrome refuses a vibrate pattern on a silent notification, so a quiet
    // ring carries none at all.
    vibrate: d.silent ? undefined : [90, 60, 90],
    timestamp: Date.parse(d.at) || Date.now(),
    data: {url, msg_id: d.msg_id},
  });
  // setAppBadge is a no-op on Android Chrome (the launcher counts the tray
  // instead) but it is the badge on iOS and desktop. Never let it cost the ring.
  let badge = Promise.resolve();
  try {
    if ('setAppBadge' in self.navigator && Number.isFinite(d.unread))
      badge = self.navigator.setAppBadge(d.unread).catch(() => {});
  } catch (err) {}
  e.waitUntil(Promise.all([shown, badge]));
});

// The push service rotated our endpoint. Re-subscribe with the same key and
// tell any open Dispatch page. This worker holds NO bearer by design (it
// cannot read localStorage, and the key must live in one place on this
// origin: the page's storage), so the PAGE posts the new subscription to the
// spine at its next boot, or at once if it is open and hears RESUBSCRIBED.
self.addEventListener('pushsubscriptionchange', e => {
  const scope = self.registration.scope;
  const key = e.oldSubscription?.options?.applicationServerKey;
  const fresh = e.newSubscription ? Promise.resolve(e.newSubscription)
    : key ? self.registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key})
    : Promise.reject(new Error('no old key to re-subscribe with'));
  const tell = msg => self.clients.matchAll({type: 'window', includeUncontrolled: true})
    .then(list => list.forEach(c => { if (c.url.startsWith(scope)) c.postMessage(msg); }));
  e.waitUntil(fresh.then(
    () => tell({type: 'RESUBSCRIBED'}),
    err => tell({type: 'RESUBSCRIBED', error: String(err && err.message || err)})));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const scope = self.registration.scope;
  const want = e.notification.data?.url || scope;
  const target = want.startsWith(scope) ? want : scope;
  // Focus an open Dispatch window, or open one. A root Almanac window is never
  // focused or navigated from here: the tap was for the line, not the desk.
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list)
      if (c.url.startsWith(scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});
