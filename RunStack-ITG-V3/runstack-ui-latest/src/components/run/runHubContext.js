// src/components/run/runHubContext.js
//
// Marks the routes that belong to Run Automations (App.jsx wraps them in
// <RunHub>). Topbar reads it to show the Category → Automation chooser.
import React from 'react';

const RunHubContext = React.createContext(false);

export function RunHub({ children }) {
  return <RunHubContext.Provider value>{children}</RunHubContext.Provider>;
}

export const useRunHub = () => React.useContext(RunHubContext);
