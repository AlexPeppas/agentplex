import { loader } from '@monaco-editor/react';

export function defineAgentPlexTheme() {
  loader.init().then((monaco) => {
    monaco.editor.defineTheme('agentplex-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a5e50', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'd18a7a' },
        { token: 'string', foreground: 'a8c878' },
        { token: 'number', foreground: 'e8c070' },
        { token: 'type', foreground: 'dfa898' },
        { token: 'function', foreground: 'ece4d8' },
        { token: 'variable', foreground: 'ece4d8' },
        { token: 'constant', foreground: 'e8c070' },
      ],
      colors: {
        'editor.background': '#1e1c18',
        'editor.foreground': '#ece4d8',
        'editor.selectionBackground': '#3e383080',
        'editor.lineHighlightBackground': '#2a2824',
        'editorLineNumber.foreground': '#4e4638',
        'editorLineNumber.activeForeground': '#9a8a70',
        'editorCursor.foreground': '#ece4d8',
        'editorGutter.background': '#1e1c18',
        'diffEditor.insertedTextBackground': '#a8c87820',
        'diffEditor.removedTextBackground': '#e0707020',
        'diffEditor.insertedLineBackground': '#a8c87810',
        'diffEditor.removedLineBackground': '#e0707010',
        'scrollbarSlider.background': '#3e383060',
        'scrollbarSlider.hoverBackground': '#4e463880',
        'scrollbarSlider.activeBackground': '#5e564890',
      },
    });
  });
}
