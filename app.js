/* Radical Feedback – Frontend (ohne Framework) */
(function () {
  'use strict';

  const C = window.RF_CONFIG;
  let T = {};          // Texte der aktuellen Sprache
  let LANG = 'de';
  let NUM = null;      // Zahlenformat

  const st = {
    sid: null,         // Session-ID aus der URL
    auth: null,        // { pid, token } aus localStorage
    status: null,      // letzte Antwort von "status"
    view: 'landing',   // ohne Session: landing | create | created
    created: null,     // Link nach dem Anlegen
    fatal: null,       // no_session | deleted
    lastSeq: null,     // letzte gesehene Hinweis-Nummer
    lastKey: '',
    lastJson: '',
    busy: false,
    ui: { show: false, values: null, round: 0, editing: false, createText: '', createError: '', stars: 0, fbText: '' }
  };

  /* ---------------- Hilfen ---------------- */

  function t(key, params) {
    let s = Object.prototype.hasOwnProperty.call(T, key) ? T[key] : key;
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{' + k + '}').join(params[k]); });
    return s;
  }

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    const kids = Array.prototype.slice.call(arguments, 2);
    (function add(list) {
      list.forEach(function (kid) {
        if (kid === null || kid === undefined || kid === false) return;
        if (Array.isArray(kid)) add(kid);
        else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
      });
    })(kids);
    return el;
  }

  function fmt(x) {
    return x === null || x === undefined ? '–' : NUM.format(x) + ' %';
  }

  const store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* egal */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* egal */ } }
  };

  function authKey() { return 'rf_auth_' + st.sid; }
  function valsKey(round) { return 'rf_vals_' + st.sid + '_' + round; }
  function clearAuth() { st.auth = null; store.del(authKey()); }

  async function api(action, data) {
    try {
      const r = await fetch(C.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, data || {}))
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  function errText(code) {
    if (code === 'error') return t('err_calc');
    const k = 'err_' + code;
    return Object.prototype.hasOwnProperty.call(T, k) ? T[k] : t('err_generic');
  }

  /* ---------------- Modal & Hinweise ---------------- */

  function modal(text, okLabel, cancelLabel) {
    return new Promise(function (resolve) {
      const m = document.getElementById('modal');
      const ok = document.getElementById('modal-ok');
      const cancel = document.getElementById('modal-cancel');
      document.getElementById('modal-text').textContent = text;
      ok.textContent = okLabel || t('btn_ok');
      cancel.textContent = cancelLabel || t('btn_cancel');
      cancel.classList.toggle('hidden', cancelLabel === false);
      function close(v) {
        m.classList.add('hidden');
        ok.onclick = null; cancel.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { close(true); };
      cancel.onclick = function () { close(false); };
      m.classList.remove('hidden');
    });
  }

  function info(text) { return modal(text, t('btn_ok'), false); }

  function toast(text) {
    const box = document.getElementById('notices');
    const n = h('div', { class: 'notice' }, text);
    box.append(n);
    setTimeout(function () { n.remove(); }, 6000);
  }

  function handleNotices(list) {
    if (!Array.isArray(list)) return;
    const maxSeq = list.reduce(function (m, x) { return Math.max(m, x.seq); }, 0);
    if (st.lastSeq === null) { st.lastSeq = maxSeq; return; } // alte Hinweise nicht zeigen
    list.forEach(function (x) {
      if (x.seq > st.lastSeq) toast(t('notice_' + x.type, { name: x.name }));
    });
    st.lastSeq = Math.max(st.lastSeq, maxSeq);
  }

  /* ---------------- Laden & Aktualisieren ---------------- */

  async function refresh(force) {
    if (!st.sid || st.fatal) return;
    const r = await api('status', { id: st.sid, token: st.auth ? st.auth.token : '' });
    if (!r.ok) {
      if (r.error === 'no_session') { st.fatal = 'no_session'; render(true); }
      return; // Netzwerkfehler: beim nächsten Abfragen erneut
    }
    handleNotices(r.notices);
    if (st.auth && !r.me) clearAuth(); // Name wurde auf ein anderes Handy übertragen
    st.status = r;
    render(force);
  }

  async function act(action, data) {
    if (st.busy) return null;
    st.busy = true;
    const r = await api(action, Object.assign({ id: st.sid, token: st.auth ? st.auth.token : '' }, data || {}));
    st.busy = false;
    if (!r.ok) {
      if (r.error === 'not_auth') clearAuth();
      await info(errText(r.error));
      await refresh(true);
      return null;
    }
    return r;
  }

  /* ---------------- Rendering ---------------- */

  function render(force) {
    const v = chooseView();
    const json = JSON.stringify(st.status ? Object.assign({}, st.status, { notices: null }) : null);
    if (!force && v.key === st.lastKey && (v.key.indexOf('rate') === 0 || json === st.lastJson)) return;
    st.lastKey = v.key;
    st.lastJson = json;
    const root = document.getElementById('app');
    const nodes = [];
    (function flat(x) {
      if (Array.isArray(x)) x.forEach(flat);
      else if (x instanceof Node) nodes.push(x);
    })(v.build());
    root.replaceChildren.apply(root, nodes);
  }

  function chooseView() {
    if (!st.sid) {
      if (st.view === 'create') return { key: 'create', build: viewCreate };
      if (st.view === 'created') return { key: 'created', build: viewCreated };
      return { key: 'landing', build: viewLanding };
    }
    if (st.fatal) return { key: 'fatal-' + st.fatal, build: viewFatal };
    const s = st.status;
    if (!s) return { key: 'loading', build: function () { return h('p', { class: 'muted' }, '…'); } };
    if (s.phase === 'error') return { key: 'error', build: viewError };
    if (!s.me) return { key: 'pick', build: viewPick };
    if (!s.me.active) return { key: 'removed', build: viewRemoved };
    if (s.phase === 'lobby') return { key: 'lobby', build: viewLobby };
    if (s.phase === 'r1' || s.phase === 'r2') {
      if (!s.me.submitted || st.ui.editing) {
        const flags = s.people.map(function (p) { return p.active ? 1 : 0; }).join('');
        return { key: 'rate-' + s.phase + '-' + st.ui.editing + '-' + flags, build: viewRate };
      }
      return { key: 'wait', build: viewWait };
    }
    if (s.phase === 'discuss') return { key: 'discuss', build: viewDiscuss };
    if (s.phase === 'final') return { key: 'final', build: viewFinal };
    return { key: 'unknown', build: viewFatal };
  }

  /* ---------- ohne Session ---------- */

  function viewLanding() {
    return [
      h('h1', null, t('app_title')),
      h('p', null, t('landing_intro')),
      h('p', null, t('landing_how')),
      h('p', null, t('landing_honest')),
      h('button', { class: 'btn', onclick: function () { st.view = 'create'; render(true); } }, t('btn_create_start'))
    ];
  }

  function viewCreate() {
    const ta = h('textarea', {
      placeholder: t('create_placeholder'),
      value: st.ui.createText,
      oninput: function (e) { st.ui.createText = e.target.value; }
    });
    const btn = h('button', {
      class: 'btn',
      onclick: async function () {
        const names = st.ui.createText.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        btn.disabled = true;
        const r = await api('create', { names: names });
        btn.disabled = false;
        if (!r.ok) { st.ui.createError = errText(r.error); render(true); return; }
        st.ui.createError = '';
        st.created = location.origin + location.pathname + '?s=' + r.id;
        st.view = 'created';
        render(true);
      }
    }, t('btn_create'));
    return [
      h('h1', null, t('create_title')),
      h('p', { class: 'muted' }, t('create_hint')),
      ta,
      st.ui.createError ? h('div', { class: 'error-box' }, st.ui.createError) : null,
      btn,
      h('button', { class: 'btn secondary', onclick: function () { st.view = 'landing'; render(true); } }, t('btn_back'))
    ];
  }

  function viewCreated() {
    const link = st.created;
    return [
      h('h1', null, t('created_title')),
      h('p', null, t('created_hint')),
      h('div', { class: 'card linkbox' }, link),
      h('button', {
        class: 'btn secondary',
        onclick: async function (e) {
          try { await navigator.clipboard.writeText(link); e.target.textContent = t('copied'); }
          catch (err) { await info(link); }
        }
      }, t('btn_copy')),
      navigator.share ? h('button', {
        class: 'btn secondary',
        onclick: function () { navigator.share({ title: t('app_title'), url: link }).catch(function () {}); }
      }, t('btn_share')) : null,
      h('button', { class: 'btn', onclick: function () { location.href = link; } }, t('btn_open_session'))
    ];
  }

  /* ---------- Session ---------- */

  function viewFatal() {
    const text = st.fatal === 'deleted' ? t('deleted_done') : t('err_no_session');
    return [
      h('h1', null, t('app_title')),
      h('p', null, text),
      h('button', { class: 'btn secondary', onclick: goHome }, t('btn_home'))
    ];
  }

  function viewError() {
    const s = st.status;
    return [
      h('h1', null, t('error_title')),
      h('p', null, t('err_calc')),
      s.me && s.canDelete ? h('button', { class: 'btn secondary', onclick: deleteSession }, t('btn_delete_session')) : null,
      h('button', { class: 'btn', onclick: goHome }, t('btn_home'))
    ];
  }

  function goHome() { location.href = location.pathname; }

  function viewPick() {
    const s = st.status;
    return [
      h('h1', null, t('pick_title')),
      h('p', { class: 'muted' }, t('pick_hint')),
      h('div', { class: 'names' }, s.people.map(function (p) {
        const tag = !p.active ? t('removed_label') : (p.claimed ? t('taken') : '');
        return h('button', {
          disabled: !p.active,
          onclick: function () { claim(p); }
        }, h('span', null, p.name), h('span', { class: 'tag' }, tag));
      }))
    ];
  }

  async function claim(p, force) {
    if (p.claimed && !force) {
      const yes = await modal(t('confirm_reset', { name: p.name }), t('btn_reset'), t('btn_cancel'));
      if (!yes) return;
      force = true;
    }
    const r = await api('claim', { id: st.sid, pid: p.id, force: !!force });
    if (!r.ok) {
      if (r.error === 'taken') return claim(Object.assign({}, p, { claimed: true }), false);
      await info(errText(r.error));
      return refresh(true);
    }
    st.auth = { pid: r.pid, token: r.token };
    store.set(authKey(), st.auth);
    st.ui.editing = false;
    await refresh(true);
  }

  function viewLobby() {
    const s = st.status;
    const me = s.me;
    const out = [h('h1', null, t('lobby_title')), h('p', null, t('lobby_text'))];
    if (!me.ready) {
      if (!s.small) {
        out.push(h('label', { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: st.ui.show,
            onchange: function (e) { st.ui.show = e.target.checked; }
          }),
          h('span', null, t('show_label'))));
      }
      out.push(h('button', {
        class: 'btn',
        onclick: async function () {
          const r = await act('ready', { show: !s.small && st.ui.show });
          if (r) refresh(true);
        }
      }, t('btn_ready')));
    } else {
      out.push(h('p', { class: 'muted' }, t('lobby_waiting')));
      out.push(waitingFor(s.people.filter(function (p) { return !p.claimed || !p.ready; })));
    }
    out.push(peopleCard());
    return out;
  }

  function waitingFor(list) {
    if (!list.length) return null;
    return h('p', { class: 'muted' }, t('waiting_for', { names: list.map(function (p) { return p.name; }).join(', ') }));
  }

  function viewRate() {
    const s = st.status;
    const round = s.phase === 'r1' ? 1 : 2;
    const n = s.people.length;
    if (!st.ui.values || st.ui.round !== round || st.ui.values.length !== n) {
      const saved = st.ui.editing ? store.get(valsKey(round)) : null;
      st.ui.values = Array.isArray(saved) && saved.length === n
        ? saved.map(String)
        : s.people.map(function () { return ''; });
      st.ui.round = round;
    }
    const vals = st.ui.values;

    const rest = h('div', { class: 'rest' });
    const submit = h('button', { class: 'btn', onclick: function () { send(round); } }, t('btn_submit'));

    function update() {
      const total = vals.reduce(function (a, v) { return a + (parseInt(v, 10) || 0); }, 0);
      const left = 100 - total;
      rest.className = 'rest' + (left === 0 ? ' done' : (left < 0 ? ' over' : ''));
      rest.textContent = left >= 0 ? t('remaining', { x: left }) : t('over', { x: -left });
      submit.disabled = left !== 0;
    }

    const rows = s.people.map(function (p, j) {
      const tags = [];
      if (p.id === s.me.id) tags.push(t('you'));
      if (!p.active) tags.push(t('absent'));
      const input = h('input', {
        type: 'text',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        maxlength: '3',
        'aria-label': p.name,
        value: vals[j],
        oninput: function (e) {
          let v = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
          if (v !== '' && parseInt(v, 10) > 100) v = '100';
          if (v.length > 1) v = String(parseInt(v, 10));
          e.target.value = v;
          vals[j] = v;
          update();
        }
      });
      return h('div', { class: 'rate-row' },
        h('div', { class: 'who' }, p.name, tags.length ? h('span', { class: 'tag' }, ' (' + tags.join(', ') + ')') : null),
        input, h('span', { class: 'pct' }, '%'));
    });

    update();
    return [
      h('h1', null, t('round_title', { round: round })),
      round === 2 ? h('p', null, t('round2_hint')) : null,
      h('p', { class: 'muted' }, t('rate_hint')),
      h('div', { class: 'card' }, rows),
      h('div', { class: 'sum' }, rest, submit,
        st.ui.editing ? h('button', {
          class: 'btn secondary',
          onclick: function () { st.ui.editing = false; st.ui.values = null; render(true); }
        }, t('btn_cancel')) : null)
    ];
  }

  async function send(round) {
    const s = st.status;
    const values = st.ui.values.map(function (v) { return parseInt(v, 10) || 0; });
    if (values.reduce(function (a, b) { return a + b; }, 0) !== 100) return;

    const warnings = [];
    s.people.forEach(function (p, j) {
      if (values[j] === 0) warnings.push(t('warn_zero', { name: p.name }));
    });
    s.people.forEach(function (p, j) {
      if (values[j] === 100) warnings.push(t('warn_hundred', { name: p.name }));
    });
    const max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    if (max - min <= 1) warnings.push(t('warn_equal'));
    if (warnings.length) {
      const yes = await modal(warnings.join('\n'), t('btn_yes_send'), t('btn_back'));
      if (!yes) return;
    }
    const r = await act('submit', { values: values });
    if (!r) return;
    store.set(valsKey(round), values);
    st.ui.editing = false;
    st.ui.values = null;
    await refresh(true);
  }

  function viewWait() {
    const s = st.status;
    const round = s.phase === 'r1' ? 1 : 2;
    return [
      h('h1', null, t('round_title', { round: round })),
      h('p', null, t('submitted')),
      waitingFor(s.people.filter(function (p) { return p.active && !p.submitted; })),
      h('button', {
        class: 'btn secondary',
        onclick: function () { st.ui.editing = true; st.ui.values = null; render(true); }
      }, t('btn_edit')),
      peopleCard()
    ];
  }

  function viewDiscuss() {
    const s = st.status;
    const out = [
      h('h1', null, t('discuss_title')),
      resultTable(s.result),
      h('p', null, t('discuss_intro')),
      h('ul', { class: 'rules' }, [1, 2, 3, 4, 5].map(function (i) { return h('li', null, t('rule_' + i)); })),
      h('p', null, t('discuss_invisible')),
      h('p', null, t('discuss_flow'))
    ];
    if (!s.me.ready2) {
      out.push(h('button', {
        class: 'btn',
        onclick: async function () { const r = await act('ready2'); if (r) refresh(true); }
      }, t('btn_ready2')));
    } else {
      out.push(h('p', { class: 'muted' }, t('ready2_waiting')));
      out.push(waitingFor(s.people.filter(function (p) { return p.active && !p.ready2; })));
    }
    out.push(peopleCard());
    return out;
  }

  function doneKey() { return 'rf_done_' + st.sid; }

  function viewFinal() {
    const s = st.status;
    const done = (s.me && s.me.feedbackDone) || store.get(doneKey());
    const out = [];
    if (done) {
      out.push(h('h1', null, t('done_title')), h('p', null, t('done_text')));
    } else {
      out.push(h('h1', null, t('final_title')), h('p', null, t('final_text')));
    }
    out.push(resultTable(s.result), teambild(s.teambild));
    out.push(h('button', { class: 'btn secondary', onclick: saveResult }, t('btn_save_result')));
    if (!done) out.push(feedbackBlock());
    out.push(deleteBlock());
    return out;
  }

  function feedbackBlock() {
    const starsBox = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': t('feedback_stars_label') });
    function drawStars() {
      starsBox.replaceChildren.apply(starsBox, [1, 2, 3, 4, 5].map(function (i) {
        return h('button', {
          class: 'star' + (st.ui.stars >= i ? ' on' : ''),
          'aria-label': i + ' / 5',
          onclick: function () { st.ui.stars = (st.ui.stars === i ? 0 : i); drawStars(); }
        }, '★');
      }));
    }
    drawStars();
    const ta = h('textarea', {
      class: 'feedback-text',
      placeholder: t('feedback_placeholder'),
      maxlength: '2000',
      value: st.ui.fbText,
      oninput: function (e) { st.ui.fbText = e.target.value; }
    });
    return h('div', { class: 'card' },
      h('h2', { class: 'card-title' }, t('feedback_title')),
      h('p', { class: 'muted small' }, t('feedback_stars_label')),
      starsBox,
      h('p', { class: 'muted small' }, t('feedback_text_label')),
      ta,
      h('button', {
        class: 'btn',
        onclick: async function () {
          const text = (st.ui.fbText || '').trim();
          if (!st.ui.stars && !text) { await info(t('err_feedback_empty')); return; }
          const r = await act('feedback', { stars: st.ui.stars || null, text: text, lang: LANG });
          if (!r) return;
          store.set(doneKey(), true);
          render(true);
        }
      }, t('btn_feedback_send')),
      h('button', {
        class: 'btn secondary',
        onclick: function () { store.set(doneKey(), true); render(true); }
      }, t('btn_finish_skip')));
  }

  /** Eigenes Ergebnis als Bild (PNG) speichern. */
  function saveResult() {
    const s = st.status;
    const res = s.result;
    if (!res) return;
    const meId = s.me ? s.me.id : null;
    const rows = res.rows.slice().sort(function (a, b) { return b.share - a.share; });
    const withSF = rows.some(function (r) { return r.S !== null || r.F !== null; });
    const tb = s.teambild;
    const lines = [];
    if (tb) {
      if (tb.accuracy) lines.push(t('tb_accuracy_' + tb.accuracy));
      if (tb.direction) lines.push(t('tb_direction_' + tb.direction));
      if (tb.convergence) lines.push(t('tb_convergence_' + tb.convergence));
    }
    const d = new Date();
    const date = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getFullYear()).slice(2);

    const W = 900, pad = 48, rowH = 52, scale = 2;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

    // Teambild-Zeilen umbrechen
    ctx.font = '26px ' + font;
    const wrapped = [];
    lines.forEach(function (l) {
      const words = l.split(' ');
      let cur = '• ';
      words.forEach(function (w) {
        const test = cur + w + ' ';
        if (ctx.measureText(test).width > W - 2 * pad && cur !== '• ') { wrapped.push(cur); cur = '   ' + w + ' '; }
        else cur = test;
      });
      wrapped.push(cur);
    });

    const H = pad + 60 + 40 + 30 + rowH * (rows.length + 1) + (wrapped.length ? 70 + wrapped.length * 38 : 0) + pad;
    cv.width = W * scale; cv.height = H * scale;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#f6f5f2'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1d1d1b';
    let y = pad + 40;
    ctx.font = 'bold 40px ' + font; ctx.fillText(t('app_title'), pad, y);
    y += 40;
    ctx.font = '24px ' + font; ctx.fillStyle = '#6b6a66'; ctx.fillText(date, pad, y);
    y += 50;

    const cols = withSF ? [pad, W - pad - 420, W - pad - 250, W - pad] : [pad, W - pad];
    ctx.font = 'bold 22px ' + font; ctx.fillStyle = '#6b6a66';
    ctx.textAlign = 'left'; ctx.fillText(t('col_name'), cols[0], y);
    ctx.textAlign = 'right';
    if (withSF) {
      ctx.fillText(t('col_share'), cols[1], y); ctx.fillText(t('col_self'), cols[2], y); ctx.fillText(t('col_other'), cols[3], y);
    } else {
      ctx.fillText(t('col_share'), cols[1], y);
    }
    rows.forEach(function (r) {
      y += rowH;
      if (r.id === meId) { ctx.fillStyle = '#fff4ec'; ctx.fillRect(pad - 12, y - 34, W - 2 * pad + 24, rowH - 4); }
      ctx.fillStyle = '#1d1d1b'; ctx.font = '28px ' + font;
      ctx.textAlign = 'left'; ctx.fillText(r.name + (r.id === meId ? ' (' + t('you') + ')' : ''), cols[0], y);
      ctx.textAlign = 'right';
      if (withSF) {
        ctx.fillText(fmt(r.share), cols[1], y); ctx.fillText(fmt(r.S), cols[2], y); ctx.fillText(fmt(r.F), cols[3], y);
      } else {
        ctx.fillText(fmt(r.share), cols[1], y);
      }
    });
    ctx.textAlign = 'left';
    if (wrapped.length) {
      y += 70;
      ctx.font = 'bold 28px ' + font; ctx.fillStyle = '#1d1d1b'; ctx.fillText(t('teambild_title'), pad, y);
      ctx.font = '26px ' + font;
      wrapped.forEach(function (l) { y += 38; ctx.fillText(l, pad, y); });
    }

    cv.toBlob(function (blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'radical-feedback-' + date + '.png';
      document.body.append(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }, 'image/png');
  }

  function viewRemoved() {
    const s = st.status;
    return [
      h('h1', null, t('app_title')),
      h('p', null, t('you_removed')),
      s.result ? resultTable(s.result) : null,
      s.phase === 'final' ? teambild(s.teambild) : null,
      s.phase === 'final' ? deleteBlock() : null
    ];
  }

  function teambild(tb) {
    if (!tb) return null;
    const lines = [];
    if (tb.accuracy) lines.push(t('tb_accuracy_' + tb.accuracy));
    if (tb.direction) lines.push(t('tb_direction_' + tb.direction));
    if (tb.convergence) lines.push(t('tb_convergence_' + tb.convergence));
    return [
      h('h2', null, t('teambild_title')),
      h('ul', { class: 'teambild' }, lines.map(function (l) { return h('li', null, l); }))
    ];
  }

  function deleteBlock() {
    const s = st.status;
    return [
      h('p', { class: 'muted small' }, t('delete_hint')),
      s.canDelete ? h('button', { class: 'btn secondary', onclick: deleteSession }, t('btn_delete_session')) : null
    ];
  }

  async function deleteSession() {
    const yes = await modal(t('confirm_delete'), t('btn_delete_session'), t('btn_cancel'));
    if (!yes) return;
    const r = await act('deleteSession');
    if (!r) return;
    clearAuth();
    st.fatal = 'deleted';
    render(true);
  }

  function resultTable(res) {
    if (!res) return null;
    const meId = st.status.me ? st.status.me.id : null;
    const rows = res.rows.slice().sort(function (a, b) { return b.share - a.share; });
    const withSF = rows.some(function (r) { return r.S !== null || r.F !== null; });
    const head = h('tr', null,
      h('th', null, t('col_name')),
      h('th', { class: 'num' }, t('col_share')),
      withSF ? h('th', { class: 'num' }, t('col_self')) : null,
      withSF ? h('th', { class: 'num' }, t('col_other')) : null);
    const body = rows.map(function (r) {
      return h('tr', { class: r.id === meId ? 'own' : null },
        h('td', null, r.name + (r.id === meId ? ' (' + t('you') + ')' : ''),
          r.absent ? h('span', { class: 'note' }, t('absent_note')) : null),
        h('td', { class: 'num' }, fmt(r.share)),
        withSF ? h('td', { class: 'num' }, fmt(r.S)) : null,
        withSF ? h('td', { class: 'num' }, fmt(r.F)) : null);
    });
    return [
      h('div', { class: 'card' }, h('table', { class: 'result' }, h('thead', null, head), h('tbody', null, body))),
      !res.full && meId ? h('p', { class: 'muted small' }, t('own_row_hint')) : null
    ];
  }

  function peopleCard() {
    const s = st.status;
    const me = s.me;
    const items = s.people.map(function (p) {
      let text, ok = false;
      if (!p.active) text = t('st_absent');
      else if (s.phase === 'lobby') {
        if (!p.claimed) text = t('st_not_joined');
        else if (p.ready) { text = t('st_ready'); ok = true; }
        else text = t('st_not_ready');
      } else if (s.phase === 'r1' || s.phase === 'r2') {
        if (p.submitted) { text = t('st_submitted'); ok = true; } else text = t('st_not_submitted');
      } else if (s.phase === 'discuss') {
        if (p.ready2) { text = t('st_ready'); ok = true; } else text = t('st_not_ready');
      }
      return h('li', null,
        h('span', null, p.name + (me && p.id === me.id ? ' (' + t('you') + ')' : '')),
        h('span', { class: 'st' + (ok ? ' ok' : '') }, text || ''));
    });
    return [h('h2', null, t('people_title')), h('div', { class: 'card' }, h('ul', { class: 'people' }, items))];
  }

  /* ---------------- Start ---------------- */

  const LANGS = ['de', 'ru', 'en'];

  function pickLang() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('lang');
    if (LANGS.indexOf(fromUrl) >= 0) return fromUrl;
    const saved = store.get('rf_lang');
    if (LANGS.indexOf(saved) >= 0) return saved;
    const nav = (navigator.language || '').slice(0, 2).toLowerCase();
    return LANGS.indexOf(nav) >= 0 ? nav : 'en';
  }

  async function loadLang(lang) {
    try {
      const r = await fetch('lang/' + lang + '.json', { cache: 'no-cache' });
      T = await r.json();
      LANG = lang;
    } catch (e) {
      const r = await fetch('lang/de.json');
      T = await r.json();
      LANG = 'de';
    }
    document.documentElement.lang = LANG;
    NUM = new Intl.NumberFormat(LANG, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    drawLangs();
  }

  function drawLangs() {
    const box = document.getElementById('langs');
    if (!box) return;
    box.replaceChildren.apply(box, LANGS.map(function (l) {
      return h('button', {
        class: 'lang' + (l === LANG ? ' on' : ''),
        'aria-pressed': l === LANG ? 'true' : 'false',
        onclick: async function () {
          if (l === LANG) return;
          store.set('rf_lang', l);
          await loadLang(l);
          render(true);
        }
      }, l.toUpperCase());
    }));
  }

  async function init() {
    await loadLang(pickLang());
    const params = new URLSearchParams(location.search);
    const sid = params.get('s');
    if (!sid) { render(true); return; }
    st.sid = sid;
    st.auth = store.get(authKey());
    render(true);
    await refresh(true);
    setInterval(function () { if (!document.hidden) refresh(false); }, C.POLL_MS || 3000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(false); });
  }

  init();
})();
