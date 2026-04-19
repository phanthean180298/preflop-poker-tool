// Preload: expose safe API bridge to renderer
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
});
