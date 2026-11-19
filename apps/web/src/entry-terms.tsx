import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/privacy.css';
import { Terms } from './Terms';

createRoot(document.getElementById('root')!).render(<Terms />);
