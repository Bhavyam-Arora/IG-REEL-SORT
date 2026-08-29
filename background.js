// background.js — service worker. Deliberately minimal.
chrome.runtime.onInstalled.addListener(function () {
  console.log("[GridSorter] installed");
});
