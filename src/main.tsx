import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyAppearance, readAppearance } from './appearance';
import { initializeLanguage } from './i18n';
import { TooltipLayer } from './Tooltip';

applyAppearance(readAppearance());

void initializeLanguage().then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <TooltipLayer />
  </React.StrictMode>,
));
