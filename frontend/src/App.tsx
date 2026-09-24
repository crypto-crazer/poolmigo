import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { VaultDetail } from '@/pages/VaultDetail';
import { Navigate } from 'react-router-dom';
import { Analytics } from '@/pages/Analytics';
import { LiveVault } from '@/pages/LiveVault';

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Markets />} />
          <Route path="/live" element={<LiveVault />} />
          <Route path="/explore" element={<Navigate to="/" replace />} />
          <Route path="/vault/:id" element={<VaultDetail />} />
          <Route path="/portfolio" element={<Navigate to="/" replace />} />
          <Route path="/rewards" element={<Navigate to="/" replace />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/flywheel" element={<Navigate to="/analytics" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
