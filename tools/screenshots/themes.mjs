// The `--vscode-*` custom properties a real webview inherits from the workbench.
//
// styles.css reads these and nothing else, so getting them right is what makes a browser
// screenshot look like the panel rather than like unstyled HTML. The values are VS Code's own
// Dark Modern and Light Modern defaults; two themes because the light one is where contrast bugs
// hide — the activity feed's traffic-light colours are hardcoded GitHub-dark hexes in styles.css,
// which only a light-theme render exposes.

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif";
const MONO = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";

/** Dark Modern. */
export const dark = {
  'font-family': FONT,
  'font-size': '13px',
  'font-weight': 'normal',
  'editor-font-family': MONO,
  'editor-background': '#1f1f1f',
  'editor-foreground': '#cccccc',
  'sideBar-background': '#181818',
  'sideBarSectionHeader-background': '#181818',
  'sideBarSectionHeader-border': '#2b2b2b',
  'tab-border': '#2b2b2b',
  'panel-border': '#2b2b2b',
  'widget-border': '#313131',
  focusBorder: '#0078d4',
  'toolbar-hoverBackground': '#5a5d5e50',
  'toolbar-activeBackground': '#63666750',
  'editorHoverWidget-background': '#202020',
  'editorHoverWidget-border': '#454545',
  'button-border': '#ffffff12',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c',
  'list-hoverBackground': '#2a2d2e',
  'list-hoverForeground': '#cccccc',
  'list-activeSelectionBackground': '#04395e',
  'list-activeSelectionForeground': '#ffffff',
  'list-inactiveFocusForeground': '#cccccc',
  'list-inactiveFocusOutline': '#ffffff17',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  descriptionForeground: '#9d9d9d',
  'menu-background': '#1f1f1f',
  'menu-foreground': '#cccccc',
  'menu-border': '#454545',
  'menu-selectionBackground': '#0078d4',
  'menu-selectionForeground': '#ffffff',
  'charts-red': '#f14c4c',
  'charts-blue': '#3794ff',
  'charts-yellow': '#cca700',
  'charts-orange': '#d18616',
  'charts-green': '#89d185',
  'charts-purple': '#b180d7',
  'textLink-foreground': '#4daafc',
  'textCodeBlock-background': '#2b2b2b',
};

/** Light Modern. */
export const light = {
  'font-family': FONT,
  'font-size': '13px',
  'font-weight': 'normal',
  'editor-font-family': MONO,
  'editor-background': '#ffffff',
  'editor-foreground': '#3b3b3b',
  'sideBar-background': '#f8f8f8',
  'sideBarSectionHeader-background': '#f8f8f8',
  'sideBarSectionHeader-border': '#e5e5e5',
  'tab-border': '#e5e5e5',
  'panel-border': '#e5e5e5',
  'widget-border': '#e5e5e5',
  focusBorder: '#005fb8',
  'toolbar-hoverBackground': '#b8b8b850',
  'toolbar-activeBackground': '#a6a6a650',
  'editorHoverWidget-background': '#f8f8f8',
  'editorHoverWidget-border': '#c8c8c8',
  'button-border': '#0000001a',
  'button-secondaryBackground': '#e5e5e5',
  'button-secondaryForeground': '#3b3b3b',
  'button-secondaryHoverBackground': '#cccccc',
  'list-hoverBackground': '#f2f2f2',
  'list-hoverForeground': '#3b3b3b',
  'list-activeSelectionBackground': '#e8e8e8',
  'list-activeSelectionForeground': '#000000',
  'list-inactiveFocusForeground': '#3b3b3b',
  'list-inactiveFocusOutline': '#0000001f',
  'badge-background': '#cccccc',
  'badge-foreground': '#3b3b3b',
  descriptionForeground: '#6b6b6b',
  'menu-background': '#ffffff',
  'menu-foreground': '#3b3b3b',
  'menu-border': '#cecece',
  'menu-selectionBackground': '#005fb8',
  'menu-selectionForeground': '#ffffff',
  'charts-red': '#e51400',
  'charts-blue': '#1976d2',
  'charts-yellow': '#b89500',
  'charts-orange': '#d18616',
  'charts-green': '#388a34',
  'charts-purple': '#652d90',
  'textLink-foreground': '#005fb8',
  'textCodeBlock-background': '#f8f8f8',
};

/** The theme as a `:root { --vscode-*: … }` block, the way the workbench injects it. */
export function themeCss(theme) {
  const decls = Object.entries(theme)
    .map(([key, value]) => `  --vscode-${key}: ${value};`)
    .join('\n');
  return `:root {\n${decls}\n}\n`;
}

export const themes = { dark, light };
