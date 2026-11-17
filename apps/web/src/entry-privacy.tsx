import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/privacy.css';
import { Privacy } from './Privacy';

createRoot(document.getElementById('root')!).render(<Privacy />);
