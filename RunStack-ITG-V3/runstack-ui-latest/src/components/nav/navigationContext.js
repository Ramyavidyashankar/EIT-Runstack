// src/components/nav/navigationContext.js
//
// In-app navigation with the shell's behaviour (refresh-in-place, unsaved-work
// prompt, loading bar) — provided by Layout, used by the header and the Run
// Automations chooser. Outside Layout it falls back to a plain page load.
import React from 'react';

export const NavigationContext = React.createContext((to) => { window.location.assign(to); });
export const useAppNavigate = () => React.useContext(NavigationContext);
