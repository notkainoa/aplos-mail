import { createRoot } from 'react-dom/client';
import '@fontsource-variable/newsreader/opsz.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/app.css';
import './styles/home.css';
import './styles/demos.css';
import { Landing } from './Landing';

createRoot(document.getElementById('root')!).render(<Landing />);
