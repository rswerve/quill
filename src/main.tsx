import React from 'react';
import ReactDOM from 'react-dom/client';
// Bundled document faces (variable weight + true italics). Self-hosted via
// the Vite pipeline: no CDN, no CSP entry, works offline.
import '@fontsource-variable/mulish';
import '@fontsource-variable/mulish/wght-italic.css';
import '@fontsource-variable/lora';
import '@fontsource-variable/lora/wght-italic.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
