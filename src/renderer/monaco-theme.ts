import { loader } from '@monaco-editor/react';

export function defineAgentPlexTheme(): Promise<any> {
  return loader.init().then((monaco) => {
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

    monaco.editor.defineTheme('agentplex-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8a7e6e', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c06a50' },
        { token: 'string', foreground: '4a8a40' },
        { token: 'number', foreground: 'b8922a' },
        { token: 'type', foreground: 'a85a42' },
        { token: 'function', foreground: '3a3428' },
        { token: 'variable', foreground: '3a3428' },
        { token: 'constant', foreground: 'b8922a' },
      ],
      colors: {
        'editor.background': '#ebe5da',
        'editor.foreground': '#3a3428',
        'editor.selectionBackground': '#d8d0c480',
        'editor.lineHighlightBackground': '#e2dcd0',
        'editorLineNumber.foreground': '#a09484',
        'editorLineNumber.activeForeground': '#3a3428',
        'editorCursor.foreground': '#3a3428',
        'editorGutter.background': '#ebe5da',
        'diffEditor.insertedTextBackground': '#4a8a4020',
        'diffEditor.removedTextBackground': '#c4404020',
        'diffEditor.insertedLineBackground': '#4a8a4010',
        'diffEditor.removedLineBackground': '#c4404010',
        'scrollbarSlider.background': '#d8d0c460',
        'scrollbarSlider.hoverBackground': '#c8c0b480',
        'scrollbarSlider.activeBackground': '#b8b0a490',
      },
    });
    return monaco;
  });
}
