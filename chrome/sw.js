// Chrome and Opera run the background as a service worker: the same
// background script as Firefox's, after the compatibility layer.
importScripts('compat.js', 'log.js', 'background.js');
