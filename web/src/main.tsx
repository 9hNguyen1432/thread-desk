import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { captureToken } from './api';
import './styles.css';

captureToken();
// Opening a fresh board link in an already open tab only changes the fragment, without a reload.
window.addEventListener('hashchange', () => {
  if (/(?:^#|&)t=/.test(location.hash)) {
    captureToken();
    location.reload();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
