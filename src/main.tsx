import React from 'react';
import ReactDOM from 'react-dom/client';
// Bundled Studio faces (variable weight + true document italics). Self-hosted
// via the Vite pipeline: no CDN, no CSP entry, works offline.
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
