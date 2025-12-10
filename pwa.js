// pwa.js
// Registers the service worker (sw.js) for offline/PWA functionality

(() => {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .catch(() => {
        // Intentionally ignore registration errors; app still works online
      });
  });
})();
