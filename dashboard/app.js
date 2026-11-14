// Launch Radar's page: it reads window.RADAR (written beside dashboard/ by main.ts from the same
// board board.json carries) and renders the ranked board, the Already trading set-aside, the model
// view and one detail view per protocol. No network and no framework: every byte it shows is in
// data.js, and the farm plan it prints for a protocol is the very string board.json carries.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var main = document.querySelector('main');
  if (!DATA) {
    main.innerHTML = '<p style="padding:24px">The radar data (data.js) did not load: run the program first.</p>';
    return;
  }

  // ------------------------------------------------------------ small helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function moneyFull(n) {
    return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(n) {
    if (n == null) return '<span class="flat">n/a</span>';
    var cls = n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : 'flat';
    return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function ageText(days) {
    if (days == null) return 'untracked';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function chainText(chains) {
    if (!chains || chains.length === 0) return '—';
    if (chains.length <= 2) return esc(chains.join(', '));
    return esc(chains.slice(0, 2).join(', ')) + ' +' + (chains.length - 2);
  }
  function badge(row) {
    return row.watchlist
      ? '<span class="badge watch">★ Watchlist</span>'
      : '<span class="badge early">Radar catch</span>';
  }

  // ------------------------------------------------------------ header and stats
  $('topmeta').textContent = 'Snapshot as of ' + DATA.as_of + ' · ' + DATA.source;
  $('footmeta').textContent =
    'Model ' + DATA.model_version + ' · global median multiple ' + DATA.global_multiple.toFixed(2) + '× TVL · ' +
    'undated protocols priced at the median age of ' + DATA.median_age_days + ' days · watchlist floor ' + money(DATA.floor_usd) + '. ';
  var totalImplied = DATA.rows.reduce(function (sum, r) { return sum + r.implied_value_usd; }, 0);
  var stats = [
    { v: String(DATA.board_size), l: 'pre-token protocols ranked', hot: true },
    { v: DATA.watchlist_size + ' / ' + DATA.watchlist_size, l: 'watchlist covered, none missed' },
    { v: String(DATA.early_size), l: 'early catches beyond the floor' },
    { v: money(totalImplied), l: 'total implied launch value' },
    { v: DATA.global_multiple.toFixed(2) + '×', l: 'global median mcap / TVL of peers' },
    { v: String(DATA.live_size), l: 'live tokens set aside as comparables' },
  ];
  $('stats').innerHTML = stats
    .map(function (s) { return '<div class="stat' + (s.hot ? ' hot' : '') + '"><b>' + esc(s.v) + '</b><span>' + esc(s.l) + '</span></div>'; })
    .join('');

  // ------------------------------------------------------------ the board
  var state = { q: '', cat: '', chain: '', scope: 'all', sort: 'rank' };
  var maxImplied = DATA.rows.length ? DATA.rows[0].implied_value_usd : 1;

  var catSel = $('cat');
  var cats = [];
  DATA.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  catSel.innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  var chainSel = $('chain');
  var chainNames = [];
  DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { if (chainNames.indexOf(c) === -1) chainNames.push(c); }); });
  chainNames.sort();
  chainSel.innerHTML = '<option value="">All chains</option>' + chainNames.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  function sortRows(rows) {
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      name: function (a, b) { return a.name.localeCompare(b.name); },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d); },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
      multiple: function (a, b) { return b.category_multiple - a.category_multiple || a.rank - b.rank; },
      cheap: function (a, b) { return a.plan_capital_usd + a.plan_gas_usd - (b.plan_capital_usd + b.plan_gas_usd) || a.rank - b.rank; },
    };
    return rows.sort(by[state.sort] || by.rank);
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.scope === 'watch' && !r.watchlist) return false;
      if (state.scope === 'early' && r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    return sortRows(rows);
  }

  function renderBoard() {
    var rows = visibleRows();
    $('count').textContent =
      'Showing ' + rows.length + ' of ' + DATA.board_size + ' ranked protocols' +
      (state.scope === 'watch' ? ' (watchlist only)' : state.scope === 'early' ? ' (early catches only)' : '') +
      '. Click a row for its price workings and farm plan.';
    $('rows').innerHTML = rows
      .map(function (r) {
        var w = Math.max(2, Math.round((r.implied_value_usd / maxImplied) * 100));
        return (
          '<tr data-slug="' + esc(r.slug) + '">' +
          '<td class="num rank">' + r.rank + '</td>' +
          '<td class="name">' + esc(r.name) + badge(r) + '<span class="slug">' + esc(r.slug) + '</span></td>' +
          '<td class="cat">' + esc(r.category || 'Uncategorized') + '</td>' +
          '<td class="chains">' + chainText(r.chains) + '</td>' +
          '<td class="num">' + money(r.tvl_usd) + '</td>' +
          '<td class="num">' + pct(r.change_7d) + '</td>' +
          '<td class="num">' + ageText(r.age_days) + '</td>' +
          '<td class="num">' + r.category_multiple.toFixed(2) + '×</td>' +
          '<td class="num"><span class="value">' + money(r.implied_value_usd) + '</span><span class="bar"><i style="width:' + w + '%"></i></span></td>' +
          '<td class="plan"><b>' + money(r.plan_capital_usd) + '</b> in · ~' + money(r.plan_gas_usd) + ' gas · ' + r.plan_weeks + ' wk</td>' +
          '</tr>'
        );
      })
      .join('');
    var trs = $('rows').querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { location.hash = 'p/' + this.getAttribute('data-slug'); });
    }
  }

  // ------------------------------------------------------------ already trading
  function renderLive() {
    $('liverows').innerHTML = DATA.live
      .map(function (r) {
        return (
          '<tr>' +
          '<td class="name">' + esc(r.name) + '<span class="slug">' + esc(r.slug) + '</span></td>' +
          '<td class="cat">' + esc(r.category || 'Uncategorized') + '</td>' +
          '<td class="chains">' + chainText(r.chains) + '</td>' +
          '<td class="num">' + money(r.tvl_usd) + '</td>' +
          '<td class="num">' + money(r.mcap_usd) + '</td>' +
          '<td class="num">' + pct(r.change_7d) + '</td>' +
          '<td class="num">' + (r.ratio == null ? '—' : r.ratio.toFixed(2) + '×') + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  // ------------------------------------------------------------ the model view
  function renderModel() {
    var rows = DATA.categories
      .map(function (c) {
        return (
          '<tr><td>' + esc(c.category || 'Uncategorized') + '</td>' +
          '<td class="num">' + c.peers + '</td>' +
          '<td class="num">' + (c.median_ratio == null ? '—' : c.median_ratio.toFixed(2) + '×') + '</td>' +
          '<td class="num"><b>' + c.multiple.toFixed(2) + '×</b></td></tr>'
        );
      })
      .join('');
    $('cattable').innerHTML =
      '<table class="mini"><thead><tr><th>Category</th><th class="num">Tokenized peers</th>' +
      '<th class="num">Median mcap / TVL</th><th class="num">Multiple used</th></tr></thead><tbody>' +
      rows + '</tbody></table>' +
      '<p class="fineprint">The global median across every tokenized protocol is ' + DATA.global_multiple.toFixed(2) +
      '×; a category with fewer than three peers, and any protocol whose category has no peers, prices at it.</p>';
  }

  // ------------------------------------------------------------ detail view
  function categoryPrice(cat) {
    for (var i = 0; i < DATA.categories.length; i++) if (DATA.categories[i].category === cat) return DATA.categories[i];
    return null;
  }

  function renderDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) row = DATA.rows[i];
    var box = $('detail');
    if (!row) {
      box.innerHTML = '<p><button type="button" class="backlink" id="backbtn">← Back to the board</button></p><p>No protocol with that slug is on the board.</p>';
      bindBack();
      return;
    }
    var price = categoryPrice(row.category);
    var medianNote = price && price.median_ratio != null
      ? 'median ' + price.median_ratio.toFixed(2) + '× across ' + price.peers + ' tokenized peers, shrunk toward the global ' + DATA.global_multiple.toFixed(2) + '×'
      : 'no tokenized peers in this category: priced at the global median ' + DATA.global_multiple.toFixed(2) + '×';
    var tiles = [
      { v: money(row.tvl_usd), l: 'TVL in the snapshot' },
      { v: money(row.implied_value_usd), l: 'implied launch value (rank #' + row.rank + ')' },
      { v: row.change_7d == null ? 'n/a' : (row.change_7d > 0 ? '+' : '') + row.change_7d.toFixed(1) + '%', l: 'TVL change, 7 days' },
      { v: row.age_days == null ? 'untracked' : row.age_days + ' days', l: 'token-free runway' + (row.listed_at ? ' (tracked since ' + row.listed_at + ')' : '') },
      { v: String(row.chains.length), l: 'chains: ' + (row.chains.slice(0, 4).join(', ') || 'none named') + (row.chains.length > 4 ? '…' : '') },
      { v: row.category_multiple.toFixed(2) + '×', l: 'category multiple (' + (row.category || 'Uncategorized') + ')' },
    ];
    var factors =
      '<table class="factors">' +
      '<tr><td>TVL, the base figure</td><td class="num">' + moneyFull(row.tvl_usd) + '</td></tr>' +
      '<tr><td>× category multiple — ' + esc(medianNote) + '</td><td class="num">× ' + row.category_multiple.toFixed(2) + '</td></tr>' +
      '<tr><td>× growth — its 7-day TVL change, capped and halved</td><td class="num">× ' + row.growth_multiplier.toFixed(2) + '</td></tr>' +
      '<tr><td>× runway — ' + (row.age_days == null ? 'no tracking date: priced at the median age' : row.age_days + ' days with no token') + '</td><td class="num">× ' + row.runway_multiplier.toFixed(2) + '</td></tr>' +
      '<tr><td>× breadth — ' + row.chains.length + ' chain' + (row.chains.length === 1 ? '' : 's') + ' of distribution</td><td class="num">× ' + row.breadth_multiplier.toFixed(2) + '</td></tr>' +
      '<tr class="total"><td>= implied launch value</td><td class="num">' + moneyFull(row.implied_value_usd) + '</td></tr>' +
      '</table>';
    var comps = row.comps.length
      ? '<table class="factors"><thead><tr><th>Tokenized peer</th><th class="num">Market cap</th><th class="num">TVL</th><th class="num">Mcap / TVL</th></tr></thead><tbody>' +
        row.comps.map(function (c) {
          return '<tr><td>' + esc(c.name) + '</td><td class="num">' + money(c.mcap_usd) + '</td><td class="num">' + money(c.tvl_usd) + '</td><td class="num">' + c.ratio.toFixed(2) + '×</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="fineprint">No tokenized protocol in this category is near it in size, so its price leans on the category median itself.</p>';
    var steps = row.farm_steps
      .map(function (s) {
        var at = s.indexOf(' Cost: ');
        if (at === -1) return '<li>' + esc(s) + '</li>';
        return '<li>' + esc(s.slice(0, at)) + '<span class="meta">' + esc(s.slice(at + 1)) + '</span></li>';
      })
      .join('');
    box.innerHTML =
      '<p><button type="button" class="backlink" id="backbtn">← Back to the board</button></p>' +
      '<div class="detail-head"><h2>' + esc(row.name) + '</h2>' + badge(row) + '</div>' +
      '<p class="detail-sub">' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorized') + ' · records no token in the snapshot as of ' + DATA.as_of + '</p>' +
      '<div class="tiles">' + tiles.map(function (t) { return '<div class="tile"><span>' + esc(t.l) + '</span><b>' + esc(t.v) + '</b></div>'; }).join('') + '</div>' +
      '<div class="panelbox"><h3>The price, line by line</h3>' + factors + '</div>' +
      '<div class="panelbox"><h3>Priced against the market</h3>' + comps + '</div>' +
      '<div class="panelbox"><h3>The farm plan</h3>' +
      '<div class="planchips">' +
      '<span class="chip">Capital in position: <b>' + money(row.plan_capital_usd) + '</b></span>' +
      '<span class="chip">Gas, all-in estimate: <b>~' + money(row.plan_gas_usd) + '</b></span>' +
      '<span class="chip">Hold: <b>' + row.plan_weeks + ' weeks</b></span>' +
      '<span class="chip">Routine: <b>' + row.plan_weekly_minutes + ' min/week</b></span>' +
      '</div>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="fineprint">Costs are the plan\'s own estimates from the protocol\'s chains and size, not quotes: check the app\'s own fee display before signing anything, and never pay a third party to claim a reward.</p>' +
      '</div>';
    bindBack();
    window.scrollTo(0, 0);
  }
  function bindBack() {
    var b = $('backbtn');
    if (b) b.addEventListener('click', function () { location.hash = 'board'; });
  }

  // ------------------------------------------------------------ views and routing
  var views = { board: $('boardview'), live: $('liveview'), model: $('modelview'), detail: $('detail') };
  function show(view, slug) {
    views.board.hidden = view !== 'board';
    views.live.hidden = view !== 'live';
    views.model.hidden = view !== 'model';
    views.detail.hidden = view !== 'detail';
    var tabs = $('tabs').querySelectorAll('button');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-view') === view);
    if (view === 'detail') renderDetail(slug);
  }
  function route() {
    var h = (location.hash || '#board').replace(/^#/, '');
    if (h.indexOf('p/') === 0) { show('detail', decodeURIComponent(h.slice(2))); return; }
    if (h === 'live') { show('live'); return; }
    if (h === 'model') { show('model'); return; }
    // board, optionally with filter state: board?cat=Dexs&scope=watch&q=..&sort=tvl&chain=Base
    if (h.indexOf('board') === 0) {
      var qm = h.indexOf('?');
      if (qm !== -1) {
        var params = new URLSearchParams(h.slice(qm + 1));
        if (params.get('q') !== null) { state.q = params.get('q'); $('q').value = state.q; }
        if (params.get('cat') !== null) { state.cat = params.get('cat'); catSel.value = state.cat; }
        if (params.get('chain') !== null) { state.chain = params.get('chain'); chainSel.value = state.chain; }
        if (params.get('scope') !== null) { state.scope = params.get('scope'); $('scope').value = state.scope; }
        if (params.get('sort') !== null) { state.sort = params.get('sort'); $('sort').value = state.sort; }
        renderBoard();
      }
      show('board');
      return;
    }
    show('board');
  }

  // ------------------------------------------------------------ events and init
  $('q').addEventListener('input', function () { state.q = this.value; renderBoard(); });
  catSel.addEventListener('change', function () { state.cat = this.value; renderBoard(); });
  chainSel.addEventListener('change', function () { state.chain = this.value; renderBoard(); });
  $('scope').addEventListener('change', function () { state.scope = this.value; renderBoard(); });
  $('sort').addEventListener('change', function () { state.sort = this.value; renderBoard(); });
  var heads = document.querySelectorAll('th.sortable');
  for (var i = 0; i < heads.length; i++) {
    heads[i].addEventListener('click', function () {
      state.sort = this.getAttribute('data-sort');
      $('sort').value = state.sort;
      renderBoard();
    });
  }
  var tabBtns = $('tabs').querySelectorAll('button');
  for (var j = 0; j < tabBtns.length; j++) {
    tabBtns[j].addEventListener('click', function () { location.hash = this.getAttribute('data-view'); });
  }
  window.addEventListener('hashchange', route);
  renderBoard();
  renderLive();
  renderModel();
  route();
})();
