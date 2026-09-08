import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { CloudAuthGate } from './components/CloudAuthGate';
import { IS_APPLE_MOBILE_BROWSER } from './utils/applePlatform';
import './styles.css';

if (IS_APPLE_MOBILE_BROWSER) document.documentElement.classList.add('apple-mobile-web');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CloudAuthGate>
      <App />
    </CloudAuthGate>
  </React.StrictMode>,
);
