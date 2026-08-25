import { Terminal } from 'lucide-react';
import claudeLogo from '../assets/claude-logo.svg';
import codexDark from '../assets/codex-dark.svg';
import codexLight from '../assets/codex-light.svg';
import copilotDark from '../assets/githubcopilot-dark.svg';
import copilotLight from '../assets/githubcopilot-light.svg';

const CLI_ICONS: Record<string, { dark: string; light: string }> = {
  claude: { dark: claudeLogo, light: claudeLogo },
  codex: { dark: codexLight, light: codexDark },
  copilot: { dark: copilotLight, light: copilotDark },
};

/** CLI logo badge — mirrors the desktop SessionNode CLI icon. */
export function CliIcon({ cli, size = 12 }: { cli?: string; size?: number }) {
  if (!cli) return <Terminal size={size} className="shrink-0 text-fg-muted" />;
  const base = cli.replace(/-resume$/, '');
  const icons = CLI_ICONS[base];
  if (!icons) return <Terminal size={size} className="shrink-0 text-fg-muted" />;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const src = theme === 'dark' ? icons.dark : icons.light;
  return <img src={src} alt="" style={{ width: size, height: size }} className="shrink-0" />;
}
