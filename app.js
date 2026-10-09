'use strict';

/* ================================================================
   Portafoglio — gestione spese personale, tutto salvato sul telefono
   ================================================================ */

const CHIAVE_DATI = 'portafoglio.dati.v1';
const CHIAVE_META = 'portafoglio.meta.v1';
const GIORNI_PROMEMORIA_BACKUP = 30;

/* ---------- Funzioni pure (usate anche nei test) ---------- */

// "4,9" → 490 ; "1.234,50" → 123450 ; "12.5" → 1250 ; "100" → 10000
function importoInCentesimi(testo) {
  if (typeof testo === 'number') return Math.round(testo * 100);
  let s = String(testo || '').trim().replace(/[€\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

// "4/11/2024" → "2024-11-04" ; accetta anche "2024-11-04"
function dataIso(testo) {
  const s = String(testo || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!m) return null;
  let anno = m[3].length === 2 ? '20' + m[3] : m[3];
  const g = +m[1], mese = +m[2];
  if (mese < 1 || mese > 12 || g < 1 || g > 31) return null;
  return `${anno}-${String(mese).padStart(2, '0')}-${String(g).padStart(2, '0')}`;
}

// Parser CSV con supporto a virgolette e virgole nei campi
function leggiCSV(testo) {
  const righe = [];
  let riga = [], campo = '', tra = false;
  testo = String(testo).replace(/^﻿/, '');
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    if (tra) {
      if (c === '"') {
        if (testo[i + 1] === '"') { campo += '"'; i++; }
        else tra = false;
      } else campo += c;
    } else if (c === '"') tra = true;
    else if (c === ',' || c === ';') { riga.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && testo[i + 1] === '\n') i++;
      riga.push(campo); righe.push(riga); riga = []; campo = '';
    } else campo += c;
  }
  if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
  return righe;
}

function nuovoId() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 14);
}

// Converte il CSV del foglio Google (ID, DATA, SPESA, DESCRIZIONE, ENTRATA/USCITA, SPESA MEDICA)
function movimentiDaCSV(testo) {
  const righe = leggiCSV(testo).filter(r => r.some(c => c.trim() !== ''));
  if (!righe.length) return { movimenti: [], scartate: 0 };
  const intest = righe[0].map(h => h.trim().toUpperCase());
  const col = nome => intest.findIndex(h => h === nome || h.startsWith(nome));
  const iId = col('ID'), iData = col('DATA'), iImp = intest.findIndex(h => h === 'SPESA' || h === 'IMPORTO');
  const iDesc = col('DESCRIZIONE'), iTipo = col('ENTRATA'), iMed = col('SPESA MEDICA');
  if (iData < 0 || iImp < 0 || iDesc < 0) throw new Error('Il file CSV non ha le colonne DATA, SPESA e DESCRIZIONE.');
  const movimenti = [];
  let scartate = 0;
  for (const r of righe.slice(1)) {
    const data = dataIso(r[iData]);
    const importo = importoInCentesimi(r[iImp]);
    const descrizione = (r[iDesc] || '').trim();
    if (!data || !Number.isFinite(importo) || importo <= 0) { scartate++; continue; }
    const tipoTesto = (iTipo >= 0 ? r[iTipo] : '').trim().toUpperCase();
    const med = (iMed >= 0 ? r[iMed] : '').trim().toUpperCase();
    movimenti.push({
      id: (iId >= 0 && r[iId] && r[iId].trim()) || nuovoId(),
      data,
      importo,
      descrizione: descrizione || '(senza descrizione)',
      tipo: tipoTesto.startsWith('E') ? 'E' : 'U',
      medica: ['TRUE', 'VERO', 'SI', 'SÌ', '1', 'X'].includes(med),
    });
  }
  return { movimenti, scartate };
}

function movimentiDaJSON(testo) {
  const o = JSON.parse(testo);
  const lista = Array.isArray(o) ? o : o.movimenti;
  if (!Array.isArray(lista)) throw new Error('Il file non sembra un backup di Portafoglio.');
  const movimenti = [];
  let scartate = 0;
  for (const m of lista) {
    const data = dataIso(m.data);
    const importo = Number.isInteger(m.importo) ? m.importo : NaN;
    if (!data || !(importo > 0)) { scartate++; continue; }
    movimenti.push({
      id: String(m.id || nuovoId()), data, importo,
      descrizione: String(m.descrizione || '').slice(0, 120) || '(senza descrizione)',
      tipo: m.tipo === 'E' ? 'E' : 'U', medica: !!m.medica,
    });
  }
  return { movimenti, scartate, saldoIniziale: Number.isInteger(o.saldoIniziale) ? o.saldoIniziale : null };
}

function csvDaMovimenti(movimenti) {
  const q = s => /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const righe = ['ID,DATA,SPESA,DESCRIZIONE,ENTRATA/USCITA,SPESA MEDICA'];
  for (const m of ordina(movimenti)) {
    const [a, me, g] = m.data.split('-');
    const imp = (m.importo / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
    righe.push([m.id, `${g}/${me}/${a}`, q(imp), q(m.descrizione), m.tipo === 'E' ? 'ENTRATA' : 'USCITA', m.medica ? 'TRUE' : 'FALSE'].join(','));
  }
  return righe.join('\n');
}

function ordina(lista) {
  return [...lista].sort((a, b) => b.data.localeCompare(a.data) || (b.creato || 0) - (a.creato || 0));
}

function totali(lista) {
  let e = 0, u = 0;
  for (const m of lista) m.tipo === 'E' ? (e += m.importo) : (u += m.importo);
  return { e, u, diff: e - u };
}

if (typeof module !== 'undefined') {
  module.exports = { importoInCentesimi, dataIso, leggiCSV, movimentiDaCSV, movimentiDaJSON, csvDaMovimenti, totali };
}

/* ---------- Interfaccia ---------- */

if (typeof document !== 'undefined') avvia();

function avvia() {
  const $ = s => document.querySelector(s);
  const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
  const fmt = c => euro.format(c / 100);
  const NOMI_MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const oggi = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const dataBreve = iso => { const [a, m, g] = iso.split('-'); return `${+g} ${NOMI_MESI[+m - 1].slice(0, 3)} ${a}`; };

  let dati = { movimenti: [], saldoIniziale: 0 };
  let meta = { ultimoBackup: null, modificatoDopoBackup: false, nascondiInstalla: false };
  let vista = 'home';
  const filtri = { testo: '', tipo: 'tutti', anno: 'tutti' };
  let annoRiepilogo = new Date().getFullYear();

  /* --- Salvataggio --- */
  function carica() {
    try { const s = localStorage.getItem(CHIAVE_DATI); if (s) dati = Object.assign(dati, JSON.parse(s)); } catch (e) { console.error(e); }
    try { const s = localStorage.getItem(CHIAVE_META); if (s) meta = Object.assign(meta, JSON.parse(s)); } catch (e) { console.error(e); }
  }
  function salva() {
    try {
      localStorage.setItem(CHIAVE_DATI, JSON.stringify(dati));
      meta.modificatoDopoBackup = true;
      salvaMeta();
      chiediPersistenza();
      return true;
    } catch (e) {
      alert('Attenzione: non è stato possibile salvare. Spazio esaurito o navigazione privata.');
      return false;
    }
  }
  function salvaMeta() { try { localStorage.setItem(CHIAVE_META, JSON.stringify(meta)); } catch (e) { /* niente */ } }
  async function chiediPersistenza() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* niente */ }
  }

  /* --- Messaggi --- */
  let timerAvviso;
  function avviso(testo, azione, fn) {
    const el = $('#avviso');
    el.innerHTML = `<span>${esc(testo)}</span>` + (azione ? `<button type="button">${esc(azione)}</button>` : '');
    el.hidden = false;
    if (azione) el.querySelector('button').onclick = () => { el.hidden = true; fn(); };
    clearTimeout(timerAvviso);
    timerAvviso = setTimeout(() => { el.hidden = true; }, azione ? 8000 : 2600);
  }

  /* --- Navigazione --- */
  function vai(nome) {
    vista = nome;
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('attiva', b.dataset.vista === nome));
    const titoli = { home: 'Portafoglio', movimenti: 'Movimenti', riepilogo: 'Riepilogo', altro: 'Backup' };
    $('#titolo').textContent = titoli[nome];
    disegna();
    window.scrollTo(0, 0);
  }

  function disegna() {
    const v = $('#vista');
    if (vista === 'home') v.innerHTML = vistaHome();
    else if (vista === 'movimenti') v.innerHTML = vistaMovimenti();
    else if (vista === 'riepilogo') v.innerHTML = vistaRiepilogo();
    else v.innerHTML = vistaAltro();
    collega(v);
  }

  function voceHtml(m) {
    return `<button class="voce" data-id="${esc(m.id)}">
      <span class="pallino ${m.tipo === 'E' ? 'e' : 'u'}">${m.tipo === 'E' ? '+' : '−'}</span>
      <span class="voce-testo">
        <span class="voce-desc">${esc(m.descrizione)}</span>
        <span class="voce-sotto">${dataBreve(m.data)}${m.medica ? '<span class="badge">Medica</span>' : ''}</span>
      </span>
      <span class="voce-importo cifre ${m.tipo === 'E' ? 'pos' : 'neg'}">${m.tipo === 'E' ? '+' : '−'}${fmt(m.importo)}</span>
    </button>`;
  }

  /* --- Home --- */
  function vistaHome() {
    const tutti = dati.movimenti;
    const t = totali(tutti);
    const saldo = (dati.saldoIniziale || 0) + t.diff;
    const mese = oggi().slice(0, 7);
    const tm = totali(tutti.filter(m => m.data.startsWith(mese)));
    const nomeMese = NOMI_MESI[+mese.slice(5) - 1];
    let h = '';

    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const installata = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    if (ios && !installata && !meta.nascondiInstalla) {
      h += `<div class="scheda avviso-scheda"><button class="chiudi-x" data-azione="chiudi-installa" aria-label="Chiudi">×</button>
        <p><strong>Installa l'app sul telefono</strong></p>
        <p style="margin:0">In Safari tocca <strong>Condividi</strong> (il quadrato con la freccia in su) e poi <strong>Aggiungi alla schermata Home</strong>. Così funziona anche senza internet.</p></div>`;
    }

    const giorni = meta.ultimoBackup ? (Date.now() - meta.ultimoBackup) / 864e5 : Infinity;
    if (tutti.length && meta.modificatoDopoBackup && giorni > GIORNI_PROMEMORIA_BACKUP) {
      h += `<div class="scheda avviso-scheda">
        <p><strong>${meta.ultimoBackup ? 'È passato più di un mese dall\'ultimo backup' : 'Non hai ancora fatto un backup'}</strong><br>
        Salva una copia dei dati: se il telefono si rompe o l'app viene cancellata, la recuperi da lì.</p>
        <button class="btn btn-primario" data-azione="esporta">Fai il backup ora</button></div>`;
    }

    h += `<section class="scheda saldo">
      <div class="etichetta">Saldo</div>
      <div class="grande">${fmt(saldo)}</div>
      <div class="nota">Entrate meno uscite registrate${dati.saldoIniziale ? ', più il saldo iniziale' : ''}</div>
    </section>
    <section class="scheda">
      <h2>${nomeMese} ${mese.slice(0, 4)}</h2>
      <div class="due">
        <div class="mini e"><div class="etichetta">Entrate</div><div class="valore cifre">${fmt(tm.e)}</div></div>
        <div class="mini u"><div class="etichetta">Uscite</div><div class="valore cifre">${fmt(tm.u)}</div></div>
      </div>
    </section>
    <div class="intesta"><h2>Ultimi movimenti</h2>${tutti.length > 8 ? '<button class="btn-link" data-vai="movimenti">Vedi tutti</button>' : ''}</div>`;

    if (!tutti.length) {
      h += `<div class="lista"><p class="vuoto">Ancora nessun movimento.<br>Tocca <strong>+</strong> per aggiungerne uno, oppure importa i dati da <strong>Backup</strong>.</p></div>`;
    } else {
      h += `<div class="lista">${ordina(tutti).slice(0, 8).map(voceHtml).join('')}</div>`;
    }
    return h;
  }

  /* --- Movimenti --- */
  function anniPresenti() {
    return [...new Set(dati.movimenti.map(m => m.data.slice(0, 4)))].sort().reverse();
  }

  function vistaMovimenti() {
    const anni = anniPresenti();
    let h = `<input class="cerca" type="search" placeholder="Cerca…" value="${esc(filtri.testo)}" data-filtro="testo" enterkeyhint="search">
      <div class="chips">
        ${[['tutti', 'Tutti'], ['E', 'Entrate'], ['U', 'Uscite'], ['medica', 'Mediche']].map(([k, l]) => `<button class="chip ${filtri.tipo === k ? 'attivo' : ''}" data-tipo-filtro="${k}">${l}</button>`).join('')}
      </div>
      <div class="chips" style="margin-top:8px">
        ${[['tutti', 'Tutti gli anni'], ...anni.map(a => [a, a])].map(([k, l]) => `<button class="chip ${filtri.anno === k ? 'attivo' : ''}" data-anno-filtro="${k}">${l}</button>`).join('')}
      </div>
      <div id="risultati">${risultatiHtml()}</div>`;
    return h;
  }

  function risultatiHtml() {
    const q = filtri.testo.trim().toLowerCase();
    const lista = ordina(dati.movimenti.filter(m =>
      (filtri.tipo === 'tutti' || (filtri.tipo === 'medica' ? m.medica : m.tipo === filtri.tipo)) &&
      (filtri.anno === 'tutti' || m.data.startsWith(filtri.anno)) &&
      (!q || m.descrizione.toLowerCase().includes(q))
    ));
    if (!lista.length) return `<div class="lista" style="margin-top:14px"><p class="vuoto">Nessun movimento trovato.</p></div>`;
    const gruppi = new Map();
    for (const m of lista) {
      const k = m.data.slice(0, 7);
      if (!gruppi.has(k)) gruppi.set(k, []);
      gruppi.get(k).push(m);
    }
    let h = '';
    const tot = totali(lista);
    if (q || filtri.tipo !== 'tutti' || filtri.anno !== 'tutti') {
      h += `<p class="testo-2" style="margin:14px 6px 0">${lista.length} movimenti · entrate <span class="pos cifre">${fmt(tot.e)}</span> · uscite <span class="neg cifre">${fmt(tot.u)}</span></p>`;
    }
    for (const [k, voci] of gruppi) {
      const t = totali(voci);
      const parti = [];
      if (t.e) parti.push(`<span class="pos">+${fmt(t.e)}</span>`);
      if (t.u) parti.push(`<span class="neg">−${fmt(t.u)}</span>`);
      h += `<div class="mese-intesta"><strong>${NOMI_MESI[+k.slice(5) - 1]} ${k.slice(0, 4)}</strong><span class="cifre">${parti.join(' · ')}</span></div>
        <div class="lista">${voci.map(voceHtml).join('')}</div>`;
    }
    return h;
  }

  /* --- Riepilogo --- */
  function vistaRiepilogo() {
    const anni = anniPresenti().map(Number);
    const min = anni.length ? Math.min(...anni) : annoRiepilogo;
    const max = Math.max(new Date().getFullYear(), ...(anni.length ? anni : [annoRiepilogo]));
    const delAnno = dati.movimenti.filter(m => m.data.startsWith(String(annoRiepilogo)));
    const t = totali(delAnno);
    const mediche = ordina(delAnno.filter(m => m.medica && m.tipo === 'U'));
    const totMed = mediche.reduce((s, m) => s + m.importo, 0);

    const mesi = Array.from({ length: 12 }, (_, i) => {
      const k = `${annoRiepilogo}-${String(i + 1).padStart(2, '0')}`;
      return { i, ...totali(delAnno.filter(m => m.data.startsWith(k))) };
    }).filter(m => m.e || m.u);
    const picco = Math.max(1, ...mesi.map(m => Math.max(m.e, m.u)));

    let h = `<div class="anno-sel">
        <button class="freccia" data-anno="${annoRiepilogo - 1}" ${annoRiepilogo <= min ? 'disabled' : ''} aria-label="Anno precedente">‹</button>
        <strong>${annoRiepilogo}</strong>
        <button class="freccia" data-anno="${annoRiepilogo + 1}" ${annoRiepilogo >= max ? 'disabled' : ''} aria-label="Anno successivo">›</button>
      </div>
      <section class="scheda righe-tot">
        <div><span>Entrate</span><span class="pos cifre">${fmt(t.e)}</span></div>
        <div><span>Uscite</span><span class="neg cifre">${fmt(t.u)}</span></div>
        <div class="tot"><span>Differenza</span><span class="cifre ${t.diff >= 0 ? 'pos' : 'neg'}">${t.diff >= 0 ? '+' : '−'}${fmt(Math.abs(t.diff))}</span></div>
      </section>
      <section class="scheda mediche">
        <h2 style="color:var(--medica)">Spese mediche per il 730</h2>
        <div class="grande cifre">${fmt(totMed)}</div>
        <div class="etichetta">${mediche.length ? `${mediche.length} ${mediche.length === 1 ? 'spesa' : 'spese'} nel ${annoRiepilogo}` : `Nessuna spesa medica nel ${annoRiepilogo}`}</div>
        ${mediche.length ? `<ul>${mediche.map(m => `<li><span>${esc(m.descrizione)} <small class="etichetta">· ${dataBreve(m.data)}</small></span><span class="cifre">${fmt(m.importo)}</span></li>`).join('')}</ul>` : ''}
      </section>`;

    if (mesi.length) {
      h += `<section class="scheda"><h2>Mese per mese</h2>
        <div class="legenda"><span class="e">Entrate</span><span class="u">Uscite</span></div>
        <div class="barre">${mesi.map(m => `<div class="riga">
          <span class="m">${NOMI_MESI[m.i].slice(0, 3)}</span>
          <span class="b">
            <div class="e"><i style="width:${(m.e / picco * 72).toFixed(1)}%${m.e ? "" : ";min-width:0"}"></i><span class="cifre">${m.e ? fmt(m.e) : ''}</span></div>
            <div class="u"><i style="width:${(m.u / picco * 72).toFixed(1)}%${m.u ? "" : ";min-width:0"}"></i><span class="cifre">${m.u ? fmt(m.u) : ''}</span></div>
          </span></div>`).join('')}</div></section>`;
    }

    // Voci più ricorrenti nelle uscite dell'anno
    const perVoce = new Map();
    for (const m of delAnno.filter(m => m.tipo === 'U')) {
      const k = chiaveVoce(m.descrizione);
      const v = perVoce.get(k) || { nome: k, tot: 0, n: 0 };
      v.tot += m.importo; v.n++;
      perVoce.set(k, v);
    }
    const top = [...perVoce.values()].sort((a, b) => b.tot - a.tot).slice(0, 6);
    if (top.length) {
      h += `<section class="scheda righe-tot"><h2>Dove vanno i soldi</h2>
        ${top.map(v => `<div><span>${esc(v.nome)} <small class="etichetta">· ${v.n}×</small></span><span class="neg cifre">${fmt(v.tot)}</span></div>`).join('')}
        <p class="testo-2" style="margin:8px 0 0;font-size:13px">Raggruppate per la prima parola della descrizione.</p></section>`;
    }
    return h;
  }

  // "Nuoto marzo 2026" → "Nuoto", "Regalo Marina natale" → "Regalo"
  function chiaveVoce(d) {
    const p = d.trim().split(/[\s\/]+/)[0] || d;
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }

  /* --- Backup e impostazioni --- */
  function vistaAltro() {
    const ultimo = meta.ultimoBackup ? new Date(meta.ultimoBackup).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : 'mai';
    return `<section class="scheda">
        <h2>Backup</h2>
        <p class="testo-2">I dati sono salvati solo su questo telefono. Ogni tanto salva una copia su iCloud Drive o mandala a un familiare.<br>Ultimo backup: <strong>${ultimo}</strong>.</p>
        <button class="btn btn-primario" data-azione="esporta">Salva backup</button>
        <button class="btn" data-azione="importa">Ripristina o importa dati</button>
        <p class="testo-2" style="margin:10px 0 0;font-size:13px">Importa un backup (.json) oppure un file CSV esportato da Fogli Google. I movimenti già presenti non vengono duplicati.</p>
      </section>
      <section class="scheda">
        <h2>Esporta per Excel</h2>
        <p class="testo-2">Un file CSV da aprire con Numbers, Excel o Fogli Google.</p>
        <button class="btn" data-azione="esporta-csv">Esporta CSV</button>
      </section>
      <section class="scheda">
        <h2>Saldo iniziale</h2>
        <p class="testo-2">Se vuoi che il saldo corrisponda ai soldi che hai davvero, inserisci qui la cifra di partenza.</p>
        <label class="campo" style="margin:0"><div class="importo-riga"><span class="euro" style="font-size:20px">€</span>
          <input id="saldo-iniziale" inputmode="decimal" style="padding-left:38px" value="${dati.saldoIniziale ? (dati.saldoIniziale / 100).toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></div></label>
      </section>
      <section class="scheda">
        <h2>Informazioni</h2>
        <p class="testo-2" style="margin:0">${dati.movimenti.length} movimenti salvati · funziona anche senza internet.</p>
        <button class="btn-link pericolo" data-azione="cancella">Cancella tutti i dati</button>
      </section>`;
  }

  async function condividiFile(nome, contenuto, tipo) {
    const blob = new Blob([contenuto], { type: tipo });
    const file = typeof File !== 'undefined' ? new File([blob], nome, { type: tipo }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: nome }); return true; }
      catch (e) { if (e.name === 'AbortError') return false; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  }

  async function esporta() {
    const giorno = oggi();
    const contenuto = JSON.stringify({ app: 'portafoglio', versione: 1, esportato: new Date().toISOString(), saldoIniziale: dati.saldoIniziale || 0, movimenti: ordina(dati.movimenti) }, null, 1);
    const ok = await condividiFile(`portafoglio-backup-${giorno}.json`, contenuto, 'application/json');
    if (ok) {
      meta.ultimoBackup = Date.now();
      meta.modificatoDopoBackup = false;
      salvaMeta();
      avviso('Backup creato');
      disegna();
    }
  }

  async function importa(file) {
    try {
      const testo = await file.text();
      const json = /\.json$/i.test(file.name) || testo.trim().startsWith('{') || testo.trim().startsWith('[');
      const r = json ? movimentiDaJSON(testo) : movimentiDaCSV(testo);
      if (!r.movimenti.length) { alert('Nel file non ho trovato movimenti da importare.'); return; }
      const presenti = new Set(dati.movimenti.map(m => m.id));
      const firma = m => `${m.data}|${m.importo}|${m.tipo}|${m.descrizione.toLowerCase()}`;
      const firme = new Set(dati.movimenti.map(firma));
      const nuovi = r.movimenti.filter(m => !presenti.has(m.id) && !firme.has(firma(m)));
      const doppi = r.movimenti.length - nuovi.length;
      let msg = `Ho trovato ${r.movimenti.length} movimenti.\n${nuovi.length} nuovi da aggiungere`;
      if (doppi) msg += `, ${doppi} già presenti`;
      if (r.scartate) msg += `, ${r.scartate} righe vuote o non valide ignorate`;
      msg += '.\n\nProcedo?';
      if (!nuovi.length) { alert(`Tutti i ${r.movimenti.length} movimenti del file sono già presenti.`); return; }
      if (!confirm(msg)) return;
      const ora = Date.now();
      nuovi.forEach((m, i) => { m.creato = ora - i; });
      dati.movimenti.push(...nuovi);
      if (r.saldoIniziale && !dati.saldoIniziale) dati.saldoIniziale = r.saldoIniziale;
      if (salva()) { avviso(`${nuovi.length} movimenti importati`); vai('home'); }
    } catch (e) {
      alert('Non riesco a leggere il file: ' + e.message);
    }
  }

  /* --- Modulo aggiungi / modifica --- */
  let inModifica = null;
  let tipoScelto = 'U';

  function impostaTipo(t) {
    tipoScelto = t;
    document.querySelectorAll('.seg').forEach(b => {
      const on = b.dataset.tipo === t;
      b.classList.toggle('attivo', on);
      b.setAttribute('aria-checked', on);
    });
    $('#riga-medica').hidden = t === 'E';
  }

  function descrizioniFrequenti() {
    const conta = new Map();
    for (const m of ordina(dati.movimenti)) {
      const k = m.descrizione.trim();
      const v = conta.get(k.toLowerCase()) || { testo: k, n: 0, ultimo: m };
      v.n++;
      conta.set(k.toLowerCase(), v);
    }
    return [...conta.values()].sort((a, b) => b.n - a.n);
  }

  function apriModulo(id) {
    inModifica = id ? dati.movimenti.find(m => m.id === id) : null;
    const m = inModifica;
    $('#foglio-titolo').textContent = m ? 'Modifica movimento' : 'Nuovo movimento';
    $('#f-importo').value = m ? (m.importo / 100).toFixed(2).replace('.', ',') : '';
    $('#f-descrizione').value = m ? m.descrizione : '';
    $('#f-data').value = m ? m.data : oggi();
    $('#f-medica').checked = m ? m.medica : false;
    $('#f-errore').hidden = true;
    $('#f-elimina').hidden = !m;
    impostaTipo(m ? m.tipo : 'U');

    const freq = descrizioniFrequenti();
    $('#suggerimenti').innerHTML = freq.slice(0, 80).map(f => `<option value="${esc(f.testo)}">`).join('');
    const rapidi = m ? [] : freq.filter(f => f.n >= 2).slice(0, 6);
    $('#rapidi').innerHTML = rapidi.map(f => `<button type="button" data-rapido="${esc(f.testo)}">${esc(f.testo)}</button>`).join('');
    $('#rapidi').hidden = !rapidi.length;

    $('#velo').hidden = false;
    $('#foglio').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!m) setTimeout(() => $('#f-importo').focus(), 250);
  }

  function chiudiModulo() {
    $('#velo').hidden = true;
    $('#foglio').hidden = true;
    document.body.style.overflow = '';
    inModifica = null;
  }

  function salvaModulo(ev) {
    ev.preventDefault();
    const importo = importoInCentesimi($('#f-importo').value);
    const descrizione = $('#f-descrizione').value.trim();
    const data = $('#f-data').value;
    const errore = t => { const e = $('#f-errore'); e.textContent = t; e.hidden = false; };
    if (!Number.isFinite(importo) || importo <= 0) return errore('Scrivi un importo valido, ad esempio 12,50.');
    if (!descrizione) return errore('Scrivi una breve descrizione.');
    if (!dataIso(data)) return errore('Scegli una data.');
    const valori = { importo, descrizione, data, tipo: tipoScelto, medica: tipoScelto === 'U' && $('#f-medica').checked };
    if (inModifica) Object.assign(inModifica, valori);
    else dati.movimenti.push({ id: nuovoId(), creato: Date.now(), ...valori });
    const eraModifica = !!inModifica;
    if (salva()) {
      chiudiModulo();
      disegna();
      avviso(eraModifica ? 'Movimento aggiornato' : (tipoScelto === 'E' ? 'Entrata salvata' : 'Uscita salvata'));
    }
  }

  function elimina() {
    if (!inModifica || !confirm(`Eliminare "${inModifica.descrizione}"?`)) return;
    const tolto = inModifica;
    const pos = dati.movimenti.indexOf(tolto);
    dati.movimenti.splice(pos, 1);
    salva();
    chiudiModulo();
    disegna();
    avviso('Movimento eliminato', 'Annulla', () => { dati.movimenti.splice(pos, 0, tolto); salva(); disegna(); });
  }

  /* --- Eventi --- */
  function collega(radice) {
    radice.querySelectorAll('.voce').forEach(b => b.onclick = () => apriModulo(b.dataset.id));
    radice.querySelectorAll('[data-vai]').forEach(b => b.onclick = () => vai(b.dataset.vai));
    radice.querySelectorAll('[data-anno]').forEach(b => b.onclick = () => { annoRiepilogo = +b.dataset.anno; disegna(); });
    radice.querySelectorAll('[data-tipo-filtro]').forEach(b => b.onclick = () => { filtri.tipo = b.dataset.tipoFiltro; disegna(); });
    radice.querySelectorAll('[data-anno-filtro]').forEach(b => b.onclick = () => { filtri.anno = b.dataset.annoFiltro; disegna(); });
    const cerca = radice.querySelector('[data-filtro="testo"]');
    if (cerca) cerca.oninput = () => {
      filtri.testo = cerca.value;
      const r = $('#risultati');
      r.innerHTML = risultatiHtml();
      collega(r);
    };
    radice.querySelectorAll('[data-azione]').forEach(b => b.onclick = () => {
      const a = b.dataset.azione;
      if (a === 'esporta') esporta();
      else if (a === 'esporta-csv') condividiFile(`portafoglio-${oggi()}.csv`, '﻿' + csvDaMovimenti(dati.movimenti), 'text/csv');
      else if (a === 'importa') $('#file-import').click();
      else if (a === 'chiudi-installa') { meta.nascondiInstalla = true; salvaMeta(); disegna(); }
      else if (a === 'cancella') {
        if (!confirm('Cancellare TUTTI i movimenti da questo telefono?')) return;
        if (!confirm('Sei sicura? Senza un backup non si potranno recuperare.')) return;
        dati = { movimenti: [], saldoIniziale: 0 };
        salva(); avviso('Dati cancellati'); disegna();
      }
    });
    const si = radice.querySelector('#saldo-iniziale');
    if (si) si.onchange = () => {
      const v = si.value.trim() ? importoInCentesimi(si.value) : 0;
      if (!Number.isFinite(v)) { avviso('Importo non valido'); return; }
      dati.saldoIniziale = v; salva(); avviso('Saldo iniziale salvato');
    };
  }

  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => vai(b.dataset.vista));
  $('#aggiungi').onclick = () => apriModulo(null);
  $('#velo').onclick = chiudiModulo;
  $('#f-annulla').onclick = chiudiModulo;
  $('#f-elimina').onclick = elimina;
  $('#modulo').onsubmit = salvaModulo;
  document.querySelectorAll('.seg').forEach(b => b.onclick = () => impostaTipo(b.dataset.tipo));
  $('#rapidi').onclick = e => {
    const b = e.target.closest('[data-rapido]');
    if (!b) return;
    const f = descrizioniFrequenti().find(x => x.testo === b.dataset.rapido);
    $('#f-descrizione').value = b.dataset.rapido;
    if (f) {
      impostaTipo(f.ultimo.tipo);
      $('#f-medica').checked = f.ultimo.medica;
      if (!$('#f-importo').value) $('#f-importo').value = (f.ultimo.importo / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
    }
  };
  $('#file-import').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importa(f); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#foglio').hidden) chiudiModulo(); });

  /* --- Funzionamento offline e aggiornamenti --- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let ricaricando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (ricaricando) return;
      ricaricando = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(reg => {
      const proponi = w => avviso('È disponibile una nuova versione', 'Aggiorna', () => w.postMessage('AGGIORNA'));
      if (reg.waiting && navigator.serviceWorker.controller) proponi(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) proponi(w);
        });
      });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(err => console.warn('Service worker non registrato', err));
  }

  carica();
  vai('home');
}
