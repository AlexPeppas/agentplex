import { loader } from '@monaco-editor/react';

export function defineAgentPlexTheme() {
  loader.init().then((monaco) => {
    monaco.editor.defineTheme('agentplex-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8a96a3', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'b0c1cf' },
        { token: 'string', foreground: 'a4b9ac' },
        { token: 'number', foreground: 'cfb991' },
        { token: 'type', foreground: 'b6a6c9' },
        { token: 'function', foreground: 'e4e8ed' },
        { token: 'variable', foreground: 'e4e8ed' },
        { token: 'constant', foreground: 'cfb991' },
      ],
      colors: {
        'editor.background': '#121619',
        'editor.foreground': '#e4e8ed',
        'editor.selectionBackground': '#343b4380',
        'editor.lineHighlightBackground': '#20252b',
        'editorLineNumber.foreground': '#8a96a3',
        'editorLineNumber.activeForeground': '#a4aeb9',
        'editorCursor.foreground': '#e4e8ed',
        'editorGutter.background': '#121619',
        'diffEditor.insertedTextBackground': '#a4b9ac20',
        'diffEditor.removedTextBackground': '#d69c9c20',
        'diffEditor.insertedLineBackground': '#a4b9ac10',
        'diffEditor.removedLineBackground': '#d69c9c10',
        'scrollbarSlider.background': '#343b4360',
        'scrollbarSlider.hoverBackground': '#55616e80',
        'scrollbarSlider.activeBackground': '#71839790',
      },
    });
  });
}
