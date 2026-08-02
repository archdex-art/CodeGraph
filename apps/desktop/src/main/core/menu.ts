import { app, Menu, MenuItemConstructorOptions, shell, BrowserWindow } from "electron";

export interface MenuActions {
  onCheckForUpdates?: () => void;
  learnMoreUrl?: string;
}

/**
 * Builds and installs the native application menu.
 *
 * Uses Electron menu *roles* for all standard editing/window/zoom behaviour so
 * the OS wires up the correct accelerators and platform conventions (the macOS
 * app menu, Services, Hide/Show, etc.) without hand-rolled shortcut handling.
 */
export function buildApplicationMenu(actions: MenuActions = {}): Menu {
  const isMac = process.platform === "darwin";
  const appName = app.getName();
  const learnMoreUrl = actions.learnMoreUrl ?? "https://github.com/archdex-art/CodeGraph";

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        ...(actions.onCheckForUpdates
          ? [{ label: "Check for Updates…", click: () => actions.onCheckForUpdates?.() }]
          : []),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [isMac ? { role: "close" } : { role: "quit" }],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? ([
            { role: "pasteAndMatchStyle" },
            { role: "delete" },
            { role: "selectAll" },
          ] as MenuItemConstructorOptions[])
        : ([{ role: "delete" }, { type: "separator" }, { role: "selectAll" }] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      ...(app.isPackaged ? [] : ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  template.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? ([
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ] as MenuItemConstructorOptions[])
        : ([{ role: "close" }] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    role: "help",
    submenu: [
      {
        label: "Learn More",
        click: () => void shell.openExternal(learnMoreUrl),
      },
      {
        label: "Report an Issue",
        click: () => void shell.openExternal(`${learnMoreUrl}/issues`),
      },
      ...(!isMac && actions.onCheckForUpdates
        ? ([
            { type: "separator" },
            { label: "Check for Updates…", click: () => actions.onCheckForUpdates?.() },
          ] as MenuItemConstructorOptions[])
        : []),
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

/** Convenience: focus or restore the main window. */
export function focusWindow(window: BrowserWindow | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}
