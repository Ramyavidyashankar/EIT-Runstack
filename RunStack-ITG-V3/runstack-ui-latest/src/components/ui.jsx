// src/components/ui.jsx
import React from 'react';
import { STATUS_META, TYPE_META } from '../utils/helpers';

// ── Status badge ──────────────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.PENDING;
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:5,
      padding:'3px 9px', borderRadius:20,
      background: m.bg, color: m.color,
      fontSize:12, fontWeight:600,
      border:`1px solid ${m.color}30`,
    }}>
      <span style={{
        width:6, height:6, borderRadius:'50%',
        background: m.color, flexShrink:0,
        animation: m.pulse ? 'pulse 1.6s ease infinite' : 'none',
      }}/>
      {m.label}
    </span>
  );
}

// ── Type tag ──────────────────────────────────────────────────────────────────
export function TypeTag({ type }) {
  const m = TYPE_META[type] || { color:'var(--text-tertiary)', bg:'rgba(100,116,139,0.1)' };
  return (
    <span style={{
      display:'inline-block', padding:'2px 7px', borderRadius:4,
      background: m.bg, color: m.color,
      fontSize:12, fontWeight:600,
      border:`1px solid ${m.color}30`,
    }}>
      {type}
    </span>
  );
}

// ── Button ────────────────────────────────────────────────────────────────────
export function Btn({ children, variant='default', size='md', onClick, disabled, type='button', style={}, className='', ...aria }) {
  const base = {
    display:'inline-flex', alignItems:'center', gap:6,
    borderRadius: size === 'sm' ? 'var(--radius-sm)' : 'var(--radius-md)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily:'inherit', fontWeight:500,
    transition:'all 0.15s', opacity: disabled ? 0.5 : 1,
    border:'none',
    lineHeight:1.4,
    ...(size === 'sm' ? { padding:'5px 12px', fontSize:'var(--fs-label)' } : { padding:'8px 16px', fontSize:'var(--fs-label)' }),
  };
  const variants = {
    default: {
      background:'var(--bg-surface)', color:'var(--text-primary)',
      border:'1px solid var(--border-md)',
    },
    primary: {
      background:'var(--brand)', color:'#FFFFFF',
      border:'1px solid var(--brand)',
    },
    danger: {
      background:'var(--danger-bg)', color:'var(--danger)',
      border:'1px solid var(--danger-border)',
    },
    ghost: {
      background:'transparent', color:'var(--text-secondary)',
      border:'1px solid transparent',
    },
    // Sidebar palette — primary action (navy) and secondary/selected (blue)
    navy: {
      background:'var(--nav-navy)', color:'#FFFFFF',
      border:'1px solid var(--nav-navy)',
    },
    accent: {
      background:'var(--nav-blue-bg)', color:'var(--nav-blue-text)',
      border:'1px solid var(--nav-blue-border)',
    },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} {...aria}
      className={`rs-btn rs-btn-${variant}${className ? ` ${className}` : ''}`}
      style={{...base, ...variants[variant], ...style}}>
      {children}
    </button>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────
export function Card({ children, style={}, onClick, ...rest }) {
  return (
    <div
      onClick={onClick}
      className={onClick ? 'rs-card-interactive' : undefined}
      style={{
        background:'var(--bg-surface)',
        border:'1px solid var(--border)',
        borderRadius:'var(--radius-lg)',
        boxShadow:'var(--shadow-sm)',
        overflow:'hidden',
        ...(onClick ? { cursor: 'pointer' } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHead({ children, style={}, onClick, ...rest }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding:'14px 20px',
        borderBottom:'1px solid var(--border)',
        display:'flex', alignItems:'center',
        justifyContent:'space-between',
        background:'var(--section-head-bg)',
        fontSize:'var(--fs-body)', color:'var(--text-primary)',
        ...(onClick ? { cursor: 'pointer' } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
export function Spinner({ size=18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      style={{ animation:'spin 0.8s linear infinite', flexShrink:0 }}>
      <circle cx="12" cy="12" r="10" stroke="var(--border)" strokeWidth="2.5"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--brand)" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
export function Empty({ message='No data found.' }) {
  return (
    <div style={{
      padding:'48px 24px', textAlign:'center',
      color:'var(--text-tertiary)', fontSize:14,
    }}>
      {message}
    </div>
  );
}

// ── Error banner ──────────────────────────────────────────────────────────────
export function ErrorBanner({ message }) {
  return (
    <div style={{
      padding:'10px 16px', borderRadius:'var(--radius-md)',
      background:'var(--danger-bg)', border:'1px solid var(--danger-border)',
      color:'var(--danger)', fontSize:14, marginBottom:16,
    }}>
      ⚠ {message}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background:'var(--bg-surface)',
      border:'1px solid var(--border)',
      borderRadius:'var(--radius-lg)',
      padding:'16px 18px',
      borderTop: accent ? `3px solid ${accent}` : '3px solid var(--border)',
      boxShadow:'var(--shadow-sm)',
    }}>
      <div style={{
        fontSize:'var(--fs-help)', color:'var(--text-secondary)', fontWeight:500, marginBottom:8,
      }}>
        {label}
      </div>
      <div style={{ fontSize:26, fontWeight:600, color:'var(--text-primary)', lineHeight:1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:6 }}>{sub}</div>
      )}
    </div>
  );
}

// ── Section title ─────────────────────────────────────────────────────────────
export function SectionTitle({ children, sub }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:'var(--fs-section-title)', fontWeight:600, color:'var(--text-primary)' }}>{children}</div>
      {sub && <div style={{ fontSize:'var(--fs-help)', color:'var(--text-secondary)', marginTop:2 }}>{sub}</div>}
    </div>
  );
}

// ── Mono field ────────────────────────────────────────────────────────────────
export function MonoField({ value, dim }) {
  return (
    <span style={{
      fontFamily:'var(--font-mono)', fontSize:12,
      color: dim ? 'var(--text-tertiary)' : 'var(--text-mono)',
    }}>
      {value}
    </span>
  );
}

// ── Form controls ─────────────────────────────────────────────────────────────
const inputStyle = {
  width:'100%', padding:'8px 12px',
  borderRadius:'var(--radius-sm)',
  border:'1px solid var(--border-md)',
  background:'var(--bg-surface)',
  color:'var(--text-primary)', fontSize:14, outline:'none',
  transition:'border-color 0.15s',
};

export function Input(props) {
  return <input {...props} className={`rs-input ${props.className||''}`} style={{...inputStyle, ...props.style}}/>;
}

export function Select({ children, ...props }) {
  return (
    <select {...props} className={`rs-input ${props.className||''}`} style={{...inputStyle, cursor:'pointer', ...props.style}}>
      {children}
    </select>
  );
}

export function Textarea(props) {
  return (
    <textarea {...props} className={`rs-input ${props.className||''}`} style={{
      ...inputStyle,
      fontFamily:'var(--font-mono)', fontSize:13,
      resize:'vertical', minHeight:100, ...props.style,
    }}/>
  );
}

export function FormRow({ label, children, hint }) {
  return (
    <div style={{ display:'grid', gap:6 }}>
      <label style={{ fontSize:'var(--fs-label)', fontWeight:500, color:'var(--text-primary)' }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize:'var(--fs-help)', color:'var(--text-secondary)' }}>{hint}</div>}
    </div>
  );
}

