import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { CloudAuthGate } from './components/CloudAuthGate';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CloudAuthGate>
      <App />
    </CloudAuthGate>
  </React.StrictMode>,
);
