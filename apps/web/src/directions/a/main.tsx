import { createRoot } from 'react-dom/client';
import '@fontsource-variable/newsreader';
import { Page } from './Page';
import './style.css';

createRoot(document.getElementById('root')!).render(<Page />);
