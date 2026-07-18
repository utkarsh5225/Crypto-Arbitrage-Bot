import { createRoot } from 'react-dom/client';

import App from './App';
import { initApiToken } from '@/lib/api-token';

import './index.css';

// Register the optional API auth token (no-op unless the server requires one).
initApiToken();

createRoot(document.getElementById('root')!).render(<App />);
