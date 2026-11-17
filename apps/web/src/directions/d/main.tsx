import { createRoot } from 'react-dom/client';
import '@fontsource-variable/newsreader/opsz.css';
import './style.css';
import { Page } from './Page';

createRoot(document.getElementById('root')!).render(<Page />);
