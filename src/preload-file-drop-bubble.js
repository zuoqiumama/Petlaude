const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fileDropBubbleAPI", {
  onShow: (cb) => ipcRenderer.on("file-drop-bubble-show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("file-drop-bubble-hide", () => cb()),
  choose: (actionId) => ipcRenderer.send("file-drop-bubble-action", actionId),
  reportHeight: (height) => ipcRenderer.send("file-drop-bubble-height", height),
});
