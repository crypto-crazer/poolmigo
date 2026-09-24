import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ChainProviders } from './chain/Providers';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChainProviders>
      <App />
    </ChainProviders>
  </React.StrictMode>,
);
