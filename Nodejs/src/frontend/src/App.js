import React, { useState, useEffect } from 'react';
import axios from 'axios';

function App() {
  const [form, setForm] = useState({
    module: 'dg_compliance',
    state: 'SA',
    state_override: '',
    chemical_name: '',
    un_numbers: 'UN1486,UN1190',
    residues: 'UN1190',
    residues_class: '3',
    subsidiary_hazard: '',
    total_mass_kg: 5700,
    total_volume_m3: 30,
    hazard_class: '5.1',
    packaging_type: 'IBC',
    cleaned_cert: false,
    driver_dg_licensed: false,
    has_nhvr_permit: false,
    pallet_type: 'standard',
    blast_risk_assessed: false,
    valve_inspected: false,
    shielding_cert: false,
    biohazard_containment: false,
    corrosion_resistant: false,
    lithium_marked: false,
    plan: { tier: 'basic', limit: 50, monthly_fee: 99 },
    api_key: 'demo',
    attachments: [],
    runsheet: ''
  });

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [pictograms, setPictograms] = useState([]);
  const API = process.env.REACT_APP_API || 'http://localhost:3000/api';

  const onChange = (k, v) => setForm({ ...form, [k]: v });

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (form.chemical_name.length > 2) {
        const mockChemicals = ['potassium nitrate', 'ethyl formate', 'ammonium nitrate', 'phosphoric acid', 'lithium battery'];
        setSuggestions(mockChemicals.filter(c => c.toLowerCase().includes(form.chemical_name.toLowerCase())));
      } else {
        setSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [form.chemical_name]);

  const fetchPictograms = async (hazard_class) => {
    const pictogramMap = {
      '5.1': { src: 'oxidizer.png', tooltip: 'Oxidizer: May cause or intensify fire' },
      '3': { src: 'flammable.png', tooltip: 'Flammable: Ignites easily' },
      '6.2': { src: 'biohazard.png', tooltip: 'Infectious: Biohazard risk' },
      '1': { src: 'explosive.png', tooltip: 'Explosive: Blast or projection hazard' },
      '2.1': { src: 'flammable_gas.png', tooltip: 'Flammable Gas: Ignites easily' },
      '2.3': { src: 'toxic_gas.png', tooltip: 'Toxic Gas: Harmful if inhaled' },
      '7': { src: 'radioactive.png', tooltip: 'Radioactive: Radiation hazard' },
      '8': { src: 'corrosive.png', tooltip: 'Corrosive: Damages skin or materials' },
      '9': { src: 'misc_hazard.png', tooltip: 'Miscellaneous: Various hazards' }
    };
    return [pictogramMap[hazard_class] || { src: 'unknown.png', tooltip: 'Hazard' }];
  };

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      if (file.type.includes('csv')) {
        const text = ev.target.result;
        const rows = text.split('\n').slice(1).map(row => {
          const [un_numbers, residues, residues_class, mass, volume, hclass, ptype, cleaned, state, licensed, nhvr, pallet, blast, valve, shield, bio, corr, lith] = row.split(',');
          return {
            un_numbers: un_numbers.split(';').map(u => u.trim()),
            residues: residues.split(';').map(r => r.trim()).filter(Boolean),
            residues_class,
            total_mass_kg: Number(mass),
            total_volume_m3: Number(volume),
            hazard_class: hclass,
            packaging_type: ptype,
            cleaned_cert: cleaned === 'true',
            state,
            driver_dg_licensed: licensed === 'true',
            has_nhvr_permit: nhvr === 'true',
            pallet_type: pallet,
            blast_risk_assessed: blast === 'true',
            valve_inspected: valve === 'true',
            shielding_cert: shield === 'true',
            biohazard_containment: bio === 'true',
            corrosion_resistant: corr === 'true',
            lithium_marked: lith === 'true'
          };
        });
        setForm({ ...form, runsheet: JSON.stringify(rows) });
      } else {
        const base64 = ev.target.result.split(',')[1];
        try {
          await axios.post(`${API}/upload-attachment`, { base64, filename: file.name });
          setForm({ ...form, attachments: [...form.attachments, file.name] });
        } catch (err) {
          alert('Upload failed: ' + err.message);
        }
      }
    };
    reader.readAsDataURL(file);
  };

  const lookupSDS = async () => {
    setLoading(true);
    try {
      const r = await axios.post(`${API}/sds-lookup`, { chemical_name: form.chemical_name });
      if (r.data.ok) {
        setForm({
          ...form,
          un_numbers: r.data.data.un_number,
          hazard_class: r.data.data.hazard_class,
          subsidiary_hazard: r.data.data.subsidiary_hazard || '',
        });
        setPictograms(await fetchPictograms(r.data.data.hazard_class));
        alert(`Auto-filled: UN ${r.data.data.un_number}, Class ${r.data.data.hazard_class}. SDS: ${r.data.data.sds_link}`);
      }
    } catch (err) {
      alert('Lookup failed: ' + err.message);
    }
    setLoading(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);

    const payload = {
      module: form.module,
      state: form.state,
      state_override: form.state_override,
      chemical_name: form.chemical_name,
      un_numbers: form.un_numbers.split(/[,;]/).map(u => u.trim()),
      residues: form.residues.split(/[,;]/).map(r => r.trim()).filter(Boolean),
      residues_class: form.residues_class,
      subsidiary_hazard: form.subsidiary_hazard,
      total_mass_kg: Number(form.total_mass_kg) || 0,
      total_volume_m3: Number(form.total_volume_m3) || 0,
      hazard_class: form.hazard_class,
      packaging_type: form.packaging_type,
      cleaned_cert: form.cleaned_cert,
      driver_dg_licensed: form.driver_dg_licensed,
      has_nhvr_permit: form.has_nhvr_permit,
      pallet_type: form.pallet_type,
      blast_risk_assessed: form.blast_risk_assessed,
      valve_inspected: form.valve_inspected,
      shielding_cert: form.shielding_cert,
      biohazard_containment: form.biohazard_containment,
      corrosion_resistant: form.corrosion_resistant,
      lithium_marked: form.lithium_marked,
      plan: form.plan,
      attachments: form.attachments
    };

    const headers = { 'x-api-key': form.api_key };

    try {
      const endpoint = form.module === 'runsheet' ? '/check-runsheet' : '/check';
      const r = await axios.post(`${API}${endpoint}`, form.module === 'runsheet' ? { runsheet: form.runsheet ? JSON.parse(form.runsheet) : [], state_override: form.state_override } : payload, { headers });
      setResult(r.data);
    } catch (err) {
      setResult({ ok: false, error: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif', maxWidth: '600px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5em' }}>FreightGuard Prototype</h1>
      <form onSubmit={submit}>
        {/* Module, State, Override, Plan, API Key */}
        <div style={{ marginBottom: 10 }}>
          <label>Module: 
            <select value={form.module} onChange={e => onChange('module', e.target.value)}>
              <option>dg_compliance</option><option>pallet_swap</option><option>load_plan</option><option>runsheet</option>
            </select>
          </label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>State: <select value={form.state} onChange={e => onChange('state', e.target.value)}>
            {['SA', 'NSW', 'VIC', 'QLD', 'WA', 'TAS', 'NT', 'ACT'].map(s => <option key={s}>{s}</option>)}
          </select></label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>State Override: <select value={form.state_override} onChange={e => onChange('state_override', e.target.value)}>
            <option value="">None</option>
            {['SA', 'NSW', 'VIC', 'QLD', 'WA', 'TAS', 'NT', 'ACT'].map(s => <option key={s}>{s}</option>)}
          </select></label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>Plan: <select value={form.plan.tier} onChange={e => onChange('plan', { ...form.plan, tier: e.target.value, limit: e.target.value === 'basic' ? 50 : 250, monthly_fee: e.target.value === 'basic' ? 99 : 199 })}>
            <option>basic</option><option>pro</option>
          </select></label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>API Key: <input style={{ width: '100%' }} value={form.api_key} onChange={e => onChange('api_key', e.target.value)} /></label>
        </div>

        {form.module !== 'runsheet' ? (
          <>
            {/* Chemical Info */}
            <div style={{ marginBottom: 10, position: 'relative' }}>
              <label>Chemical Name: 
                <input style={{ width: '100%' }} value={form.chemical_name} onChange={e => onChange('chemical_name', e.target.value)} placeholder="e.g., potassium nitrate" />
              </label>
              {suggestions.length > 0 && (
                <ul style={{ position: 'absolute', background: '#fff', border: '1px solid #ccc', width: '100%', zIndex: 1 }}>
                  {suggestions.map((s, i) => <li key={i} style={{ padding: 5, cursor: 'pointer' }} onClick={() => onChange('chemical_name', s)}>{s}</li>)}
                </ul>
              )}
              {form.chemical_name && <button type="button" onClick={lookupSDS} style={{ marginLeft: 10 }}>Lookup SDS</button>}
            </div>

            <div style={{ marginBottom: 10 }}><label>UN Numbers: <input style={{ width: '100%' }} value={form.un_numbers} onChange={e => onChange('un_numbers', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}><label>Residues: <input style={{ width: '100%' }} value={form.residues} onChange={e => onChange('residues', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}><label>Residue Class: <input style={{ width: '100%' }} value={form.residues_class} onChange={e => onChange('residues_class', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}><label>Subsidiary Hazard: <input style={{ width: '100%' }} value={form.subsidiary_hazard} onChange={e => onChange('subsidiary_hazard', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}><label>Mass kg: <input style={{ width: '100%' }} type="number" value={form.total_mass_kg} onChange={e => onChange('total_mass_kg', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}><label>Volume m³: <input style={{ width: '100%' }} type="number" value={form.total_volume_m3} onChange={e => onChange('total_volume_m3', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}><label>Class: <input style={{ width: '100%' }} value={form.hazard_class} onChange={e => onChange('hazard_class', e.target.value)} /></label></div>
            <div style={{ marginBottom: 10 }}>
              <label>Packaging: <select style={{ width: '100%' }} value={form.packaging_type} onChange={e => onChange('packaging_type', e.target.value)}>
                <option>IBC</option><option>Bags</option><option>Drums</option><option>Cylinders</option>
              </select></label>
            </div>
            {/* Checkboxes */}
            {['cleaned_cert','driver_dg_licensed','has_nhvr_permit','blast_risk_assessed','valve_inspected','shielding_cert','biohazard_containment','corrosion_resistant','lithium_marked'].map(k => (
              <div style={{ marginBottom: 10 }} key={k}>
                <label>
                  <input type="checkbox" checked={form[k]} onChange={e => onChange(k, e.target.checked)} /> {k.replace(/_/g,' ')}
                </label>
              </div>
            ))}
            <div style={{ marginBottom: 10 }}>
              <label>Pallet: <select style={{ width: '100%' }} value={form.pallet_type} onChange={e => onChange('pallet_type', e.target.value)}>
                <option>standard</option><option>non_sparking</option><option>heavy_duty</option>
              </select></label>
            </div>
            <div style={{ marginBottom: 10 }}><label>SDS/Photos: <input type="file" accept="image/*,application/pdf,.csv" onChange={handleFile} /></label></div>
          </>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <label>Runsheet (JSON or CSV): <textarea style={{ width: '100%', height: 100 }} value={form.runsheet} onChange={e => onChange('runsheet', e.target.value)} /></label>
            <label>Upload CSV: <input type="file" accept=".csv" onChange={handleFile} /></label>
          </div>
        )}
        <button type="submit" disabled={loading} style={{ width: '100%', padding: 10 }}>{loading ? 'Processing...' : 'Run Check'}</button>
      </form>

      {pictograms.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <h3>Hazard Pictograms</h3>
          {pictograms.map((p, i) => (
            <span key={i} title={p.tooltip}>
              <img src={`/pictograms/${p.src}`} alt="Hazard" style={{ width: 50, marginRight: 10 }} />
            </span>
          ))}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 20 }}>
          <h2>Results</h2>
          {result.results?.alerts?.map((alert, i) => (
            <div key={i} style={{ background: '#f4f4f4', padding: 10, marginBottom: 5 }}>
              <p><strong>{alert.id}</strong>: {alert.action}</p>
              <p>Citation: {alert.citation}</p>
              {alert.id === 'segregation_matrix' && result.results.segregation_details && (
                <ul>
                  {result.results.segregation_details.map((d, j) => <li key={j}>Class {d.class}: {d.action}</li>)}
                </ul>
              )}
            </div>
          ))}
          <p>Compliant: {result.results?.compliant ? 'Yes' : 'No'}</p>
          {result.results?.alerts?.some(a => a.id === 'segregation_matrix') && (
            <p style={{ color: result.results.segregation_details?.some(d => d.requirement === 'X') ? 'red' : 'orange', fontWeight: 'bold' }}>
              Warning: Incompatible load detected. {result.results.segregation_details?.some(d => d.requirement === 'X') ? 'Segregate (3m or vehicle)' : 'Separate within vehicle'}
            </p>
          )}
          {result.pdfBase64 && <a href={`data:application/pdf;base64,${result.pdfBase64}`} download="freightguard.pdf" style={{ display: 'block', margin: '10px 0' }}>Download PDF</a>}
          {result.billing && <p>Billing: ${result.billing.total.toFixed(2)}</p>}
          <p style={{ color: 'red', fontWeight: 'bold' }}>Decision-support only. Verify ADG 7.9 & state regs.</p>
        </div>
      )}
    </div>
  );
}

export default App;
