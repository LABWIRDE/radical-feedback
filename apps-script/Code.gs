/**
 * Radical Feedback – Backend (Google Apps Script, Web-App)
 *
 * Speicher:
 *  - Script Properties (ohne Versionsverlauf): eine Session = ein Eintrag "s_<id>" (JSON).
 *    Einzelne Abgaben liegen dort nur bis zur Berechnung der Runde und werden danach gelöscht.
 *  - Google Sheet mit der ID in CFG.SHEET_ID: Blatt "Statistik", nur anonyme Werte.
 *
 * Einrichtung: siehe Anleitung. Nach dem Einfügen einmal die Funktion setup() ausführen.
 */

const CFG = {
  MIN: 3,                         // mindestens 3 Personen (und mindestens 3 Bewertende)
  MAX: 9,                         // höchstens 9 Personen
  NAME_MAX: 30,                   // maximale Namenslänge
  KEEP_MS: 30 * 24 * 3600 * 1000, // automatisches Löschen nach 30 Tagen
  DELETE_AFTER_MS: 24 * 3600 * 1000, // manuelles Löschen frühestens 1 Tag nach Endergebnis
  MAX_NOTICES: 20,
  STATS_SHEET: 'Statistik',
  SHEET_ID: '1xSiuKGH_hbqucQ-t_4LLoZ9_av4UO8_VUGfGf0iLaC0' // Google Sheet "Radical Feedback – Statistik"
};

const PHASE = { LOBBY: 'lobby', R1: 'r1', DISCUSS: 'discuss', R2: 'r2', FINAL: 'final', ERROR: 'error' };

/* ------------------------------------------------------------------ */
/* Web-App-Einstieg                                                    */
/* ------------------------------------------------------------------ */

function doGet() {
  return out_({ ok: true, app: 'radical-feedback' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'bad_request' });
  }
  try {
    return out_(handle_(req));
  } catch (err) {
    if (err && err.code) return out_({ ok: false, error: err.code });
    console.error(err);
    return out_({ ok: false, error: 'server' });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code) {
  const e = new Error(code);
  e.code = code;
  throw e;
}

const ACTIONS_ = {
  create: create_,
  status: status_,
  claim: claim_,
  ready: ready_,
  submit: submit_,
  ready2: ready2_,
  remove: remove_,
  deleteSession: deleteSession_
};

function handle_(req) {
  if (!req || typeof req !== 'object') fail_('bad_request');
  const fn = ACTIONS_[req.action];
  if (!fn) fail_('unknown_action');
  if (req.action === 'status') return fn(req); // nur lesen, kein Lock nötig
  return withLock_(function () { return fn(req); });
}

function withLock_(f) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('busy');
  try {
    return f();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Speicher                                                            */
/* ------------------------------------------------------------------ */

function props_() {
  return PropertiesService.getScriptProperties();
}

function load_(id) {
  if (typeof id !== 'string' || !/^[a-z0-9]{6,16}$/.test(id)) fail_('no_session');
  const raw = props_().getProperty('s_' + id);
  if (!raw) fail_('no_session');
  return JSON.parse(raw);
}

function save_(s) {
  props_().setProperty('s_' + s.id, JSON.stringify(s));
}

function randomId_(len) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let r = '';
  for (let i = 0; i < len; i++) r += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return r;
}

function newToken_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

function person_(s, pid) {
  for (let i = 0; i < s.people.length; i++) if (s.people[i].id === pid) return s.people[i];
  return null;
}

function auth_(s, req) {
  if (typeof req.token !== 'string' || !req.token) fail_('not_auth');
  for (let i = 0; i < s.people.length; i++) {
    if (s.people[i].token === req.token) return s.people[i];
  }
  fail_('not_auth');
}

function active_(s) {
  return s.people.filter(function (p) { return p.active; });
}

function notice_(s, type, name) {
  s.seq = (s.seq || 0) + 1;
  s.notices.push({ seq: s.seq, type: type, name: name || '' });
  if (s.notices.length > CFG.MAX_NOTICES) s.notices = s.notices.slice(-CFG.MAX_NOTICES);
}

function sum_(arr) {
  let t = 0;
  for (let i = 0; i < arr.length; i++) t += arr[i];
  return t;
}

function mean_(arr) {
  return arr.length ? sum_(arr) / arr.length : 0;
}

function validVector_(v, n) {
  if (!Array.isArray(v) || v.length !== n) return false;
  for (let i = 0; i < n; i++) {
    if (typeof v[i] !== 'number' || !Number.isInteger(v[i]) || v[i] < 0 || v[i] > 100) return false;
  }
  return sum_(v) === 100;
}

/* ------------------------------------------------------------------ */
/* Aktionen                                                            */
/* ------------------------------------------------------------------ */

function create_(req) {
  if (!Array.isArray(req.names)) fail_('bad_names');
  const names = req.names.map(function (x) { return String(x || '').trim(); }).filter(function (x) { return x; });
  if (names.length < CFG.MIN || names.length > CFG.MAX) fail_('bad_count');
  const seen = {};
  names.forEach(function (n) {
    if (n.length > CFG.NAME_MAX) fail_('name_too_long');
    const k = n.toLowerCase();
    if (seen[k]) fail_('duplicate_name');
    seen[k] = true;
  });

  let id;
  do { id = randomId_(10); } while (props_().getProperty('s_' + id));

  const s = {
    id: id,
    created: Date.now(),
    phase: PHASE.LOBBY,
    people: names.map(function (n, i) {
      return { id: 'p' + i + randomId_(4), name: n, token: null, ready: false, show: false, ready2: false, active: true };
    }),
    subs: {},
    results: {},
    teambild: null,
    finalAt: null,
    notices: [],
    seq: 0
  };
  save_(s);
  return { ok: true, id: id };
}

function claim_(req) {
  const s = load_(req.id);
  const p = person_(s, req.pid);
  if (!p) fail_('no_person');
  if (!p.active) fail_('removed');
  if (p.token && !req.force) fail_('taken');
  if (p.token) {
    // "Das bin ich, zurücksetzen": alles vom anderen Handy wird verworfen
    delete s.subs[p.id];
    if (s.phase === PHASE.LOBBY) { p.ready = false; p.show = false; }
    notice_(s, 'reset', p.name);
  }
  p.token = newToken_();
  save_(s);
  return { ok: true, pid: p.id, token: p.token };
}

function ready_(req) {
  const s = load_(req.id);
  if (s.phase !== PHASE.LOBBY) fail_('phase');
  const p = auth_(s, req);
  p.ready = true;
  p.show = s.people.length > 3 && !!req.show;
  advance_(s);
  save_(s);
  return { ok: true };
}

function submit_(req) {
  const s = load_(req.id);
  if (s.phase !== PHASE.R1 && s.phase !== PHASE.R2) fail_('phase');
  const p = auth_(s, req);
  if (!p.active) fail_('removed');
  if (!validVector_(req.values, s.people.length)) fail_('bad_values');
  s.subs[p.id] = req.values.slice(); // überschreibt eine frühere Abgabe
  advance_(s);
  save_(s);
  return { ok: true };
}

function ready2_(req) {
  const s = load_(req.id);
  if (s.phase !== PHASE.DISCUSS) fail_('phase');
  const p = auth_(s, req);
  if (!p.active) fail_('removed');
  p.ready2 = true;
  advance_(s);
  save_(s);
  return { ok: true };
}

function remove_(req) {
  const s = load_(req.id);
  const me = auth_(s, req);
  if (!me.active) fail_('removed');
  const t = person_(s, req.target);
  if (!t || !t.active) fail_('no_person');

  if (s.phase === PHASE.LOBBY) {
    if (s.people.length - 1 < CFG.MIN) fail_('min');
    s.people = s.people.filter(function (p) { return p.id !== t.id; });
    notice_(s, 'deleted', t.name);
  } else if (s.phase === PHASE.R1 || s.phase === PHASE.DISCUSS || s.phase === PHASE.R2) {
    if (active_(s).length - 1 < CFG.MIN) fail_('min');
    t.active = false;          // bleibt "nur bewertet"
    delete s.subs[t.id];
    notice_(s, 'removed', t.name);
  } else {
    fail_('phase');
  }
  advance_(s);
  save_(s);
  return { ok: true };
}

function deleteSession_(req) {
  const s = load_(req.id);
  auth_(s, req);
  if (s.phase === PHASE.FINAL) {
    if (Date.now() - s.finalAt < CFG.DELETE_AFTER_MS) fail_('too_early');
  } else if (s.phase !== PHASE.ERROR) {
    fail_('phase');
  }
  props_().deleteProperty('s_' + s.id);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Phasenwechsel                                                       */
/* ------------------------------------------------------------------ */

function advance_(s) {
  let changed = true;
  while (changed) {
    changed = false;
    const act = active_(s);
    if (s.phase === PHASE.LOBBY) {
      if (s.people.length >= CFG.MIN && s.people.every(function (p) { return p.token && p.ready; })) {
        s.phase = PHASE.R1;
        s.subs = {};
        changed = true;
      }
    } else if (s.phase === PHASE.R1 || s.phase === PHASE.R2) {
      if (act.every(function (p) { return s.subs[p.id]; })) {
        computeRound_(s);
        changed = true;
      }
    } else if (s.phase === PHASE.DISCUSS) {
      if (act.every(function (p) { return p.ready2; })) {
        s.phase = PHASE.R2;
        s.subs = {};
        changed = true;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Berechnung                                                          */
/* ------------------------------------------------------------------ */

/** Korrektur nach Konzept, Abschnitt 4 */
function correct_(S, F) {
  if (F === 0) return 0;
  const d = S - F;
  if (d === 0) return F;
  const r = Math.abs(d) / F;
  const g = Math.exp(-r * r);
  if (d > 0) return F * (0.25 + 0.75 * g);
  return F * (1 - 0.375 * (1 - g));
}

function computeRound_(s) {
  const round = s.phase === PHASE.R1 ? 1 : 2;
  const n = s.people.length;
  const raters = active_(s);

  // Prüfung vor der Berechnung: jede Abgabe genau 100
  for (let i = 0; i < raters.length; i++) {
    if (!validVector_(s.subs[raters[i].id], n)) {
      s.phase = PHASE.ERROR;
      s.subs = {};
      return;
    }
  }

  const F = [], S = [], K = [];
  s.people.forEach(function (p, j) {
    const others = raters.filter(function (r) { return r.id !== p.id; })
      .map(function (r) { return s.subs[r.id][j]; });
    F[j] = mean_(others);
    S[j] = p.active ? s.subs[p.id][j] : null;
  });

  const factors = [];
  s.people.forEach(function (p, j) {
    if (p.active) {
      K[j] = correct_(S[j], F[j]);
      if (F[j] > 0) factors.push(K[j] / F[j]);
    }
  });
  const avgFactor = factors.length ? mean_(factors) : 1;
  s.people.forEach(function (p, j) {
    if (!p.active) K[j] = F[j] * avgFactor; // Abwesende: durchschnittliche Korrektur
  });

  const sumK = sum_(K);
  if (!(sumK > 0)) {
    s.phase = PHASE.ERROR;
    s.subs = {};
    return;
  }

  s.results['r' + round] = {
    rows: s.people.map(function (p, j) {
      return { id: p.id, share: K[j] / sumK * 100, F: F[j], S: S[j], absent: !p.active };
    })
  };

  s.subs = {}; // Einzelbewertungen werden gelöscht

  if (round === 1) {
    s.people.forEach(function (p) { p.ready2 = false; });
    s.phase = PHASE.DISCUSS;
  } else {
    s.phase = PHASE.FINAL;
    s.finalAt = Date.now();
    s.teambild = teambild_(s);
    try {
      writeStats_(s);
    } catch (err) {
      console.error('Statistik konnte nicht geschrieben werden: ' + err);
    }
  }
}

/** Durchschnittliche relative Abweichung der Selbsteinschätzung: Mittelwert von (S_i − F_i) / F_i */
function deviation_(res) {
  const rel = res.rows.filter(function (r) { return !r.absent && r.F > 0; })
    .map(function (r) { return (r.S - r.F) / r.F; });
  return { abs: mean_(rel.map(Math.abs)), signed: mean_(rel) };
}

/** Kennzahlen des Teambilds (Konzept, Abschnitt 4). Schwellen = Startwerte. */
function teamMetrics_(s) {
  const d2 = deviation_(s.results.r2);
  const d1 = s.results.r1 ? deviation_(s.results.r1) : d2;
  let change;
  if (d1.abs > 0) change = (d2.abs - d1.abs) / d1.abs;
  else change = d2.abs > 0 ? 1 : 0;
  return {
    abs1: d1.abs,
    abs2: d2.abs,
    accuracy: d2.abs < 0.10 ? 'accurate' : (d2.abs <= 0.25 ? 'noticeable' : 'strong'),
    direction: d2.signed > 0.05 ? 'over' : (d2.signed < -0.05 ? 'under' : 'realistic'),
    convergence: change < -0.10 ? 'closer' : (change > 0.10 ? 'apart' : 'same')
  };
}

/** Teambild für die Handys: bei 3 Teilnehmenden keins (Anonymität). */
function teambild_(s) {
  if (s.people.length <= 3) return null;
  const m = teamMetrics_(s);
  return { accuracy: m.accuracy, direction: m.direction, convergence: m.convergence };
}

/** Anonyme Statistik: keine Namen, keine Session-ID, Werte getrennt sortiert. */
function writeStats_(s) {
  const ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  if (!ss) return;
  const sh = statsSheet_(ss);
  const rows = s.results.r2.rows;
  const shares = rows.map(function (r) { return r.share; }).sort(function (a, b) { return b - a; });
  const devs = rows.filter(function (r) { return !r.absent; })
    .map(function (r) { return r.S - r.F; }).sort(function (a, b) { return b - a; });
  const fmt = function (x) { return (Math.round(x * 10) / 10).toFixed(1); };
  const m = teamMetrics_(s);
  const pct = function (x) { return fmt(x * 100); };
  sh.appendRow([
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yy'),
    s.people.length,
    rows.filter(function (r) { return r.absent; }).length,
    shares.map(fmt).join(' / '),
    devs.map(fmt).join(' / '),
    pct(m.abs1),
    pct(m.abs2),
    m.accuracy,
    m.direction,
    m.convergence
  ]);
}

function statsSheet_(ss) {
  let sh = ss.getSheetByName(CFG.STATS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CFG.STATS_SHEET);
    sh.appendRow(['Datum', 'Teilnehmende', 'davon abwesend', 'Endanteile % (absteigend)',
      'Abweichungen S−F in Prozentpunkten (absteigend)', 'Ø Abweichung Selbstbild Runde 1 (%)',
      'Ø Abweichung Selbstbild Runde 2 (%)', 'Treffsicherheit', 'Richtung', 'Annäherung']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/* Status für die Handys                                               */
/* ------------------------------------------------------------------ */

function status_(req) {
  const s = load_(req.id);
  let me = null;
  if (typeof req.token === 'string' && req.token) {
    for (let i = 0; i < s.people.length; i++) if (s.people[i].token === req.token) me = s.people[i];
  }
  const n = s.people.length;
  return {
    ok: true,
    id: s.id,
    phase: s.phase,
    n: n,
    small: n <= 3,
    people: s.people.map(function (p) {
      return {
        id: p.id, name: p.name, claimed: !!p.token, ready: p.ready, ready2: p.ready2,
        active: p.active, submitted: !!s.subs[p.id]
      };
    }),
    me: me ? {
      id: me.id, active: me.active, ready: me.ready, ready2: me.ready2, show: me.show,
      submitted: !!s.subs[me.id]
    } : null,
    result: result_(s, me),
    teambild: s.phase === PHASE.FINAL ? s.teambild : null,
    canDelete: (s.phase === PHASE.FINAL && Date.now() - s.finalAt >= CFG.DELETE_AFTER_MS) || s.phase === PHASE.ERROR,
    notices: s.notices
  };
}

/** Ergebnis-Tabelle: Einzelbewertungen sind nie enthalten. */
function result_(s, me) {
  let res = null, round = 0;
  if (s.phase === PHASE.FINAL) { res = s.results.r2; round = 2; }
  else if (s.phase === PHASE.DISCUSS) { res = s.results.r1; round = 1; }
  if (!res) return null;

  const n = s.people.length;
  const full = n > 3 && active_(s).every(function (p) { return p.show; });
  const r1 = function (x) { return x === null ? null : Math.round(x * 10) / 10; };

  return {
    round: round,
    full: full,
    rows: res.rows.map(function (r) {
      const p = person_(s, r.id);
      const visible = full || (me && me.id === r.id);
      return {
        id: r.id,
        name: p ? p.name : '?',
        share: r1(r.share),
        absent: r.absent,
        S: visible ? r1(r.S) : null,
        F: visible ? r1(r.F) : null
      };
    })
  };
}

/* ------------------------------------------------------------------ */
/* Einrichtung und Aufräumen                                           */
/* ------------------------------------------------------------------ */

/** Einmal manuell ausführen: legt das Statistik-Blatt und den täglichen Lösch-Trigger an. */
function setup() {
  const ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  if (ss) statsSheet_(ss);
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'cleanup';
  });
  if (!exists) ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();
}

/** Löscht Sessions, die älter als 30 Tage sind (läuft täglich per Trigger). */
function cleanup() {
  const p = props_();
  const all = p.getProperties();
  const now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('s_') !== 0) return;
    try {
      const s = JSON.parse(all[k]);
      if (now - s.created > CFG.KEEP_MS) p.deleteProperty(k);
    } catch (err) {
      p.deleteProperty(k);
    }
  });
}
