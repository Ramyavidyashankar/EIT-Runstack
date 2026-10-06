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
