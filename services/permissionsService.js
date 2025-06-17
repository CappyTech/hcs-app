const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const filePath = path.join(__dirname, '..', 'permissions.yaml');
let rolePermissions = {};

function loadPermissions() {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    rolePermissions = yaml.load(data) || {};
  } catch (err) {
    rolePermissions = {};
  }
}

function getPermissionsForRole(role) {
  if (!Object.keys(rolePermissions).length) loadPermissions();
  return rolePermissions[role] || {};
}

function getAllPermissions() {
  if (!Object.keys(rolePermissions).length) loadPermissions();
  return rolePermissions;
}

loadPermissions();
module.exports = { getPermissionsForRole, getAllPermissions, loadPermissions };
