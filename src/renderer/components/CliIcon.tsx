import { Terminal } from 'lucide-react';
import type { CliTool } from '../../shared/ipc-channels';
import claudeLogo from '../../../assets/claude-logo.svg';
import codexDark from '../../../assets/codex-dark.svg';
import codexLight from '../../../assets/codex-light.svg';
import copilotDark from '../../../assets/githubcopilot-dark.svg';
import copilotLight from '../../../assets/githubcopilot-light.svg';

const CLI_ICONS: Record<string, { dark: string; light: string }> = {
  claude: { dark: claudeLogo, light: claudeLogo },
  codex: { dark: codexLight, light: codexDark },
  copilot: { dark: copilotLight, light: copilotDark },
};

export function CliIcon({ cli, size = 14 }: { cli?: CliTool; size?: number }) {
  const icons = cli ? CLI_ICONS[cli] : undefined;
  if (!icons) return <Terminal size={size} className="shrink-0" />;
  return (
    <span className="inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <img src={icons.dark} alt="" className="cli-icon--dark w-full h-full" />
      <img src={icons.light} alt="" className="cli-icon--light w-full h-full" />
    </span>
  );
}
