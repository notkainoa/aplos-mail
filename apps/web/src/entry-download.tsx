import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/download.css';
import { Download } from './Download';

createRoot(document.getElementById('root')!).render(<Download />);
