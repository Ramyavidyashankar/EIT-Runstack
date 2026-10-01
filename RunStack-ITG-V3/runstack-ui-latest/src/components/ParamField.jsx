// src/components/ParamField.jsx
//
// One SSM document parameter as a form control, from the parameter spec the
// backend returns (name, type, description, default, required,
// allowed_values, display_type, max_chars). Shared by SQL Health Check and
// Run Automations so both pages present document parameters the same way.

import React from 'react';
import { FormRow, Input, Select, Textarea } from './ui';

export default function ParamField({ spec, value, onChange, error }) {
  const label = <>{spec.name}{spec.required && <span style={{ color: '#B91C1C' }}> *</span>}</>;
  const hintParts = [spec.description, spec.type === 'StringList' ? 'One value per line.' : null].filter(Boolean);
  let control;
  if (spec.allowed_values?.length && spec.type !== 'StringList') {
    control = (
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
        <option value="">Choose…</option>
        {spec.allowed_values.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </Select>
    );
  } else if (spec.type === 'Boolean') {
    control = (
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
        <option value="">Choose…</option><option value="true">true</option><option value="false">false</option>
      </Select>
    );
  } else if (spec.type === 'StringList' || spec.display_type === 'textarea') {
    control = <Textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={{ minHeight: 70 }} aria-invalid={!!error} />;
  } else {
    control = (
      <Input value={value ?? ''} inputMode={spec.type === 'Integer' ? 'numeric' : undefined}
        maxLength={spec.max_chars || 1024} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}
        style={error ? { borderColor: '#F7B9B9' } : undefined} />
    );
  }
  return (
    <FormRow label={label} hint={hintParts.join(' ') || null}>
      {control}
      {error && <div role="alert" style={{ fontSize: 12, color: '#B91C1C' }}>{error}</div>}
    </FormRow>
  );
}
