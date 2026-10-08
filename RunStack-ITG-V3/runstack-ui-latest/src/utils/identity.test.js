import { displayNameFromClaims, environmentLabel, initialsFor, isProductionEnv, roleLabel } from './identity';

test.each([
  [{ name: 'Ramya V' }, 'x@dxc.com', 'Ramya V'],
  [{ given_name: 'Priya', family_name: 'Sharma' }, 'x@dxc.com', 'Priya Sharma'],
  [{}, 'priya.sharma@dxc.com', 'Priya Sharma'],
  [{}, 'ramyav@dxc.com', 'Ramyav'],
  [null, 'AzureAD_john_doe2@dxc.com', 'John Doe2'],
  [{}, '', 'Signed in'],
])('display name %#', (claims, email, expected) => {
  expect(displayNameFromClaims(claims, email)).toBe(expected);
});

test('initials', () => {
  expect(initialsFor('Priya Sharma')).toBe('PS');
  expect(initialsFor('Ramyav')).toBe('RA');
  expect(initialsFor('')).toBe('?');
});

test('environment label defaults to ITG (the previous hard-coded value)', () => {
  expect(environmentLabel(undefined)).toBe('ITG');
  expect(environmentLabel('prod')).toBe('PROD');
  expect(isProductionEnv('PROD')).toBe(true);
  expect(isProductionEnv('ITG')).toBe(false);
});

test('role labels', () => {
  expect(roleLabel('admin')).toBe('Administrator');
  expect(roleLabel('none')).toBe('No RunStack role');
  expect(roleLabel('app_operator')).toBe('App operator');
});

describe('team labels (display only)', () => {
  const { accessLabel, teamsText, teamLabels } = require('./identity');
  test('team-only user shows the team instead of "No RunStack role"', () => {
    expect(accessLabel('none', ['runstack-team-gdba-sql'])).toBe('GDBA SQL');
    expect(accessLabel('none', ['runstack-team-sap', 'runstack-team-gdba-sql'])).toBe('GDBA SQL · SAP App');
    expect(accessLabel('none', ['runstack-team-tidal', 'runstack-team-gdba-ora', 'runstack-team-sap'])).toBe('GDBA ORA · SAP App · Tidal');
  });
  test('a platform role always wins', () => {
    expect(accessLabel('operator', ['runstack-team-sap'])).toBe('Operator');
  });
  test('no role and no team', () => {
    expect(accessLabel('none', ['runstack-viewers'])).toBe('No RunStack role');
    expect(teamsText([])).toBeNull();
  });
  test('old GDBA group maps to the same team; unknown team groups are readable', () => {
    expect(teamLabels(['runstack-team-gdba', 'runstack-team-gdba-sql'])).toEqual(['GDBA SQL']);
    expect(teamLabels(['runstack-team-oracle-dba'])).toEqual(['Oracle Dba']);
  });
});
