// Playwright's Electron launcher needs a CommonJS main (an ES module main with top-level await never became ready).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, session } = require('electron');

// The main process of the leak harness: a bare Electron (the same Chromium the app ships) that opens only the hidden
// windows the test asks for. It is not the Aplos app: the frame pipeline (html-4, html-5) is not built, so the test
// serves the sanitized documents itself. What it adds over a plain Chromium page is Electron's own session: the
// `webRequest` log below is the independent record of every http(s)/ws(s) request, the one the real app's backstop
// (plan 10 E4 item 7) will cancel on.
//
// Test mode, as in the app: no Dock item, no activation, windows created with show:false by the test and never shown.

if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}
app.on('window-all-closed', () => {});

/** @type {{ requests: object[]; popups: object[]; navigations: object[] }} */
const log = { requests: [], popups: [], navigations: [] };
globalThis.leakHarness = log;

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(details => {
    log.popups.push({ opener: contents.id, url: details.url, disposition: details.disposition });
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', details => {
    log.navigations.push({
      contents: contents.id,
      url: details.url,
      isMainFrame: details.isMainFrame,
    });
  });
});

void app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      log.requests.push({
        contents: details.webContentsId,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        referrer: details.referrer,
      });
      callback({});
    },
  );
});
