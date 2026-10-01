// src/components/PageLayout.jsx — shared page structure for every RunStack page.
//
//   <Page title subtitle actions>         Topbar + one scroll area with the
//     …sections…                          standard outer padding and section
//   </Page>                               spacing, full width beside the sidebar.
//
//   <RunLayout summary={<RunSummary …/>}> Flexible main column + 300–340 px
//     …sections…                          sticky "Run summary" on wide screens;
//   </RunLayout>                          the summary stacks below on smaller ones.
//
// Spacing, widths and breakpoints live in index.css (.rs-page*, .rs-run-*),
// so pages don't set their own fixed widths.

import React from 'react';
import { Topbar } from './Layout';
import { Card, CardHead } from './ui';
import { SectionHeader } from './sections';

export function Page({ title, subtitle, actions, children, bodyStyle, contentStyle, bodyRef }) {
  return (
    <div className="rs-page">
      <Topbar title={title} subtitle={subtitle} actions={actions} />
      <div className="rs-page-body" style={bodyStyle} ref={bodyRef}>
        <div className="rs-page-content" style={contentStyle}>{children}</div>
      </div>
    </div>
  );
}

export function RunLayout({ summary, children }) {
  return (
    <div className="rs-run-layout">
      <div className="rs-run-main">{children}</div>
      <aside className="rs-run-summary" aria-label="Run summary">{summary}</aside>
    </div>
  );
}

/** Summary card: rows of label/value, optional content, and a footer action. */
export function RunSummary({ rows, children, footer }) {
  return (
    <Card className="animate-fade">
      <div className="rs-run-summary-card">
        <CardHead style={{ padding: '14px 20px' }}>
          <SectionHeader title="Run summary" />
        </CardHead>
        <div style={{ padding: '16px 20px', display: 'grid', gap: 12, overflow: 'auto', minHeight: 0 }}>
          {rows?.length > 0 && (
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12, rowGap: 8, margin: 0, fontSize: 14 }}>
              {rows.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt style={{ color: 'var(--text-tertiary)' }}>{k}</dt>
                  <dd style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 500, textAlign: 'right', overflowWrap: 'anywhere' }}>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
          {children}
        </div>
        {footer && <div style={{ padding: '14px 20px 18px', borderTop: '1px solid var(--border)', display: 'grid', gap: 8 }}>{footer}</div>}
      </div>
    </Card>
  );
}
