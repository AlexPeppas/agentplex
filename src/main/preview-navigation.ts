export function installPreviewNavigation(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.url !== 'about:srcdoc' && event.url !== 'about:blank') event.preventDefault();
  });
}
