import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Jobs, { JobDetail } from './pages/Jobs';
import TriggerJob from './pages/TriggerJob';
import { DLQ, Settings, SSMDocs } from './pages/Schedules';
import RegisteredTargets from './pages/RegisteredTargets';
import TriggersSchedules from './pages/TriggersSchedules';
import Uploads from './pages/Uploads';
import UsersRoles from './pages/UsersRoles';
import DRSwitchover from './pages/DRSwitchover';
import { isConfigured } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Login from './auth/Login';
import AuthCallback from './auth/AuthCallback';
import RequireRole from './auth/RequireRole';
import { DR_SWITCHOVER_ACCESS } from './auth/access';
import { Spinner } from './components/ui';

function ConfigWarning() {
  if (isConfigured()) return null;
  return (
    <div style={{
      position:'fixed', bottom:16, right:16, zIndex:9999,
      padding:'12px 18px', borderRadius:'var(--radius-lg)',
      background:'var(--amber-bg)', border:'1px solid var(--amber-border)',
      color:'var(--amber)', fontSize:12, maxWidth:340, lineHeight:1.6,
      boxShadow:'0 4px 20px rgba(0,0,0,0.4)',
    }}>
      <strong>⚠ API not configured</strong><br/>
      Copy <code style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>.env.example</code> to{' '}
      <code style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>.env</code> and fill in your RunStack
      CloudFormation outputs, then restart the dev server.
    </div>
  );
}

function AuthGate({ children }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={28} />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Login />;
  }
  return children;
}

function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/"            element={<Dashboard/>}/>
        <Route path="/jobs"        element={<Jobs/>}/>
        <Route path="/jobs/:jobId" element={<JobDetail/>}/>
        <Route path="/trigger"     element={<TriggerJob/>}/>
        <Route path="/schedules"   element={<RequireRole minRole="operator"><TriggersSchedules/></RequireRole>}/>
        <Route path="/dlq"         element={<RequireRole minRole="operator"><DLQ/></RequireRole>}/>
        <Route path="/accounts"    element={<RegisteredTargets/>}/>
        <Route path="/database/dr-switchover" element={
          <RequireRole minRole={DR_SWITCHOVER_ACCESS.minRole} orGroup={DR_SWITCHOVER_ACCESS.orGroups}><DRSwitchover/></RequireRole>
        }/>
        {/* Old DR Failover URL — keep bookmarks working */}
        <Route path="/dr-failover" element={<Navigate to="/database/dr-switchover" replace/>}/>
        <Route path="/docs"        element={<SSMDocs/>}/>
        <Route path="/uploads"     element={<RequireRole minRole="admin"><Uploads/></RequireRole>}/>
        <Route path="/users"       element={<RequireRole minRole="admin"><UsersRoles/></RequireRole>}/>
        <Route path="/settings"    element={<Settings/>}/>
        <Route path="*"            element={<Navigate to="/" replace/>}/>
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ConfigWarning/>
      <AuthProvider>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback/>} />
          <Route path="*" element={<AuthGate><AppRoutes/></AuthGate>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}