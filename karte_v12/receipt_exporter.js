// ===== レセプト データ出力モジュール (receipt_exporter.js) =====
// CSV出力・UKEダウンロード・印刷用レセプト生成
//
// 依存: receipt_viewer.js (allReceipts, institution, esc, formatDate, formatMonth)
//       receipt_codes.js (CATEGORY_NAMES, PROCEDURE_CODES, DISEASE_CODES)
//       master_loader.js (MasterLoader)

const ReceiptExporter = (() => {

  // ============================================================
  // ユーティリティ
  // ============================================================

  /** BOM付きUTF-8 CSVとしてダウンロード */
  function downloadCSV(filename, csvContent) {
    const bom = '\uFEFF';
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  /** テキストファイルとしてダウンロード */
  function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType || 'text/plain;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  /** Blob→ダウンロード */
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** CSVフィールドエスケープ */
  function csvField(val) {
    if (val == null) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ============================================================
  // 1. レセプト一覧 CSV出力
  // ============================================================

  function exportListCSV() {
    const rows = [['種別', 'カルテ番号', '氏名', '性別', '生年月日', '保険種別',
                   '保険者番号', '被保険者番号', '実日数', '合計点数', '一部負担金', '警告数'].join(',')];

    for (const key of ['shaho', 'kokuho', 'shahoHenrei', 'kokuhoHenrei']) {
      const label = { shaho: '社保', kokuho: '国保', shahoHenrei: '社保返戻', kokuhoHenrei: '国保返戻' }[key];
      for (const r of (allReceipts[key] || [])) {
        const warnCount = r.warnings.filter(w => w.severity !== 'info').length;
        const copay = r.insurance ? r.insurance.copayAmount : 0;
        rows.push([
          csvField(label),
          csvField(r.karteNumber),
          csvField(r.name),
          csvField(r.sex),
          csvField(formatDate(r.dob)),
          csvField(r.insuranceType),
          csvField(r.insurance ? r.insurance.insurerNumber : ''),
          csvField(r.insurance ? r.insurance.insuredNumber : ''),
          r.visitDays.length,
          r.totalPoints,
          copay,
          warnCount,
        ].join(','));
      }
    }

    const month = getDisplayMonth();
    downloadCSV('レセプト一覧_' + month + '.csv', rows.join('\r\n'));
  }

  // ============================================================
  // 2. 要確認レセプト（チェック結果）CSV出力
  // ============================================================

  function exportChecklistCSV() {
    const rows = [['種別', 'カルテ番号', '氏名', '保険種別', '深刻度', 'チェック内容'].join(',')];
    const sevLabel = { high: '高', mid: '中', low: '低', info: '情報' };

    for (const key of ['shaho', 'kokuho', 'shahoHenrei', 'kokuhoHenrei']) {
      const label = { shaho: '社保', kokuho: '国保', shahoHenrei: '社保返戻', kokuhoHenrei: '国保返戻' }[key];
      for (const r of (allReceipts[key] || [])) {
        for (const w of r.warnings) {
          rows.push([
            csvField(label),
            csvField(r.karteNumber),
            csvField(r.name),
            csvField(r.insuranceType),
            csvField(sevLabel[w.severity] || w.severity),
            csvField(w.message),
          ].join(','));
        }
      }
    }

    const month = getDisplayMonth();
    downloadCSV('要確認レセプト_' + month + '.csv', rows.join('\r\n'));
  }

  // ============================================================
  // 3. レセプト詳細 CSV出力（個別患者 or 全件）
  // ============================================================

  function exportDetailCSV(receipt) {
    if (!receipt) return;
    const rows = [];

    // ヘッダ情報
    rows.push('# 患者情報');
    rows.push(['氏名', csvField(receipt.name)].join(','));
    rows.push(['カルテ番号', csvField(receipt.karteNumber)].join(','));
    rows.push(['性別', csvField(receipt.sex)].join(','));
    rows.push(['生年月日', csvField(formatDate(receipt.dob))].join(','));
    rows.push(['保険種別', csvField(receipt.insuranceType)].join(','));
    if (receipt.insurance) {
      rows.push(['保険者番号', csvField(receipt.insurance.insurerNumber)].join(','));
      rows.push(['被保険者番号', csvField(receipt.insurance.insuredNumber)].join(','));
    }
    rows.push(['診療年月', csvField(formatMonth(receipt.billingMonth))].join(','));
    rows.push(['合計点数', receipt.totalPoints].join(','));
    rows.push(['実日数', receipt.visitDays.length].join(','));
    rows.push('');

    // 傷病名
    rows.push('# 傷病名');
    rows.push(['コード', '傷病名', '開始日', '修飾語'].join(','));
    for (const d of receipt.diseases) {
      const modName = d.modifier ? (MasterLoader.getModifierName(d.modifier) || MODIFIER_CODES[d.modifier] || d.modifier) : '';
      rows.push([
        csvField(d.code),
        csvField(d.name || d.code),
        csvField(formatDate(d.startDate)),
        csvField(modName),
      ].join(','));
    }
    rows.push('');

    // 診療内容
    rows.push('# 診療内容');
    rows.push(['区分', '区分名', 'コード', '名称', '点数', '数量', '小計'].join(','));
    for (const p of receipt.procedures) {
      let displayName = p.name;
      if (!displayName && p.isDrug) {
        const drug = MasterLoader.getDrug(p.code);
        displayName = drug ? drug.name : p.code;
      }
      if (!displayName) displayName = p.code;
      const subtotal = (p.points && p.quantity) ? p.points * p.quantity : p.points || '';
      rows.push([
        csvField(p.category),
        csvField(CATEGORY_NAMES[p.category] || p.category),
        csvField(p.code),
        csvField(displayName),
        p.points || '',
        p.quantity || '',
        subtotal,
      ].join(','));
    }

    const month = getDisplayMonth();
    downloadCSV('レセプト詳細_' + receipt.karteNumber + '_' + receipt.name + '_' + month + '.csv', rows.join('\r\n'));
  }

  // ============================================================
  // 4. 総括表 CSV出力
  // ============================================================

  function exportSummaryCSV() {
    const data = {};
    for (const key of ['shaho', 'kokuho', 'shahoHenrei', 'kokuhoHenrei']) {
      const list = allReceipts[key] || [];
      data[key] = {
        count: list.length,
        points: list.reduce((s, r) => s + r.totalPoints, 0),
        days: list.reduce((s, r) => s + r.visitDays.length, 0),
        copay: list.reduce((s, r) => s + (r.insurance ? r.insurance.copayAmount : 0), 0),
      };
    }
    const henrei = {
      count: data.shahoHenrei.count + data.kokuhoHenrei.count,
      points: data.shahoHenrei.points + data.kokuhoHenrei.points,
      days: data.shahoHenrei.days + data.kokuhoHenrei.days,
      copay: 0,
    };
    const total = {
      count: data.shaho.count + data.kokuho.count + henrei.count,
      points: data.shaho.points + data.kokuho.points + henrei.points,
      days: data.shaho.days + data.kokuho.days + henrei.days,
      copay: data.shaho.copay + data.kokuho.copay,
    };

    const rows = [];
    rows.push(['', '社保', '国保', '返戻（計）', '合計'].join(','));
    rows.push(['件数', data.shaho.count, data.kokuho.count, henrei.count, total.count].join(','));
    rows.push(['合計点数', data.shaho.points, data.kokuho.points, henrei.points, total.points].join(','));
    rows.push(['実日数合計', data.shaho.days, data.kokuho.days, henrei.days, total.days].join(','));
    rows.push(['一部負担金', data.shaho.copay, data.kokuho.copay, '-', total.copay].join(','));

    const month = getDisplayMonth();
    downloadCSV('総括表_' + month + '.csv', rows.join('\r\n'));
  }

  // ============================================================
  // 5. UKEファイルダウンロード（読み込んだ生データを保存）
  // ============================================================

  // 読み込み時に生テキストを保存するための変数
  let rawUkeData = {};

  function storeRawUke(fileType, text) {
    rawUkeData[fileType] = text;
  }

  function downloadUKE(fileType) {
    if (!rawUkeData[fileType]) {
      alert('UKEデータがありません（' + fileType + '）');
      return;
    }
    const month = getDisplayMonth().replace('/', '');
    downloadText('RECEIPTC_' + fileType + '_' + month + '.UKE', rawUkeData[fileType], 'application/octet-stream');
  }

  function downloadAllUKE() {
    let count = 0;
    for (const key of Object.keys(rawUkeData)) {
      if (rawUkeData[key]) {
        downloadUKE(key);
        count++;
      }
    }
    if (count === 0) alert('UKEデータが読み込まれていません');
  }

  // ============================================================
  // 6. 印刷用レセプト生成
  // ============================================================

  /** 個別レセプトの印刷用HTMLを別ウィンドウで開く */
  function printReceipt(receipt) {
    if (!receipt) return;
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) { alert('ポップアップがブロックされました'); return; }

    const instName = institution.name || '西春内科・在宅クリニック';
    const month = formatMonth(receipt.billingMonth);

    let diseasesHtml = '';
    receipt.diseases.forEach((d, i) => {
      const modName = d.modifier ? (MasterLoader.getModifierName(d.modifier) || MODIFIER_CODES[d.modifier] || '') : '';
      diseasesHtml += '<tr><td>' + (i + 1) + '</td><td>' + he(d.name || d.code) + (modName ? ' (' + he(modName) + ')' : '') +
        '</td><td>' + formatDate(d.startDate) + '</td></tr>';
    });
    if (!diseasesHtml) diseasesHtml = '<tr><td colspan="3" style="text-align:center;color:#999;">傷病名なし</td></tr>';

    let procHtml = '';
    let lastCat = '';
    receipt.procedures.forEach(p => {
      if (p.category !== lastCat && p.category) {
        lastCat = p.category;
        const catName = CATEGORY_NAMES[p.category] || p.category;
        procHtml += '<tr style="background:#f0f0f0;font-weight:600;"><td colspan="5">' + he(catName) + ' (' + he(p.category) + ')</td></tr>';
      }
      let displayName = p.name;
      if (!displayName && p.isDrug) {
        const drug = MasterLoader.getDrug(p.code);
        displayName = drug ? drug.name : '[' + p.code + ']';
      }
      if (!displayName) displayName = '[' + p.code + ']';
      const subtotal = (p.points && p.quantity) ? p.points * p.quantity : p.points || '';
      procHtml += '<tr><td>' + he(displayName) + '</td><td style="text-align:right;">' + (p.points || '') +
        '</td><td style="text-align:right;">' + (p.quantity || '') +
        '</td><td style="text-align:right;">' + subtotal + '</td><td>' + he(p.code) + '</td></tr>';
    });

    const copay = receipt.insurance ? receipt.insurance.copayAmount : 0;

    // 警告セクション
    let warningsHtml = '';
    const realWarns = receipt.warnings.filter(w => w.severity !== 'info');
    if (realWarns.length > 0) {
      warningsHtml = '<div class="section"><div class="section-head warn-head">チェック結果 (' + realWarns.length + '件)</div><table><tr><th>#</th><th>深刻度</th><th>内容</th></tr>';
      realWarns.forEach((w, i) => {
        const sevLabel = w.severity === 'high' ? '高' : w.severity === 'mid' ? '中' : '低';
        warningsHtml += '<tr><td>' + (i + 1) + '</td><td>' + sevLabel + '</td><td>' + he(w.message) + '</td></tr>';
      });
      warningsHtml += '</table></div>';
    }

    w.document.write(buildPrintHTML({
      title: 'レセプト詳細 — ' + he(receipt.name),
      body: `
        <div class="header-bar">${he(instName)} | 診療年月: ${month}</div>
        <h2>${he(receipt.name)} (${he(receipt.karteNumber)}) — ${he(receipt.insuranceType)}</h2>

        <div class="info-grid">
          <div><span class="label">保険者番号:</span> ${he(receipt.insurance ? receipt.insurance.insurerNumber : '-')}</div>
          <div><span class="label">被保険者番号:</span> ${he(receipt.insurance ? receipt.insurance.insuredNumber : '-')}</div>
          <div><span class="label">生年月日:</span> ${formatDate(receipt.dob)}</div>
          <div><span class="label">性別:</span> ${he(receipt.sex)}</div>
          <div><span class="label">受診日:</span> ${receipt.visitDays.join(', ')}日</div>
          <div><span class="label">給付割合:</span> ${receipt.copayRatio || '-'}%</div>
        </div>

        <div class="section">
          <div class="section-head">傷病名</div>
          <table>
            <tr><th>#</th><th>傷病名</th><th>開始日</th></tr>
            ${diseasesHtml}
          </table>
        </div>

        <div class="section">
          <div class="section-head">診療内容</div>
          <table>
            <tr><th>名称</th><th style="width:60px;">点数</th><th style="width:40px;">数量</th><th style="width:60px;">小計</th><th style="width:100px;">コード</th></tr>
            ${procHtml}
          </table>
        </div>

        <div class="total-bar">
          合計点数: <strong>${receipt.totalPoints.toLocaleString()}</strong>
          &nbsp;&nbsp; 実日数: ${receipt.visitDays.length}
          &nbsp;&nbsp; 一部負担金: ${copay ? copay.toLocaleString() + '円' : '-'}
        </div>

        ${warningsHtml}
      `
    }));
    w.document.close();
    setTimeout(() => w.print(), 400);
  }

  /** 総括表の印刷用HTMLを別ウィンドウで開く */
  function printSummary() {
    const data = {};
    for (const key of ['shaho', 'kokuho', 'shahoHenrei', 'kokuhoHenrei']) {
      const list = allReceipts[key] || [];
      data[key] = {
        count: list.length,
        points: list.reduce((s, r) => s + r.totalPoints, 0),
        days: list.reduce((s, r) => s + r.visitDays.length, 0),
        copay: list.reduce((s, r) => s + (r.insurance ? r.insurance.copayAmount : 0), 0),
      };
    }
    const henreiCount = data.shahoHenrei.count + data.kokuhoHenrei.count;
    const henreiPts = data.shahoHenrei.points + data.kokuhoHenrei.points;
    const henreiDays = data.shahoHenrei.days + data.kokuhoHenrei.days;
    const total = {
      count: data.shaho.count + data.kokuho.count + henreiCount,
      points: data.shaho.points + data.kokuho.points + henreiPts,
      days: data.shaho.days + data.kokuho.days + henreiDays,
      copay: data.shaho.copay + data.kokuho.copay,
    };

    const instName = institution.name || '西春内科・在宅クリニック';
    const month = getDisplayMonth();

    // 保険種別ごとの内訳テーブル（社保）
    let shahoDetail = buildCategoryBreakdown(allReceipts.shaho || [], '社保');
    let kokuhoDetail = buildCategoryBreakdown(allReceipts.kokuho || [], '国保');

    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) { alert('ポップアップがブロックされました'); return; }

    w.document.write(buildPrintHTML({
      title: '総括表 — ' + month,
      body: `
        <div class="header-bar">${he(instName)} | 請求年月: ${month}</div>
        <h2>レセプト総括表</h2>

        <div class="section">
          <div class="section-head">サマリー</div>
          <table>
            <tr><th></th><th style="text-align:right;">社保</th><th style="text-align:right;">国保</th><th style="text-align:right;">返戻（計）</th><th style="text-align:right;font-weight:700;">合計</th></tr>
            <tr><td style="font-weight:600;">件数</td>
              <td style="text-align:right;">${data.shaho.count}</td><td style="text-align:right;">${data.kokuho.count}</td>
              <td style="text-align:right;">${henreiCount}</td><td style="text-align:right;font-weight:700;">${total.count}</td></tr>
            <tr><td style="font-weight:600;">合計点数</td>
              <td style="text-align:right;">${data.shaho.points.toLocaleString()}</td><td style="text-align:right;">${data.kokuho.points.toLocaleString()}</td>
              <td style="text-align:right;">${henreiPts.toLocaleString()}</td><td style="text-align:right;font-weight:700;">${total.points.toLocaleString()}</td></tr>
            <tr><td style="font-weight:600;">実日数合計</td>
              <td style="text-align:right;">${data.shaho.days}</td><td style="text-align:right;">${data.kokuho.days}</td>
              <td style="text-align:right;">${henreiDays}</td><td style="text-align:right;font-weight:700;">${total.days}</td></tr>
            <tr><td style="font-weight:600;">一部負担金</td>
              <td style="text-align:right;">${data.shaho.copay.toLocaleString()}</td><td style="text-align:right;">${data.kokuho.copay.toLocaleString()}</td>
              <td style="text-align:right;">-</td><td style="text-align:right;font-weight:700;">${total.copay.toLocaleString()}</td></tr>
          </table>
        </div>

        ${shahoDetail}
        ${kokuhoDetail}

        <div style="margin-top:16px;font-size:10px;color:#999;">
          ※ UKEファイルから自動集計した参考値です。実際の総括表（PDF）と照合してください。<br>
          出力日時: ${new Date().toLocaleString('ja-JP')}
        </div>
      `
    }));
    w.document.close();
    setTimeout(() => w.print(), 400);
  }

  /** 要確認レセプト一覧の印刷 */
  function printChecklist() {
    const allWarns = [];
    for (const key of Object.keys(allReceipts)) {
      const label = { shaho: '社保', kokuho: '国保', shahoHenrei: '社保返戻', kokuhoHenrei: '国保返戻' }[key];
      for (const r of (allReceipts[key] || [])) {
        for (const w of r.warnings) {
          if (w.severity === 'info') continue;
          allWarns.push({ karteNumber: r.karteNumber, name: r.name, insuranceType: r.insuranceType, severity: w.severity, message: w.message, fileType: label });
        }
      }
    }
    const sevOrder = { high: 0, mid: 1, low: 2 };
    allWarns.sort((a, b) => (sevOrder[a.severity] || 9) - (sevOrder[b.severity] || 9));

    let tableRows = '';
    if (allWarns.length === 0) {
      tableRows = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#3a6b35;">全レセプト問題なし</td></tr>';
    } else {
      allWarns.forEach((w, i) => {
        const sevLabel = w.severity === 'high' ? '高' : w.severity === 'mid' ? '中' : '低';
        const sevColor = w.severity === 'high' ? '#c1272d' : w.severity === 'mid' ? '#b45309' : '#457b9d';
        tableRows += '<tr' + (w.severity === 'high' ? ' style="background:#fff0f0;"' : '') + '>' +
          '<td>' + (i + 1) + '</td><td>' + he(w.fileType) + '</td><td>' + he(w.karteNumber) + '</td>' +
          '<td>' + he(w.name) + '</td><td style="color:' + sevColor + ';font-weight:600;">' + sevLabel + '</td>' +
          '<td>' + he(w.message) + '</td></tr>';
      });
    }

    const instName = institution.name || '西春内科・在宅クリニック';
    const month = getDisplayMonth();
    const high = allWarns.filter(w => w.severity === 'high').length;
    const mid = allWarns.filter(w => w.severity === 'mid').length;
    const low = allWarns.filter(w => w.severity === 'low').length;

    const win = window.open('', '_blank', 'width=800,height=900');
    if (!win) { alert('ポップアップがブロックされました'); return; }

    win.document.write(buildPrintHTML({
      title: '要確認レセプト一覧 — ' + month,
      body: `
        <div class="header-bar">${he(instName)} | 診療年月: ${month}</div>
        <h2>要確認レセプト チェック結果</h2>
        <div style="margin-bottom:12px;font-size:12px;">
          警告合計: <strong style="color:#c1272d;">${allWarns.length}件</strong>
          （高: ${high} / 中: ${mid} / 低: ${low}）
        </div>
        <table>
          <tr><th>#</th><th>種別</th><th>カルテ番号</th><th>氏名</th><th>深刻度</th><th>チェック内容</th></tr>
          ${tableRows}
        </table>
        <div style="margin-top:12px;font-size:10px;color:#999;">
          出力日時: ${new Date().toLocaleString('ja-JP')}
        </div>
      `
    }));
    win.document.close();
    setTimeout(() => win.print(), 400);
  }

  // ============================================================
  // 7. エクスポートメニュー UI
  // ============================================================

  function showExportMenu(e) {
    // 既存メニューがあれば削除
    const old = document.getElementById('exportMenu');
    if (old) { old.remove(); return; }

    const menu = document.createElement('div');
    menu.id = 'exportMenu';
    menu.className = 'rc-export-menu';
    menu.innerHTML = `
      <div class="rc-export-title">データ出力</div>
      <div class="rc-export-group">CSV出力</div>
      <button onclick="ReceiptExporter.exportListCSV();closeExportMenu();">レセプト一覧 CSV</button>
      <button onclick="ReceiptExporter.exportChecklistCSV();closeExportMenu();">要確認一覧 CSV</button>
      <button onclick="ReceiptExporter.exportSummaryCSV();closeExportMenu();">総括表 CSV</button>
      <div class="rc-export-group">印刷</div>
      <button onclick="ReceiptExporter.printSummary();closeExportMenu();">総括表 印刷</button>
      <button onclick="ReceiptExporter.printChecklist();closeExportMenu();">要確認一覧 印刷</button>
      <div class="rc-export-group">UKEファイル</div>
      <button onclick="ReceiptExporter.downloadAllUKE();closeExportMenu();">UKE 一括ダウンロード</button>
    `;

    // ボタン位置に合わせて表示
    const rect = e.target.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    document.body.appendChild(menu);

    // 外側クリックで閉じる
    setTimeout(() => {
      document.addEventListener('click', closeExportMenuOnOutside, { once: true });
    }, 50);
  }

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function he(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getDisplayMonth() {
    const firstReceipt = [...(allReceipts.shaho || []), ...(allReceipts.kokuho || []),
                          ...(allReceipts.shahoHenrei || []), ...(allReceipts.kokuhoHenrei || [])][0];
    const m = firstReceipt ? firstReceipt.billingMonth : (institution.billingMonth || '');
    return formatMonth(m);
  }

  /** 保険種別ごとの診療区分内訳テーブルHTML */
  function buildCategoryBreakdown(receipts, label) {
    if (receipts.length === 0) return '';
    // 区分ごとの点数集計
    const catTotals = {};
    for (const r of receipts) {
      for (const p of r.procedures) {
        const cat = p.category || '99';
        const catName = CATEGORY_NAMES[cat] || cat;
        if (!catTotals[cat]) catTotals[cat] = { name: catName, points: 0, count: 0 };
        const pts = (p.points && p.quantity) ? p.points * p.quantity : (p.points || 0);
        catTotals[cat].points += pts;
        catTotals[cat].count++;
      }
    }
    const entries = Object.entries(catTotals).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    let rows = '';
    let grandTotal = 0;
    for (const [cat, d] of entries) {
      rows += '<tr><td>' + he(cat) + '</td><td>' + he(d.name) + '</td><td style="text-align:right;">' +
        d.count + '</td><td style="text-align:right;">' + d.points.toLocaleString() + '</td></tr>';
      grandTotal += d.points;
    }
    return `
      <div class="section">
        <div class="section-head">${he(label)} 診療区分内訳 (${receipts.length}件)</div>
        <table>
          <tr><th>区分</th><th>名称</th><th style="text-align:right;">行為数</th><th style="text-align:right;">点数計</th></tr>
          ${rows}
          <tr style="font-weight:700;border-top:2px solid #333;"><td colspan="3">合計</td><td style="text-align:right;">${grandTotal.toLocaleString()}</td></tr>
        </table>
      </div>`;
  }

  /** 印刷用HTML共通テンプレート */
  function buildPrintHTML({ title, body }) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>${he(title)}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Yu Gothic", "Meiryo", sans-serif; font-size: 11px; color: #222; line-height: 1.5; }
  h2 { font-size: 16px; margin: 8px 0 12px; color: #1a2744; }
  .header-bar { background: #264653; color: #fff; padding: 6px 12px; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 16px; margin-bottom: 12px; font-size: 11px; }
  .info-grid .label { color: #666; }
  .section { border: 1px solid #ccc; margin-bottom: 10px; }
  .section-head { background: #e8e4dc; padding: 4px 10px; font-weight: 600; font-size: 11px; border-bottom: 1px solid #ccc; }
  .warn-head { background: #fff0f0; color: #c1272d; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f0ede6; padding: 3px 6px; border: 1px solid #bbb; font-size: 10px; text-align: left; }
  td { padding: 3px 6px; border: 1px solid #ddd; font-size: 10px; }
  .total-bar { border-top: 2px solid #264653; padding: 6px 10px; font-size: 12px; margin-bottom: 10px; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
</style></head><body>${body}</body></html>`;
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    exportListCSV,
    exportChecklistCSV,
    exportDetailCSV,
    exportSummaryCSV,
    storeRawUke,
    downloadUKE,
    downloadAllUKE,
    printReceipt,
    printSummary,
    printChecklist,
    showExportMenu,
  };
})();

// グローバルからメニューを閉じるヘルパー
function closeExportMenu() {
  const el = document.getElementById('exportMenu');
  if (el) el.remove();
}
function closeExportMenuOnOutside(e) {
  const menu = document.getElementById('exportMenu');
  if (menu && !menu.contains(e.target)) {
    menu.remove();
  }
}
