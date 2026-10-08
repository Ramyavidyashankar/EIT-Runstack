// src/hooks/useAppAccess.js — does the signed-in user have EC2 application
// access (rows in runstack-app-access)?
//
// Mirrors instances.resolve_authorized_app_ids(allow_team_visibility=False),
// which GET /app-instances uses:
//   admin              → every application                → true
//   no platform role   → refused (team groups don't count) → false, no request
//   any other role     → their runstack-app-access rows     → asks GET /app-instances
// The answer is shared with Run Automations through the per-user cache in
// utils/automationCatalog.js. Returns true / false, or null while unknown.
// UI visibility only — the backend still checks every request.

import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { loadAppAccess } from '../utils/automationCatalog';

export function appAccessWithoutRequest(role) {
  if (role === 'admin') return true;
  if (!role || role === 'none') return false;
  return null;
}

export default function useAppAccess() {
  const { role, email } = useAuth();
  const known = appAccessWithoutRequest(role);
  const [has, setHas] = useState(known);
  useEffect(() => {
    if (known !== null) { setHas(known); return undefined; }
    let live = true;
    setHas(null);
    loadAppAccess(email)
      .then((r) => { if (live) setHas(r.instances.length > 0); })
      .catch(() => { if (live) setHas(false); });   // 403 "no applications"
    return () => { live = false; };
  }, [role, email, known]);
  return has;
}
