import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installCloudWriteAuthentication } from './utils/cloudWriteAuth';
import './styles.css';

installCloudWriteAuthentication();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
