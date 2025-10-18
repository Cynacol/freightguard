// server.js
// FreightGuard MVP (ADG 7.9, All Classes, States). Prototype only - NOT legal advice.
// Node >= 16. Modular: DG, pallet swaps, runsheet, load planning, SDS lookup.

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const dayjs = require('dayjs');
const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');

// -------- Config ----------
const PORT = process.env.PORT || 3000; 
const PG_CONFIG = {
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DB || 'freightguard',
  password: process.env.PG_PASS || 'Aaren91010',
  port: process.env.PG_PORT || 5432
};
const DEFAULT_PLAN = { tier: 'basic', limit: 50, monthly_fee: 99, start_date: dayjs().startOf('month').toISOString() };
const stateConfig = {
  SA: { placard_threshold: 500, dg_license_threshold: 500, lq_mixed_adjust: 0.25, regulator: 'SafeWork SA', border_permit: true, urban_segregation: true },
  NSW: { placard_threshold: 1000, dg_license_threshold: 500, lq_mixed_adjust: 0.2, regulator: 'EPA NSW', border_permit: true, urban_segregation: true },
  VIC: { placard_threshold: 1000, dg_license_threshold: 500, lq_mixed_adjust: 0.25, regulator: 'WorkSafe VIC', border_permit: true, urban_segregation: false },
  QLD: { placard_threshold: 1000, dg_license_threshold: 500, lq_mixed_adjust: 0.25, regulator: 'WorkSafe QLD', border_permit: true, urban_segregation: false },
  WA: { placard_threshold: 1000, dg_license_threshold: 1000, lq_mixed_adjust: 0.3, regulator: 'WorkSafe WA', border_permit: false, urban_segregation: false },
  TAS: { placard_threshold: 1000, dg_license_threshold: 500, lq_mixed_adjust: 0.25, regulator: 'WorkSafe TAS', border_permit: true, urban_segregation: false },
  NT: { placard_threshold: 1000, dg_license_threshold: 1000, lq_mixed_adjust: 0.3, regulator: 'NT WorkSafe', border_permit: false, urban_segregation: false },
  ACT: { placard_threshold: 1000, dg_license_threshold: 500, lq_mixed_adjust: 0.25, regulator: 'WorkSafe ACT', border_permit: true, urban_segregation: false }
};
let loadedModules = ['dg_compliance', 'load_plan', 'pallet_swap', 'runsheet'];
// --------------------------

// Init DB
const pool = new Pool(PG_CONFIG);
pool.query(`
  CREATE TABLE IF NOT EXISTS checks (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    module TEXT,
    payload JSONB,
    result JSONB,
    attachments JSONB
  );
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    api_key TEXT UNIQUE,
    plan JSONB,
    locked BOOLEAN DEFAULT FALSE
  );
  CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    level TEXT,
    msg TEXT
  );
`).catch(err => console.error('DB init:', err));

// Logger
async function log(level, msg) {
  const now = dayjs().toISOString();
  try { await pool.query('INSERT INTO logs (created_at, level, msg) VALUES ($1, $2, $3)', [now, level, msg]); } 
  catch (e) { console.error('Log insert failed:', e); }
  console[level === 'error' ? 'error' : 'log'](`${now} [${level}] ${msg}`);
}


// Modular Rules
const modules = {
  dg_compliance: {
    rules: [
      { id: 'placard_check', condition: { op: 'or', args: [
          { op: 'and', args: [{ op: '>=', left: 'total_mass_kg', right: 'placard_threshold' }, { op: 'in', left: 'hazard_class', right: ['1', '2.1', '2.2', '2.3', '3', '4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '6.2', '7', '8', '9'] }] },
          { op: 'and', args: [{ op: '>=', left: 'total_mass_kg', right: 500 }, { op: '==', left: 'state', right: 'SA' }] }
        ]}, action: 'placard_required = TRUE', citation: 'ADG 7.9 Clause 5.3.1' },
      { id: 'driver_license_state', condition: { op: 'and', args: [
          { op: '>', left: 'total_mass_kg', right: 'dg_license_threshold' },
          { op: '==', left: 'driver_dg_licensed', right: false },
          { op: 'or', args: [{ op: '!=', left: 'hazard_class', right: '7' }, { op: 'not', args: [{ op: 'in', left: 'state', right: ['NT', 'WA'] }] }] }
        ]}, action: 'require_dg_license = TRUE', citation: 'State DG Regs' },
      { id: 'segregation_matrix', condition: { op: 'and', args: [
          { op: '>=', left: 'un_numbers.length', right: 1 },
          { op: '==', left: 'segregation_check', right: true }
        ]}, action: 'segregation_required = TRUE; alert = "Segregation needed per Table 9.2: [distance/barrier]"', citation: 'ADG 7.9 Table 9.2, Part 9.1' },
      { id: 'uncleaned_packaging', condition: { op: 'and', args: [{ op: '==', left: 'packaging_type', right: 'IBC' }, { op: '==', left: 'cleaned_cert', right: false }] },
        action: 'require_cleaning = TRUE', citation: 'ADG Part 4.2' },
      { id: 'explosives_check', condition: { op: 'and', args: [{ op: 'in', left: 'hazard_class', right: ['1'] }, { op: '==', left: 'blast_risk_assessed', right: false }] },
        action: 'blast_risk = TRUE', citation: 'ADG Part 9.1' },
      { id: 'gas_valve_check', condition: { op: 'and', args: [{ op: 'in', left: 'hazard_class', right: ['2.1', '2.2', '2.3'] }, { op: '==', left: 'valve_inspected', right: false }] },
        action: 'valve_inspection = TRUE', citation: 'ADG Part 4.1.6' },
      { id: 'radioactive_shielding', condition: { op: 'and', args: [{ op: '==', left: 'hazard_class', right: '7' }, { op: '==', left: 'shielding_cert', right: false }, { op: 'not', args: [{ op: 'in', left: 'state', right: ['NT', 'WA'] }] }] },
        action: 'shielding_required = TRUE', citation: 'ADG Part 7.2' },
      { id: 'infectious_containment', condition: { op: 'and', args: [{ op: '==', left: 'hazard_class', right: '6.2' }, { op: '==', left: 'biohazard_containment', right: false }] },
        action: 'biohazard_containment = TRUE', citation: 'ADG Part 4.1.8' },
      { id: 'corrosive_packaging', condition: { op: 'and', args: [{ op: '==', left: 'hazard_class', right: '8' }, { op: '==', left: 'corrosion_resistant', right: false }] },
        action: 'corrosion_resistant = TRUE', citation: 'ADG Part 4.1.4' },
      { id: 'lithium_marking', condition: { op: 'and', args: [{ op: '==', left: 'hazard_class', right: '9' }, { op: 'includes', left: 'un_numbers', right: 'UN3480' }, { op: '==', left: 'lithium_marked', right: false }] },
        action: 'lithium_marking = TRUE', citation: 'ADG Part 5.2' },
      { id: 'lq_mixed_check', condition: { op: 'and', args: [{ op: '>', left: 'total_mass_kg', right: 'lq_adjusted_threshold' }, { op: '>', left: 'un_numbers.length', right: 1 }] },
        action: 'lq_placard_required = TRUE', citation: 'ADG Table 5.3.2' },
      { id: 'border_permit', condition: { op: 'and', args: [{ op: '>', left: 'total_mass_kg', right: 1000 }, { op: '==', left: 'border_permit', right: true }, { op: '==', left: 'has_nhvr_permit', right: false }] },
        action: 'require_nhvr_permit = TRUE', citation: 'NHVR Guidelines' }
    ]
  },
  pallet_swap: {
    rules: [
      { id: 'pallet_compat', condition: { op: 'and', args: [{ op: 'in', left: 'hazard_class', right: ['3', '4.1'] }, { op: '!=', left: 'pallet_type', right: 'non_sparking' }] },
        action: 'swap_required = TRUE', citation: 'ADG Part 4' },
      { id: 'pallet_weight', condition: { op: '>', left: 'total_mass_kg', right: 2000 },
        action: 'heavy_duty_pallet = TRUE', citation: 'ADG Part 4' }
    ]
  },
  load_plan: {
    rules: [
      { id: 'weight_limit', condition: { op: '>', left: 'total_mass_kg', right: 24000 },
        action: 'over_weight = TRUE; alert = "Exceeds standard truck limit (24t)"', citation: 'NHVR Mass Limits' },
      { id: 'volume_limit', condition: { op: '>', left: 'total_volume_m3', right: 60 },
        action: 'over_volume = TRUE; alert = "Exceeds standard trailer volume (60m³)"', citation: 'NHVR Dimensions' },
      { id: 'pallet_suggestion', condition: { op: 'and', args: [{ op: '>', left: 'total_mass_kg', right: 1000 }, { op: '==', left: 'pallet_type', right: 'standard' }] },
        action: 'suggest_heavy_duty = TRUE', citation: 'Industry best practice' }
    ]
  },
  runsheet: { rules: [] }
};

// Load module
function loadModule(moduleName) {
  if (modules[moduleName] && !loadedModules.includes(moduleName)) {
    loadedModules.push(moduleName);
    log('info', `Loaded module: ${moduleName}`);
  }
}

// Eval condition
function evalCondition(cond, payload) {
  const ops = {
    '==': (l, r) => l === r,
    '!=': (l, r) => l !== r,
    '>': (l, r) => Number(l) > Number(r),
    '<': (l, r) => Number(l) < Number(r),
    '>=': (l, r) => Number(l) >= Number(r),
    '<=': (l, r) => Number(l) <= Number(r),
    'in': (l, rArr) => Array.isArray(rArr) && rArr.includes(String(l)),
    'includes': (arr, val) => Array.isArray(arr) && arr.map(x => String(x).trim()).includes(String(val).trim()),
    'and': (args) => args.every(Boolean),
    'or': (args) => args.some(Boolean),
    'not': (args) => !args[0],
    'length': (arr) => Array.isArray(arr) ? arr.length : 0
  };
  if (!cond) return false;
  if (cond.op === 'and' || cond.op === 'or') return ops[cond.op](cond.args.map(a => evalCondition(a, payload)));
  
  let leftVal;
  if (cond.left.endsWith('.length')) {
    const arrName = cond.left.replace('.length', '');
    leftVal = ops.length(payload[arrName] || []);
  } else if (payload.hasOwnProperty(cond.left)) leftVal = payload[cond.left];
  else {
    const state = payload.state_override || payload.state || 'SA';
    const config = stateConfig[state] || stateConfig.SA;
    if (cond.left === 'lq_adjusted_threshold') leftVal = config.placard_threshold * config.lq_mixed_adjust;
    else leftVal = config[cond.left] ?? cond.left;
  }
  return ops[cond.op](leftVal, cond.right);
}

// Run rules
async function runRules(payload, module = 'dg_compliance') {
  loadModule(module);
  const modRules = modules[module].rules || [];
  const alerts = [];
  let compliant = true;

  // Class 1 UN-to-Compatibility Group
  const class1UnToGroup = {
    'UN0004': 'D', // Ammonium nitrate explosive, 1.1D
    'UN0081': 'C', // Explosive, blasting, type A, 1.1C
    'UN0133': 'A', // Mannitol hexanitrate, 1.1A
    'UN0222': 'B', // Ammonium nitrate, 1.1B
    'UN0331': 'E' // Explosive, blasting, type B, 1.5D
  };

  // Class 1 Compatibility Matrix (ADG Table 9.1)
  const class1Matrix = {
    'A': { 'A': '', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': 'X' },
    'B': { 'A': 'X', 'B': '', 'C': 'Away', 'D': 'Away', 'E': 'Away', 'F': 'X', 'G': 'X', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'C': { 'A': 'X', 'B': 'Away', 'C': '', 'D': '', 'E': '', 'F': 'Away', 'G': 'Away', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'D': { 'A': 'X', 'B': 'Away', 'C': '', 'D': '', 'E': '', 'F': 'Away', 'G': 'Away', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'E': { 'A': 'X', 'B': 'Away', 'C': '', 'D': '', 'E': '', 'F': 'Away', 'G': 'Away', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'F': { 'A': 'X', 'B': 'X', 'C': 'Away', 'D': 'Away', 'E': 'Away', 'F': '', 'G': 'X', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'G': { 'A': 'X', 'B': 'X', 'C': 'Away', 'D': 'Away', 'E': 'Away', 'F': 'X', 'G': '', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'H': { 'A': 'X', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': '', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'J': { 'A': 'X', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': 'X', 'J': '', 'K': 'X', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'K': { 'A': 'X', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': 'X', 'J': 'X', 'K': '', 'L': 'X', 'N': 'X', 'O': 'X', 'S': '' },
    'L': { 'A': 'X', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': 'X', 'J': 'X', 'K': 'X', 'L': '', 'N': 'X', 'O': 'X', 'S': 'X' },
    'N': { 'A': 'X', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': '', 'O': 'X', 'S': '' },
    'O': { 'A': 'X', 'B': 'X', 'C': 'X', 'D': 'X', 'E': 'X', 'F': 'X', 'G': 'X', 'H': 'X', 'J': 'X', 'K': 'X', 'L': 'X', 'N': 'X', 'O': '', 'S': 'X' },
    'S': { 'A': 'X', 'B': '', 'C': '', 'D': '', 'E': '', 'F': '', 'G': '', 'H': '', 'J': '', 'K': '', 'L': 'X', 'N': '', 'O': 'X', 'S': '' }
  };

  // Table 9.2 Segregation Matrix
  const segregationMatrix = {
    '1': { '1': '', '2.1': 'X', '2.2': 'X', '2.3': 'X', '3': 'X', '4.1': 'X', '4.2': 'X', '4.3': 'X', '5.1': 'X', '5.2': 'X', '6.1': 'X', '6.2': 'X', '7': 'X', '8': 'X', '9': 'X' },
    '2.1': { '1': 'X', '2.1': '', '2.2': '', '2.3': '', '3': '', '4.1': '', '4.2': 'Away', '4.3': 'X', '5.1': 'X', '5.2': 'X', '6.1': '', '6.2': 'X', '7': 'Away', '8': '', '9': '' },
    '2.2': { '1': 'X', '2.1': '', '2.2': '', '2.3': '', '3': '', '4.1': '', '4.2': '', '4.3': '', '5.1': '', '5.2': '', '6.1': '', '6.2': 'X', '7': '', '8': '', '9': '' },
    '2.3': { '1': 'X', '2.1': '', '2.2': '', '2.3': '', '3': 'Away', '4.1': 'Away', '4.2': 'Away', '4.3': 'Away', '5.1': 'Away', '5.2': 'Away', '6.1': 'Away', '6.2': 'X', '7': 'Away', '8': 'Away', '9': 'Away' },
    '3': { '1': 'X', '2.1': '', '2.2': '', '2.3': 'Away', '3': '', '4.1': '', '4.2': 'Away', '4.3': 'X', '5.1': 'X', '5.2': 'X', '6.1': 'Away', '6.2': 'X', '7': 'Away', '8': 'Away', '9': '' },
    '4.1': { '1': 'X', '2.1': '', '2.2': '', '2.3': 'Away', '3': '', '4.1': '', '4.2': '', '4.3': 'X', '5.1': 'X', '5.2': 'X', '6.1': '', '6.2': 'X', '7': '', '8': '', '9': '' },
    '4.2': { '1': 'X', '2.1': 'Away', '2.2': '', '2.3': 'Away', '3': 'Away', '4.1': '', '4.2': '', '4.3': 'X', '5.1': 'X', '5.2': 'X', '6.1': 'Away', '6.2': 'X', '7': 'Away', '8': 'Away', '9': '' },
    '4.3': { '1': 'X', '2.1': 'X', '2.2': '', '2.3': 'Away', '3': 'X', '4.1': 'X', '4.2': 'X', '4.3': '', '5.1': 'X', '5.2': 'X', '6.1': 'X', '6.2': 'X', '7': 'X', '8': 'X', '9': '' },
    '5.1': { '1': 'X', '2.1': 'X', '2.2': '', '2.3': 'Away', '3': 'X', '4.1': 'X', '4.2': 'X', '4.3': 'X', '5.1': '', '5.2': 'X', '6.1': 'Away', '6.2': 'X', '7': 'Away', '8': 'Away', '9': '' },
    '5.2': { '1': 'X', '2.1': 'X', '2.2': '', '2.3': 'Away', '3': 'X', '4.1': 'X', '4.2': 'X', '4.3': 'X', '5.1': 'X', '5.2': '', '6.1': 'X', '6.2': 'X', '7': 'X', '8': 'X', '9': '' },
    '6.1': { '1': 'X', '2.1': '', '2.2': '', '2.3': 'Away', '3': 'Away', '4.1': '', '4.2': 'Away', '4.3': 'X', '5.1': 'Away', '5.2': 'X', '6.1': '', '6.2': 'X', '7': 'Away', '8': 'Away', '9': '' },
    '6.2': { '1': 'X', '2.1': 'X', '2.2': 'X', '2.3': 'X', '3': 'X', '4.1': 'X', '4.2': 'X', '4.3': 'X', '5.1': 'X', '5.2': 'X', '6.1': 'X', '6.2': '', '7': 'X', '8': 'X', '9': 'X' },
    '7': { '1': 'X', '2.1': 'Away', '2.2': '', '2.3': 'Away', '3': 'Away', '4.1': '', '4.2': 'Away', '4.3': 'X', '5.1': 'Away', '5.2': 'X', '6.1': 'Away', '6.2': 'X', '7': '', '8': 'Away', '9': 'Away' },
    '8': { '1': 'X', '2.1': '', '2.2': '', '2.3': 'Away', '3': 'Away', '4.1': '', '4.2': 'Away', '4.3': 'X', '5.1': 'Away', '5.2': 'X', '6.1': 'Away', '6.2': 'X', '7': 'Away', '8': '', '9': '' },
    '9': { '1': 'X', '2.1': '', '2.2': '', '2.3': 'Away', '3': '', '4.1': '', '4.2': '', '4.3': '', '5.1': '', '5.2': '', '6.1': '', '6.2': 'X', '7': 'Away', '8': '', '9': '' }
  };

  // Compute segregation_check
  const primaryClass = payload.hazard_class || 'N/A';
  const secondaryClasses = [
    payload.residues_class,
    payload.subsidiary_hazard,
    ...(payload.un_numbers || []).map(un => {
      const unMap = {
        'UN1486': '5.1', 'UN1190': '3', 'UN0004': '1', 'UN1950': '2.1',
        'UN2810': '6.1', 'UN2915': '7', 'UN1805': '8', 'UN3480': '9',
        ...class1UnToGroup
      };
      return unMap[un] || 'N/A';
    })
  ].filter(c => c && c !== 'N/A');

  let class1Check = true;
  if (primaryClass === '1' || secondaryClasses.some(sc => sc === '1')) {
    const primaryGroup = primaryClass === '1' ? class1UnToGroup[payload.un_numbers?.[0]] || 'X' : null;
    const secondaryGroups = payload.un_numbers?.map(un => class1UnToGroup[un] || 'X').filter(g => g !== 'X');
    class1Check = secondaryGroups.every(sg => {
      if (!primaryGroup || primaryGroup === sg) return true;
      return class1Matrix[primaryGroup]?.[sg] !== 'X' && class1Matrix[primaryGroup]?.[sg] !== 'Away';
    });
  }

  payload.segregation_check = !class1Check || secondaryClasses.some(sc => {
    const req = segregationMatrix[primaryClass]?.[sc] || segregationMatrix[sc]?.[primaryClass] || '';
    return req === 'X' || req === 'Away';
  });
  if (payload.segregation_check) {
    const state = payload.state_override || payload.state || 'SA';
    const urban = stateConfig[state]?.urban_segregation;
    const details = secondaryClasses.map(sc => ({
      class: sc,
      requirement: sc === '1' ? (class1Check ? 'Compatible' : class1Matrix[class1UnToGroup[payload.un_numbers?.[0]]]?.[class1UnToGroup[payload.un_numbers?.[1]]] || 'X') : segregationMatrix[primaryClass]?.[sc] || segregationMatrix[sc]?.[primaryClass] || '',
      action: sc === '1' ? (class1Check ? 'No segregation needed' : class1Matrix[class1UnToGroup[payload.un_numbers?.[0]]]?.[sg] === 'X' ? (urban ? 'Segregate (separate vehicle)' : 'Segregate (3m)') : 'Separate within vehicle') : (segregationMatrix[primaryClass]?.[sc] === 'X' ? (urban ? 'Segregate (separate vehicle)' : 'Segregate (3m)') : 'Separate within vehicle')
    }));
    payload.segregation_details = details;
  }

  modRules.forEach(rule => {
    try {
      if (evalCondition(rule.condition, payload)) {
        alerts.push({ id: rule.id, action: rule.action, citation: rule.citation });
        compliant = false;
      }
    } catch (err) {
      log('error', `Rule eval ${rule.id}: ${err.message}`);
    }
  });
  return { alerts, compliant, segregation_details: payload.segregation_details };
}

// Mock NHVR permit check
async function checkNHVRPermit(payload) {
  return payload.has_nhvr_permit || false;
}

// Billing
function calculateBilling(usage, plan = DEFAULT_PLAN) {
  const now = dayjs();
  const planStart = dayjs(plan.start_date);
  const daysInMonth = planStart.daysInMonth();
  const remainingDays = Math.max(1, daysInMonth - now.date() + 1);
  const prorataFactor = remainingDays / daysInMonth;
  const baseFee = plan.monthly_fee * prorataFactor;
  const overage = usage.shipments > plan.limit ? (usage.shipments - plan.limit) * 0.20 : 0;
  const total = Number((baseFee + overage).toFixed(2));
  return { total, breakdown: { prorataFactor, baseFee, overage } };
}

// PDF generator
async function generateManifestPdf(payload, result, isRunsheet = false) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const now = dayjs().format('YYYY-MM-DD HH:mm');
  const state = payload.state || payload.state_override || 'SA';
  const config = stateConfig[state] || stateConfig.SA;

  if (isRunsheet) {
    payload.runsheet.forEach((load, i) => {
      const page = pdfDoc.addPage([595, 842]);
      const eipText = load.total_mass_kg >= config.placard_threshold ? `EIP: 500mm x 500mm, Class ${load.hazard_class} (${config.regulator})` : 'EIP not required';
      const lines = [
        `FreightGuard Runsheet Load ${i + 1} - Module: ${result.module || 'runsheet'}`,
        `Generated: ${now} | State: ${load.state || state}`,
        `UN: ${Array.isArray(load.un_numbers) ? load.un_numbers.join(', ') : load.un_numbers}`,
        `Mass (kg): ${load.total_mass_kg} | Volume (m³): ${load.total_volume_m3 || 'N/A'}`,
        `Class: ${load.hazard_class || 'N/A'} | Packaging: ${load.packaging_type || 'N/A'}`,
        `Compliant: ${load.result.compliant ? 'Yes' : 'No'}`,
        `Alerts: ${load.result.alerts.map(a => `${a.id}: ${a.action}`).join('; ')}`,
        load.result.segregation_details ? `Segregation: ${load.result.segregation_details.map(d => `${d.class}: ${d.action}`).join('; ')}` : '',
        eipText,
        `Verify with ADG 7.9 & ${config.regulator}. Decision-support only.`
      ];
      let y = 800;
      lines.forEach(line => {
        page.drawText(line, { x: 50, y, size: 10, font });
        y -= 14;
      });
    });
  } else {
    const page = pdfDoc.addPage([595, 842]);
    const eipText = payload.total_mass_kg >= config.placard_threshold ? `EIP: 500mm x 500mm, Class ${payload.hazard_class || 'N/A'} (${config.regulator})` : 'EIP not required';
    const lines = [
      `FreightGuard Manifest - Module: ${result.module || 'DG'}`,
      `Generated: ${now} | State: ${state}`,
      `UN: ${Array.isArray(payload.un_numbers) ? payload.un_numbers.join(', ') : payload.un_numbers}`,
      `Mass (kg): ${payload.total_mass_kg} | Volume (m³): ${payload.total_volume_m3 || 'N/A'}`,
      `Class: ${payload.hazard_class || 'N/A'} | Packaging: ${payload.packaging_type || 'N/A'}`,
      `Compliant: ${result.compliant ? 'Yes' : 'No'}`,
      `Alerts: ${result.alerts.map(a => `${a.id}: ${a.action} (${a.citation})`).join('; ')}`,
      result.segregation_details ? `Segregation: ${result.segregation_details.map(d => `${d.class}: ${d.action}`).join('; ')}` : '',
      eipText,
      `Verify with ADG 7.9 & ${config.regulator}. Decision-support only.`
    ];
    let y = 800;
    lines.forEach(line => {
      page.drawText(line, { x: 50, y, size: 10, font });
      y -= 14;
    });
  }
  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

// Payment lockout
async function paymentLockout(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const { rows } = await pool.query('SELECT locked FROM users WHERE api_key = $1', [apiKey]);
  if (!rows[0] || rows[0].locked) return res.status(402).json({ ok: false, error: 'Account locked or invalid API key.' });
  next();
}

// API key generator
async function generateApiKey(userId) {
  const key = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET api_key = $1 WHERE id = $2', [key, userId]);
  return key;
}

// Express app
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, modules: loadedModules }));

app.post('/api/register-key', async (req, res) => {
  try {
    const { userId } = req.body;
    const key = await generateApiKey(userId);
    res.json({ ok: true, api_key: key });
  } catch (err) {
    log('error', `Register key: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sds-lookup', async (req, res) => {
  try {
    const { chemical_name } = req.body;
    if (!chemical_name) return res.status(400).json({ ok: false, error: 'Chemical name required' });

    const response = await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(chemical_name)}/JSON`);
    const data = await response.json();
    const compound = data.PC_Compounds?.[0] || {};
    const un_number = compound.props?.find(p => p.urn.label === 'UN Number')?.value.sval || 'Unknown';
    const hazard_class = compound.props?.find(p => p.urn.label === 'Hazard Class')?.value.sval || 'Unknown';
    const subsidiary_hazard = compound.props?.find(p => p.urn.label === 'Subsidiary Hazard')?.value.sval || '';
    const sds_link = `https://pubchem.ncbi.nlm.nih.gov/compound/${compound.id?.id?.id || 'N/A'}#section=Safety-and-Hazards`;

    await pool.query('INSERT INTO checks (module, payload, result) VALUES ($1, $2, $3)',
      ['sds_lookup', { chemical_name }, { un_number, hazard_class, subsidiary_hazard, sds_link }]);

    res.json({
      ok: true,
      data: { un_number, hazard_class, subsidiary_hazard, sds_link },
      disclaimer: 'PubChem data for reference. Verify full SDS with supplier per ADG 7.9 Part 11.1.'
    });
  } catch (err) {
    log('error', `SDS lookup: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/check', paymentLockout, async (req, res) => {
  try {
    let { module = 'dg_compliance', chemical_name, state_override, ...data } = req.body;
    data.state = state_override || data.state || 'SA';

    if (chemical_name) {
      const sdsRes = await fetch('http://localhost:3000/api/sds-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chemical_name })
      });
      const sdsData = await sdsRes.json();
      if (sdsData.ok) {
        data.un_numbers = data.un_numbers || [sdsData.data.un_number];
        data.hazard_class = data.hazard_class || sdsData.data.hazard_class;
        data.subsidiary_hazard = data.subsidiary_hazard || sdsData.data.subsidiary_hazard;
        data.attachments = data.attachments || [sdsData.data.sds_link];
        log('info', `SDS auto-filled for ${chemical_name}: UN ${sdsData.data.un_number}`);
      }
    }

    const result = await runRules(data, module);
    result.module = module;

    if (module === 'dg_compliance' && data.total_mass_kg > 1000) {
      const nhvrValid = await checkNHVRPermit(data);
      if (!nhvrValid) result.alerts.push({ id: 'nhvr_mock', action: 'nhvr_permit_missing = TRUE', citation: 'Mock NHVR check' });
    }

    await pool.query('INSERT INTO checks (module, payload, result, attachments) VALUES ($1, $2, $3, $4)',
      [module, data, result, data.attachments || []]);

    const pdfBytes = await generateManifestPdf(data, result);
    const usage = { shipments: 1 };
    const billing = calculateBilling(usage, data.plan || DEFAULT_PLAN);

    res.json({ ok: true, results: result, billing, pdfBase64: Buffer.from(pdfBytes).toString('base64'), disclaimer: 'Decision-support only. Verify ADG 7.9 & state regs.' });
  } catch (err) {
    log('error', `Check: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/check-runsheet', paymentLockout, async (req, res) => {
  try {
    const { runsheet = [], module = 'runsheet', state_override } = req.body;
    loadModule('dg_compliance');
    loadModule('pallet_swap');
    loadModule('load_plan');
    let allCompliant = true;
    let allAlerts = [];
    let totalShipments = runsheet.length;
    for (const load of runsheet) {
      load.state = state_override || load.state || 'SA';
      const dgResult = await runRules(load, 'dg_compliance');
      const palletResult = load.pallet_type ? await runRules(load, 'pallet_swap') : { alerts: [], compliant: true };
      const planResult = await runRules(load, 'load_plan');
      if (load.total_mass_kg > 1000) {
        const nhvrValid = await checkNHVRPermit(load);
        if (!nhvrValid) dgResult.alerts.push({ id: 'nhvr_mock', action: 'nhvr_permit_missing = TRUE', citation: 'Mock NHVR check' });
      }
      allCompliant = allCompliant && dgResult.compliant && palletResult.compliant && planResult.compliant;
      allAlerts.push(...dgResult.alerts, ...palletResult.alerts, ...planResult.alerts);
      load.result = { dg: dgResult, pallet: palletResult, plan: planResult };
    }

    await pool.query('INSERT INTO checks (module, payload, result) VALUES ($1, $2, $3)',
      [module, runsheet, { compliant: allCompliant, alerts: allAlerts }]);

    const pdfBytes = await generateManifestPdf({ runsheet }, { compliant: allCompliant, alerts: allAlerts, module }, true);
    const billing = calculateBilling({ shipments: totalShipments });

    res.json({ ok: true, results: { compliant: allCompliant, alerts: allAlerts, runsheet }, billing, pdfBase64: Buffer.from(pdfBytes).toString('base64'), disclaimer: 'Decision-support only.' });
  } catch (err) {
    log('error', `Runsheet: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/export-audit', paymentLockout, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT created_at, module, payload, result FROM checks ORDER BY created_at DESC LIMIT 1000');
    const csv = ['created_at,module,payload,result', ...rows.map(r => `${r.created_at},${r.module},${JSON.stringify(r.payload)},${JSON.stringify(r.result)}`)].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=audit.csv');
    res.send(csv);
  } catch (err) {
    log('error', `Export audit: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => log('info', `FreightGuard running on ${PORT}`));