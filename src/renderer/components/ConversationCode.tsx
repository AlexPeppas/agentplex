import { memo } from 'react';
import highlight from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({
  bash, cpp, css, diff, go, java, javascript, json, markdown, powershell, python, rust, typescript, xml, yaml,
})) highlight.registerLanguage(name, language);

export const ConversationCode = memo(function ConversationCode({ className, content }: { className?: string; content: string }) {
  const language = className?.match(/\blanguage-([\w+-]+)/)?.[1];
  if (!language || !highlight.getLanguage(language)) return <code className={className}>{content}</code>;
  // The highlighter escapes source text before adding its own span markup.
  const html = highlight.highlight(content, { language, ignoreIllegals: true }).value;
  return <code className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});
