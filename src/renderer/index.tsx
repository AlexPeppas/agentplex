import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../../styles/index.css';

document.documentElement.setAttribute('data-platform', window.agentPlex.platform);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
