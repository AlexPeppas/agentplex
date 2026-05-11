import type { ITheme } from '@xterm/xterm';

export interface TerminalThemeDef {
  id: string;
  label: string;
  theme: ITheme;
}

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  {
    id: 'default',
    label: 'Default',
    theme: {
      background: '#262420',
      foreground: '#ece4d8',
      cursor: '#ece4d8',
      selectionBackground: '#3e3830',
      black: '#1e1c18',
      red: '#e07070',
      green: '#a8c878',
      yellow: '#e8c070',
      blue: '#d18a7a',
      magenta: '#dfa898',
      cyan: '#d18a7a',
      white: '#9a8a70',
      brightBlack: '#4e4638',
      brightRed: '#e07070',
      brightGreen: '#a8c878',
      brightYellow: '#e8c070',
      brightBlue: '#dfa898',
      brightMagenta: '#dfa898',
      brightCyan: '#d18a7a',
      brightWhite: '#ece4d8',
    },
  },
  {
    id: 'black',
    label: 'Black',
    theme: {
      background: '#000000',
      foreground: '#e6e6e6',
      cursor: '#ffffff',
      selectionBackground: '#3a3a3a',
      black: '#000000',
      red: '#cc5555',
      green: '#7fbf6f',
      yellow: '#d6b35a',
      blue: '#6aa0d8',
      magenta: '#b87fc7',
      cyan: '#6abbbb',
      white: '#bdbdbd',
      brightBlack: '#5a5a5a',
      brightRed: '#ee7070',
      brightGreen: '#9fdc88',
      brightYellow: '#f0cc70',
      brightBlue: '#8ec1ee',
      brightMagenta: '#d09be0',
      brightCyan: '#8fd8d8',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'light',
    label: 'Light',
    theme: {
      background: '#fdf6e3',
      foreground: '#3a3226',
      cursor: '#3a3226',
      selectionBackground: '#eee0c0',
      black: '#3a3226',
      red: '#c0392b',
      green: '#5b8a3a',
      yellow: '#a37200',
      blue: '#2b6a8d',
      magenta: '#a3437e',
      cyan: '#3e8b8b',
      white: '#6a5e50',
      brightBlack: '#6a5e50',
      brightRed: '#c0392b',
      brightGreen: '#5b8a3a',
      brightYellow: '#a37200',
      brightBlue: '#2b6a8d',
      brightMagenta: '#a3437e',
      brightCyan: '#3e8b8b',
      brightWhite: '#3a3226',
    },
  },
];

const STORAGE_KEY = 'agentplex-terminal-theme';
const DEFAULT_ID = 'default';

type Listener = (def: TerminalThemeDef) => void;
const listeners = new Set<Listener>();

export function getTerminalThemeId(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && TERMINAL_THEMES.some((t) => t.id === saved)) return saved;
  return DEFAULT_ID;
}

export function getTerminalThemeDef(id?: string): TerminalThemeDef {
  const target = id ?? getTerminalThemeId();
  return TERMINAL_THEMES.find((t) => t.id === target) ?? TERMINAL_THEMES[0];
}

export function setTerminalThemeId(id: string): void {
  if (!TERMINAL_THEMES.some((t) => t.id === id)) return;
  localStorage.setItem(STORAGE_KEY, id);
  const def = getTerminalThemeDef(id);
  for (const cb of listeners) cb(def);
}

export function subscribeTerminalTheme(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
