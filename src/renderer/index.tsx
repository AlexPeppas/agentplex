import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getInitialTheme } from './components/panels/SettingsPanel';
import '../../styles/index.css';

document.documentElement.setAttribute('data-platform', window.agentPlex.platform);
const theme = getInitialTheme();
document.documentElement.setAttribute('data-theme', theme);
window.agentPlex.setTheme(theme);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
