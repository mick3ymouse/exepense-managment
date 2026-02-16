/**
 * Expense Management App — Frontend Logic
 * ─────────────────────────────────────────
 * Handles: SPA routing, file upload (dashboard + Elenco '+' icon),
 * Dashboard dynamic data (fetch from /dashboard-stats, /available-periods),
 * Elenco page rendering (Year > Month > Table),
 * real-time search, date filtering, eye toggle (exclude/include).
 */

/* ══════════════════════════════════════════════════
   MONTH MAP (for filter dropdowns)
   ══════════════════════════════════════════════════ */
const MONTH_NAMES = {
    1: 'Gennaio', 2: 'Febbraio', 3: 'Marzo', 4: 'Aprile',
    5: 'Maggio', 6: 'Giugno', 7: 'Luglio', 8: 'Agosto',
    9: 'Settembre', 10: 'Ottobre', 11: 'Novembre', 12: 'Dicembre'
};

document.addEventListener('DOMContentLoaded', function () {

    // ══════════════════════════════════════════════════
    // 1. SPA ROUTER — Sidebar Navigation
    // ══════════════════════════════════════════════════
    const navItems = document.querySelectorAll('.nav-item[data-page]');
    const pages = document.querySelectorAll('.page');
    let dashboardDirty = false;  // Set true when Elenco data changes

    // ══════════════════════════════════════════════════
    // 1. SPA ROUTER — State-Driven Navigation
    // ══════════════════════════════════════════════════
    function setActiveView(viewId) {
        // 1. Save state
        localStorage.setItem('activeTab', viewId);

        // 2. Update Sidebar
        navItems.forEach(item => {
            item.classList.toggle('active', item.dataset.page === viewId);
        });

        // 3. Update Pages
        pages.forEach(page => {
            const pageEl = document.getElementById(`page-${viewId}`);
            // Toggle active class on all pages
            if (page.id === `page-${viewId}`) {
                page.classList.add('active');
            } else {
                page.classList.remove('active');
            }
        });

        // 4. Trigger Page Logic
        if (viewId === 'elenco') {
            loadExpenses();
        } else if (viewId === 'dashboard') {
            // Only reload if dirty.
            // Note: currentYear is defined later, but this block only runs
            // if dashboardDirty is true, which implies we've been to Elenco and back.
            if (dashboardDirty) {
                dashboardDirty = false;
                loadDashboardStats(currentYear, currentMonth);
            }
        }
    }

    // Event Listeners
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            setActiveView(item.dataset.page);
        });
    });

    // Immediate Init (No Flicker)
    const savedTab = localStorage.getItem('activeTab') || 'dashboard';
    setActiveView(savedTab);

    // ══════════════════════════════════════════════════
    // 2. DASHBOARD — Chart.js (created once, updated dynamically)
    // ══════════════════════════════════════════════════
    let panoramicaChart = null;
    const ctx = document.getElementById('panoramicaChart');

    if (ctx) {
        panoramicaChart = new Chart(ctx.getContext('2d'), {
            type: 'bar',
            data: {
                labels: ['Entrate', 'Uscite'],
                datasets: [{
                    label: 'EUR',
                    data: [0, 0],
                    backgroundColor: [
                        'rgba(39, 174, 96, 0.65)',    // Verde smeraldo morbido
                        'rgba(192, 57, 43, 0.55)'     // Rosso corallo morbido
                    ],
                    hoverBackgroundColor: [
                        'rgba(39, 174, 96, 0.85)',
                        'rgba(192, 57, 43, 0.75)'
                    ],
                    borderWidth: 0,
                    borderRadius: 8,
                    barThickness: 44
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { display: true, drawBorder: false, color: 'rgba(127,200,217,0.25)' },
                        ticks: { color: '#2C6E7C', font: { family: 'Inter', weight: '500' } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#2C6E7C', font: { family: 'Inter', weight: '600' } }
                    }
                }
            }
        });
    }

    // ══════════════════════════════════════════════════
    // 3. DASHBOARD — Dynamic Filters + Data Loading
    // ══════════════════════════════════════════════════
    const yearFilter = document.getElementById('year-filter');
    const monthFilter = document.getElementById('month-filter');
    let availablePeriods = [];  // [{year, month, month_name}]
    let currentYear = null;
    let currentMonth = null;

    async function initDashboard() {
        try {
            const res = await fetch('/available-periods');
            const data = await res.json();

            if (!data.periods || data.periods.length === 0) return;

            availablePeriods = data.periods;

            // Populate year dropdown
            const years = data.years || [...new Set(data.periods.map(p => p.year))].sort((a, b) => b - a);
            yearFilter.innerHTML = '';
            years.forEach(y => {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = y;
                yearFilter.appendChild(opt);
            });

            // Set default to latest
            currentYear = data.latest_year;
            currentMonth = data.latest_month;
            yearFilter.value = currentYear;

            // Populate months for the selected year
            updateMonthDropdown(currentYear);
            monthFilter.value = currentMonth;

            // Load stats
            loadDashboardStats(currentYear, currentMonth);
        } catch (err) {
            console.error('Errore caricamento periodi:', err);
        }
    }

    function updateMonthDropdown(year) {
        const monthsForYear = availablePeriods
            .filter(p => p.year === parseInt(year))
            .sort((a, b) => b.month - a.month);

        monthFilter.innerHTML = '';
        monthsForYear.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.month;
            opt.textContent = MONTH_NAMES[p.month] || p.month_name;
            monthFilter.appendChild(opt);
        });
    }

    // Filter change handlers
    if (yearFilter) {
        yearFilter.addEventListener('change', () => {
            currentYear = parseInt(yearFilter.value);
            updateMonthDropdown(currentYear);
            currentMonth = parseInt(monthFilter.value);
            loadDashboardStats(currentYear, currentMonth);
            yearFilter.blur();
        });
    }

    if (monthFilter) {
        monthFilter.addEventListener('change', () => {
            currentMonth = parseInt(monthFilter.value);
            loadDashboardStats(currentYear, currentMonth);
            monthFilter.blur();
        });
    }

    async function loadDashboardStats(year, month) {
        try {
            const res = await fetch(`/dashboard-stats?year=${year}&month=${month}`);
            const data = await res.json();
            renderDashboardStats(data);
        } catch (err) {
            console.error('Errore caricamento statistiche:', err);
        }
    }

    function renderDashboardStats(data) {
        // Update metrics
        const metricEntrate = document.getElementById('metric-entrate');
        const metricUscite = document.getElementById('metric-uscite');
        const metricSaldo = document.getElementById('metric-saldo');

        if (metricEntrate) metricEntrate.textContent = formatEuro(data.entrate);
        if (metricUscite) metricUscite.textContent = '-' + formatEuro(data.uscite);
        if (metricSaldo) {
            metricSaldo.textContent = (data.saldo >= 0 ? '+' : '') + formatEuro(data.saldo);
            metricSaldo.className = 'metric-value ' + (data.saldo >= 0 ? 'saldo-positive' : 'saldo-negative');
        }

        // Update chart
        if (panoramicaChart) {
            panoramicaChart.data.datasets[0].data = [data.entrate, data.uscite];
            panoramicaChart.update();
        }

        // Update top categories
        renderTopCategories(data.top_categories || []);
    }

    function renderTopCategories(categories) {
        const container = document.getElementById('top-categories-container');
        if (!container) return;

        if (categories.length === 0) {
            container.innerHTML = '<p class="top-cat-empty" style="color: var(--azzurro-pastello); text-align: center; padding: 20px; font-weight: 500;">Nessuna spesa per questo mese.</p>';
            return;
        }

        const maxAmount = categories[0].totale;  // First is the highest
        const medals = ['🥇', '🥈', '🥉'];

        let html = '<ul class="top-cat-list">';
        categories.forEach((cat, i) => {
            const pct = maxAmount > 0 ? (cat.totale / maxAmount) * 100 : 0;
            html += `
                <li class="top-cat-item">
                    <div class="top-cat-info">
                        <span class="top-cat-rank">${medals[i] || (i + 1)}</span>
                        <span class="top-cat-name">${escapeHtml(cat.categoria)}</span>
                        <span class="top-cat-amount">${formatEuro(cat.totale)}</span>
                    </div>
                    <div class="top-cat-bar-track">
                        <div class="top-cat-bar-fill" style="width: ${pct}%"></div>
                    </div>
                </li>
            `;
        });
        html += '</ul>';
        container.innerHTML = html;
    }

    // Initialize dashboard on page load
    initDashboard();

    // ══════════════════════════════════════════════════
    // 4. FILE UPLOAD — Dashboard (drag & drop + button)
    // ══════════════════════════════════════════════════
    let selectedFiles = [];
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('fileElem');
    const uploadBtn = document.getElementById('upload-btn');
    const uploadToast = document.getElementById('upload-toast');

    if (dropArea) {
        dropArea.addEventListener('click', () => fileInput.click());

        ['dragenter', 'dragover'].forEach(evt => {
            dropArea.addEventListener(evt, (e) => {
                e.preventDefault(); e.stopPropagation();
                dropArea.style.borderColor = '#4A9EAF';
                dropArea.style.backgroundColor = 'rgba(127,200,217,0.08)';
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropArea.addEventListener(evt, (e) => {
                e.preventDefault(); e.stopPropagation();
                dropArea.style.borderColor = '';
                dropArea.style.backgroundColor = '';
            });
        });

        dropArea.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.xlsx'));
            if (files.length > 0) {
                selectedFiles = files;
                document.querySelector('.file-msg').textContent = `${files.length} file selezionati`;
            }
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                selectedFiles = Array.from(e.target.files);
                document.querySelector('.file-msg').textContent = `${selectedFiles.length} file selezionati`;
            }
        });
    }

    if (uploadBtn) {
        uploadBtn.addEventListener('click', async () => {
            if (selectedFiles.length === 0) {
                showToast(uploadToast, 'Nessun file selezionato.', 'error');
                return;
            }
            uploadBtn.disabled = true;
            uploadBtn.textContent = 'Caricamento...';

            let totalNew = 0, totalDup = 0, totalErr = 0;
            for (const file of selectedFiles) {
                const formData = new FormData();
                formData.append('file', file);
                try {
                    const res = await fetch('/upload', { method: 'POST', body: formData });
                    const data = await res.json();
                    if (res.ok) {
                        totalNew += data.new || 0;
                        totalDup += data.duplicates || 0;
                        totalErr += data.errors || 0;
                    } else {
                        showToast(uploadToast, `Errore: ${data.error}`, 'error');
                    }
                } catch (err) {
                    showToast(uploadToast, `Errore di rete: ${err.message}`, 'error');
                }
            }

            showToast(uploadToast,
                `✓ ${totalNew} nuove spese importate, ${totalDup} duplicati scartati` +
                (totalErr > 0 ? `, ${totalErr} errori` : ''),
                'success'
            );

            selectedFiles = [];
            document.querySelector('.file-msg').textContent = 'Trascina qui i tuoi file Excel (.xlsx)';
            fileInput.value = '';
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Carica e Analizza';

            // Refresh dashboard data after upload
            initDashboard();
        });
    }

    // ══════════════════════════════════════════════════
    // 5. ELENCO — '+' Icon Upload
    // ══════════════════════════════════════════════════
    const elencoImportBtn = document.getElementById('elenco-import-btn');
    const elencoFileInput = document.getElementById('elenco-file-input');
    const elencoToast = document.getElementById('elenco-toast');

    if (elencoImportBtn) {
        elencoImportBtn.addEventListener('click', () => {
            elencoFileInput.click();
        });
    }

    if (elencoFileInput) {
        elencoFileInput.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files).filter(f => f.name.endsWith('.xlsx'));
            if (files.length === 0) return;

            let totalNew = 0, totalDup = 0;
            for (const file of files) {
                const formData = new FormData();
                formData.append('file', file);
                try {
                    const res = await fetch('/upload', { method: 'POST', body: formData });
                    const data = await res.json();
                    if (res.ok) {
                        totalNew += data.new || 0;
                        totalDup += data.duplicates || 0;
                    }
                } catch (err) { /* silent */ }
            }

            showToast(elencoToast, `✓ ${totalNew} nuove spese, ${totalDup} duplicati`, 'success');
            elencoFileInput.value = '';
            loadExpenses();
        });
    }

    // ══════════════════════════════════════════════════
    // 6. ELENCO — Load & Render Expenses
    // ══════════════════════════════════════════════════
    async function loadExpenses() {
        const searchInput = document.getElementById('search-input');
        const dateStart = document.getElementById('date-start');
        const dateEnd = document.getElementById('date-end');

        const params = new URLSearchParams();
        if (searchInput && searchInput.value.trim()) params.set('search_text', searchInput.value.trim());
        if (dateStart && dateStart.value) params.set('start_date', dateStart.value);
        if (dateEnd && dateEnd.value) params.set('end_date', dateEnd.value);

        try {
            const [expRes, statusRes] = await Promise.all([
                fetch(`/expenses?${params.toString()}`),
                fetch('/monthly-status')
            ]);
            const data = await expRes.json();
            const statusMap = await statusRes.json();   // { "2025-11": true, ... }
            renderExpenses(data, statusMap);
        } catch (err) {
            console.error('Errore caricamento spese:', err);
        }
    }

    function renderExpenses(data, statusMap) {
        _lastExpenseData = data;  // store for autocomplete extraction
        statusMap = statusMap || {};
        const container = document.getElementById('expenses-list');
        if (!container) return;
        container.innerHTML = '';

        const years = Object.keys(data).sort((a, b) => b - a);
        if (years.length === 0) {
            container.appendChild(createEmptyState());
            return;
        }

        // Reverse map: month name → number for sorting
        const MONTH_ORDER = {};
        Object.entries(MONTH_NAMES).forEach(([num, name]) => MONTH_ORDER[name] = parseInt(num));

        years.forEach(year => {
            const yearHeader = document.createElement('h2');
            yearHeader.className = 'year-header';
            yearHeader.textContent = `Anno ${year}`;
            container.appendChild(yearHeader);

            const months = data[year];
            const sortedMonths = Object.keys(months).sort((a, b) => (MONTH_ORDER[b] || 0) - (MONTH_ORDER[a] || 0));
            sortedMonths.forEach(month => {
                const expenses = months[month];
                const monthNum = MONTH_ORDER[month] || 1;
                const monthSection = document.createElement('div');
                monthSection.className = 'month-section';
                monthSection.dataset.year = year;
                monthSection.dataset.month = String(monthNum);

                // Month title + reimbursable badge
                const monthTitle = document.createElement('h3');
                monthTitle.className = 'month-title';
                monthTitle.textContent = month;

                const statusKey = `${year}-${String(monthNum).padStart(2, '0')}`;
                const isPaid = !!statusMap[statusKey];

                const badge = document.createElement('span');
                badge.className = 'month-badge ' + (isPaid ? 'badge-paid' : 'badge-unpaid');
                badge.innerHTML = isPaid
                    ? '<i class="fa-solid fa-sack-dollar"></i> Rimborsato: — €'
                    : '<i class="fa-solid fa-hand-holding-dollar"></i> Da Rimborsare: — €';
                monthTitle.appendChild(badge);
                monthSection.appendChild(monthTitle);

                const table = document.createElement('table');
                table.className = 'expense-table';

                // Colgroup for fixed column widths
                const colgroup = document.createElement('colgroup');
                colgroup.innerHTML = `
                    <col class="col-data">
                    <col class="col-operazione">
                    <col class="col-categoria">
                    <col class="col-conto">
                    <col class="col-importo">
                    <col class="col-azioni">
                `;
                table.appendChild(colgroup);

                const thead = document.createElement('thead');
                thead.innerHTML = `<tr><th>Data</th><th>Operazione</th><th>Categoria</th><th>Conto</th><th>Importo</th><th></th></tr>`;
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                expenses.forEach(exp => {
                    tbody.appendChild(createExpenseRow(exp));
                });
                table.appendChild(tbody);

                // Tfoot with totals
                const tfoot = document.createElement('tfoot');
                tfoot.innerHTML = `
                    <tr>
                        <td colspan="4" class="tfoot-total-label">Totale Spese: <span class="tfoot-spese-val">— €</span></td>
                        <td colspan="2" class="tfoot-rimborso">
                            <label class="paid-label ${isPaid ? 'label-paid' : 'label-unpaid'}">
                                <input type="checkbox" class="paid-checkbox"
                                       data-month="${monthNum}" data-year="${year}"
                                       ${isPaid ? 'checked' : ''}>
                                <span class="tfoot-rimborso-label">${isPaid ? 'Rimborsato:' : 'Da Rimborsare:'}</span>
                                <span class="tfoot-rimborso-val">— €</span>
                            </label>
                        </td>
                    </tr>
                `;
                table.appendChild(tfoot);

                monthSection.appendChild(table);

                // '+ Aggiungi Spesa Manuale' button
                const addBtn = document.createElement('button');
                addBtn.className = 'add-expense-btn';
                addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Aggiungi Spesa Manuale';
                addBtn.addEventListener('click', () => showInlineForm(monthSection, tbody, year, monthNum));
                monthSection.appendChild(addBtn);

                container.appendChild(monthSection);

                // Calculate initial totals
                recalcMonthTotals(monthSection);
            });
        });
    }

    /**
     * Create a single expense row <tr> from a data object.
     */
    function createExpenseRow(exp) {
        const tr = document.createElement('tr');
        tr.className = 'expense-row';
        tr.dataset.id = exp.id;
        tr.dataset.importo = parseFloat(exp.importo); // raw value for recalc
        if (exp.is_excluded) tr.classList.add('excluded');
        if (exp.is_neutral) tr.classList.add('neutral-row');

        const dateDisplay = formatDateDisplay(exp.data_valuta);
        const importoFormatted = formatImporto(exp.importo);
        let importoClass;
        if (exp.is_neutral) {
            importoClass = 'importo-neutral';
        } else {
            importoClass = exp.importo >= 0 ? 'importo-positive' : 'importo-negative';
        }

        tr.innerHTML = `
            <td>${dateDisplay}</td>
            <td>${escapeHtml(exp.operazione)}</td>
            <td>${escapeHtml(exp.categoria || '—')}</td>
            <td>${escapeHtml(exp.conto_carta || '—')}</td>
            <td class="${importoClass}">${importoFormatted}</td>
            <td>
                <div class="action-btns">
                    <button class="eye-toggle" data-id="${exp.id}" title="${exp.is_excluded ? 'Includi nei calcoli' : 'Escludi dai calcoli'}">
                        <i class="fa-solid ${exp.is_excluded ? 'fa-eye-slash' : 'fa-eye'}"></i>
                    </button>
                    <button class="delete-btn" data-id="${exp.id}" title="Elimina spesa">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </td>
        `;
        return tr;
    }

    /**
     * Recalculate and display totals for a month section.
     * Totale Spese = sum of ALL rows (absolute values of negatives).
     * Rimborsabile = sum of non-excluded rows (absolute values of negatives).
     */
    function recalcMonthTotals(monthSection) {
        const rows = monthSection.querySelectorAll('.expense-row');
        let totalAll = 0;
        let totalReimbursable = 0;

        rows.forEach(row => {
            const val = parseFloat(row.dataset.importo) || 0;
            if (!row.classList.contains('neutral-row')) {
                totalAll += val;
            }
            if (!row.classList.contains('excluded') && !row.classList.contains('neutral-row')) {
                totalReimbursable += val;
            }
        });

        // Determine paid state from checkbox
        const checkbox = monthSection.querySelector('.paid-checkbox');
        const isPaid = checkbox ? checkbox.checked : false;

        // Update badge in month title
        const badge = monthSection.querySelector('.month-badge');
        if (badge) {
            badge.className = 'month-badge ' + (isPaid ? 'badge-paid' : 'badge-unpaid');
            badge.innerHTML = isPaid
                ? `<i class="fa-solid fa-sack-dollar"></i> Rimborsato: ${formatImporto(totalReimbursable)}`
                : `<i class="fa-solid fa-hand-holding-dollar"></i> Da Rimborsare: ${formatImporto(totalReimbursable)}`;
        }

        // Update tfoot
        const tfootSpese = monthSection.querySelector('.tfoot-spese-val');
        const tfootRimborso = monthSection.querySelector('.tfoot-rimborso-val');
        const tfootLabel = monthSection.querySelector('.tfoot-rimborso-label');
        const paidLabel = monthSection.querySelector('.paid-label');
        if (tfootSpese) tfootSpese.textContent = formatImporto(totalAll);
        if (tfootRimborso) tfootRimborso.textContent = formatImporto(totalReimbursable);
        if (tfootLabel) tfootLabel.textContent = isPaid ? 'Rimborsato:' : 'Da Rimborsare:';
        if (paidLabel) {
            paidLabel.classList.toggle('label-paid', isPaid);
            paidLabel.classList.toggle('label-unpaid', !isPaid);
        }
    }

    /**
     * Show the inline form to add a manual expense at the bottom of a month's tbody.
     */
    // ══════════════════════════════════════════════════
    // 8. SMART AUTOCOMPLETE — Unique values + Dropdown
    // ══════════════════════════════════════════════════
    let _lastExpenseData = null;   // set by renderExpenses

    /** Scan the loaded expense data and return sorted unique values for a given field. */
    function extractUniqueValues(field) {
        const vals = new Set();
        if (!_lastExpenseData) return [];
        Object.values(_lastExpenseData).forEach(months => {
            Object.values(months).forEach(expenses => {
                expenses.forEach(exp => {
                    const v = (exp[field] || '').trim();
                    if (v) vals.add(v);
                });
            });
        });
        return [...vals].sort((a, b) => a.localeCompare(b, 'it'));
    }

    /**
     * Attach a custom autocomplete dropdown to an <input>.
     * @param {HTMLInputElement} input
     * @param {string[]} items — the full list of suggestions
     */
    function attachAutocomplete(input, items) {
        let list = null;      // <ul> element
        let activeIdx = -1;   // keyboard-highlighted index

        function openDropdown(filter) {
            closeDropdown();
            const q = (filter || '').toLowerCase();
            const filtered = q
                ? items.filter(it => it.toLowerCase().includes(q))
                : items;
            if (filtered.length === 0) return;

            list = document.createElement('ul');
            list.className = 'autocomplete-list';

            filtered.forEach((item, idx) => {
                const li = document.createElement('li');
                if (q) {
                    const lower = item.toLowerCase();
                    const start = lower.indexOf(q);
                    if (start >= 0) {
                        li.innerHTML =
                            escapeHtml(item.substring(0, start)) +
                            '<mark>' + escapeHtml(item.substring(start, start + q.length)) + '</mark>' +
                            escapeHtml(item.substring(start + q.length));
                    } else {
                        li.textContent = item;
                    }
                } else {
                    li.textContent = item;
                }
                li.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    input.value = item;
                    closeDropdown();
                });
                list.appendChild(li);
            });

            activeIdx = -1;

            // Prevent blur when clicking ANYWHERE in the list (scrollbar, items, etc.)
            list.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });

            // Stop scroll propagation to body (prevent scroll chaining)
            list.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: false });

            // Portal pattern: append to body with fixed positioning
            document.body.appendChild(list);
            positionDropdown();
        }

        function positionDropdown() {
            if (!list) return;
            const rect = input.getBoundingClientRect();
            const listHeight = list.getBoundingClientRect().height;
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;

            if (spaceBelow < listHeight && spaceAbove > listHeight) {
                // Drop-up
                list.classList.add('drop-up');
                list.style.top = (rect.top - listHeight) + 'px';
            } else {
                // Drop-down
                list.classList.remove('drop-up');
                list.style.top = rect.bottom + 'px';
            }
            list.style.left = rect.left + 'px';
            list.style.width = rect.width + 'px';
        }

        function closeDropdown() {
            if (list) { list.remove(); list = null; activeIdx = -1; }
        }

        function setActive(newIdx) {
            if (!list) return;
            const lis = list.querySelectorAll('li');
            lis.forEach(li => li.classList.remove('ac-active'));
            activeIdx = Math.max(-1, Math.min(newIdx, lis.length - 1));
            if (activeIdx >= 0) {
                lis[activeIdx].classList.add('ac-active');
                lis[activeIdx].scrollIntoView({ block: 'nearest' });
            }
        }

        // Show full list on focus
        input.addEventListener('focus', () => openDropdown(input.value));

        // Filter while typing
        input.addEventListener('input', () => openDropdown(input.value));

        // Keyboard navigation
        input.addEventListener('keydown', (e) => {
            if (!list) return;
            const lis = list.querySelectorAll('li');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(activeIdx + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(activeIdx - 1);
            } else if (e.key === 'Enter' && activeIdx >= 0) {
                e.preventDefault();
                e.stopPropagation();
                input.value = lis[activeIdx].textContent;
                closeDropdown();
            } else if (e.key === 'Escape') {
                closeDropdown();
            }
        });

        // Close on blur (with delay to allow mousedown/scrollbar selection)
        input.addEventListener('blur', () => {
            setTimeout(() => closeDropdown(), 200);
        });

        // Close on scroll/resize to avoid floating ghosts
        // Close on scroll, BUT ignore scroll events that bubble from the list itself
        window.addEventListener('scroll', (e) => {
            // Fix: removed activeIdx check to support mouse scrolling without prior arrow usage
            if (list && (e.target === list || list.contains(e.target))) {
                return;
            }
            closeDropdown();
        }, true);
        window.addEventListener('resize', () => closeDropdown());
    }

    /** Minimal HTML escape for safe highlight injection. */
    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ══════════════════════════════════════════════════
    // 9. ELENCO — Inline Manual Expense Form
    // ══════════════════════════════════════════════════
    function showInlineForm(monthSection, tbody, year, monthNum) {
        // Hide the add button
        const addBtn = monthSection.querySelector('.add-expense-btn');
        if (addBtn) addBtn.style.display = 'none';

        // Remove any existing form row
        const existing = tbody.querySelector('.inline-form-row');
        if (existing) existing.remove();

        const defaultDate = `${year}-${String(monthNum).padStart(2, '0')}-01`;

        const tr = document.createElement('tr');
        tr.className = 'inline-form-row';
        tr.innerHTML = `
            <td><input type="date" class="form-data" value="${defaultDate}"></td>
            <td><input type="text" class="form-operazione" placeholder="Operazione"></td>
            <td><input type="text" class="form-categoria" placeholder="Categoria"></td>
            <td><input type="text" class="form-conto" placeholder="Conto"></td>
            <td><input type="text" class="form-importo" placeholder="-00,00"></td>
            <td>
                <div class="inline-form-actions">
                    <button class="btn-save-inline" title="Salva"><i class="fa-solid fa-check"></i></button>
                    <button class="btn-cancel-inline" title="Annulla"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);

        // Attach smart autocomplete to Categoria and Conto
        attachAutocomplete(tr.querySelector('.form-categoria'), extractUniqueValues('categoria'));
        attachAutocomplete(tr.querySelector('.form-conto'), extractUniqueValues('conto_carta'));

        // Focus on operazione field
        tr.querySelector('.form-operazione').focus();

        // Save handler
        tr.querySelector('.btn-save-inline').addEventListener('click', async () => {
            const data_valuta = tr.querySelector('.form-data').value;
            const operazione = tr.querySelector('.form-operazione').value.trim();
            const categoria = tr.querySelector('.form-categoria').value.trim();
            const conto_carta = tr.querySelector('.form-conto').value.trim();
            const importoRaw = tr.querySelector('.form-importo').value.trim();

            if (!operazione) {
                tr.querySelector('.form-operazione').style.borderColor = '#c0392b';
                return;
            }

            try {
                const res = await fetch('/expenses', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data_valuta, operazione, categoria, conto_carta, importo: importoRaw })
                });
                const result = await res.json();

                if (res.ok) {
                    // Remove form row, add expense row
                    tr.remove();
                    const newRow = createExpenseRow(result);
                    tbody.appendChild(newRow);
                    recalcMonthTotals(monthSection);
                    dashboardDirty = true;

                    // Restore add button
                    if (addBtn) addBtn.style.display = '';

                    showToast(elencoToast, '✓ Spesa aggiunta con successo.', 'success');
                } else {
                    showToast(elencoToast, `Errore: ${result.error}`, 'error');
                }
            } catch (err) {
                showToast(elencoToast, `Errore di rete: ${err.message}`, 'error');
            }
        });

        // Cancel handler
        tr.querySelector('.btn-cancel-inline').addEventListener('click', () => {
            tr.remove();
            if (addBtn) addBtn.style.display = '';
        });

        // Allow Enter key to save
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                tr.querySelector('.btn-save-inline').click();
            }
            if (e.key === 'Escape') {
                tr.querySelector('.btn-cancel-inline').click();
            }
        });
    }

    function createEmptyState() {
        const div = document.createElement('div');
        div.className = 'empty-state';
        div.innerHTML = `
            <i class="fa-solid fa-inbox"></i>
            <p>Nessuna spesa trovata.</p>
            <p class="empty-hint">Carica un file Excel dalla Dashboard per iniziare.</p>
        `;
        return div;
    }

    // ══════════════════════════════════════════════════
    // 7. ELENCO — Eye Toggle (Exclude/Include)
    // ══════════════════════════════════════════════════
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.eye-toggle');
        if (!btn) return;

        const id = btn.dataset.id;
        const row = btn.closest('.expense-row');

        try {
            const res = await fetch(`/expenses/${id}/toggle`, { method: 'PATCH' });
            const data = await res.json();
            if (res.ok) {
                if (data.is_excluded) {
                    row.classList.add('excluded');
                    btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
                    btn.title = 'Includi nei calcoli';
                } else {
                    row.classList.remove('excluded');
                    btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
                    btn.title = 'Escludi dai calcoli';
                }

                // Recalculate totals instantly
                const monthSection = row.closest('.month-section');
                if (monthSection) recalcMonthTotals(monthSection);

                // Mark dashboard as stale so it refreshes on navigation
                dashboardDirty = true;
            }
        } catch (err) {
            console.error('Errore toggle:', err);
        }
    });

    // ══════════════════════════════════════════════════
    // 7b. ELENCO — Paid Checkbox (Reimbursement Status)
    // ══════════════════════════════════════════════════
    document.addEventListener('change', async (e) => {
        const checkbox = e.target.closest('.paid-checkbox');
        if (!checkbox) return;

        const month = parseInt(checkbox.dataset.month);
        const year = parseInt(checkbox.dataset.year);
        const isPaid = checkbox.checked;

        try {
            await fetch('/monthly-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ month, year, is_paid: isPaid })
            });
            const monthSection = checkbox.closest('.month-section');
            if (monthSection) recalcMonthTotals(monthSection);
            dashboardDirty = true;
        } catch (err) {
            console.error('Errore status rimborso:', err);
            checkbox.checked = !isPaid;   // rollback on error
        }
    });

    // ══════════════════════════════════════════════════
    // 7c. ELENCO — Delete Expense Row
    // ══════════════════════════════════════════════════
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.delete-btn');
        if (!btn) return;

        const id = btn.dataset.id;
        // Removed confirmation as requested
        // if (!confirm('Eliminare questa voce?')) return;

        const row = btn.closest('.expense-row');
        try {
            const res = await fetch(`/expenses/${id}`, { method: 'DELETE' });
            if (res.ok) {
                const monthSection = row.closest('.month-section');

                // Fade-out animation
                row.classList.add('fade-out');
                row.addEventListener('transitionend', () => {
                    row.remove();
                    if (monthSection) recalcMonthTotals(monthSection);
                });

                dashboardDirty = true;
            }
        } catch (err) {
            console.error('Errore eliminazione:', err);
        }
    });

    // ══════════════════════════════════════════════════
    // 8. ELENCO — Real-Time Search Filter
    // ══════════════════════════════════════════════════
    const searchInput = document.getElementById('search-input');
    let searchTimeout = null;

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                filterRowsLocally(searchInput.value.trim().toLowerCase());
            }, 250);
        });
    }

    function filterRowsLocally(query) {
        const rows = document.querySelectorAll('#expenses-list .expense-row');
        const monthSections = document.querySelectorAll('#expenses-list .month-section');
        const yearHeaders = document.querySelectorAll('#expenses-list .year-header');

        if (!query) {
            rows.forEach(r => r.style.display = '');
            monthSections.forEach(s => s.style.display = '');
            yearHeaders.forEach(h => h.style.display = '');
            return;
        }

        rows.forEach(row => {
            row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
        });

        monthSections.forEach(section => {
            const visible = section.querySelectorAll('.expense-row:not([style*="display: none"])');
            section.style.display = visible.length > 0 ? '' : 'none';
        });

        yearHeaders.forEach(header => {
            let nextEl = header.nextElementSibling;
            let hasVisible = false;
            while (nextEl && !nextEl.classList.contains('year-header')) {
                if (nextEl.classList.contains('month-section') && nextEl.style.display !== 'none') {
                    hasVisible = true;
                    break;
                }
                nextEl = nextEl.nextElementSibling;
            }
            header.style.display = hasVisible ? '' : 'none';
        });
    }

    // ══════════════════════════════════════════════════
    // 9. ELENCO — Date Range Filter
    // ══════════════════════════════════════════════════
    const dateFilterBtn = document.getElementById('date-filter-btn');
    const datePopover = document.getElementById('date-popover');
    const applyDateBtn = document.getElementById('apply-date-filter');
    const clearDateBtn = document.getElementById('clear-date-filter');

    if (dateFilterBtn) {
        dateFilterBtn.addEventListener('click', () => {
            datePopover.classList.toggle('hidden');
            dateFilterBtn.classList.toggle('active');
        });
    }

    if (applyDateBtn) {
        applyDateBtn.addEventListener('click', () => {
            datePopover.classList.add('hidden');
            dateFilterBtn.classList.remove('active');
            loadExpenses();
        });
    }

    if (clearDateBtn) {
        clearDateBtn.addEventListener('click', () => {
            document.getElementById('date-start').value = '';
            document.getElementById('date-end').value = '';
            datePopover.classList.add('hidden');
            dateFilterBtn.classList.remove('active');
            loadExpenses();
        });
    }

    document.addEventListener('click', (e) => {
        if (datePopover && !datePopover.classList.contains('hidden')) {
            if (!datePopover.contains(e.target) && !dateFilterBtn.contains(e.target)) {
                datePopover.classList.add('hidden');
                dateFilterBtn.classList.remove('active');
            }
        }
    });

    // ══════════════════════════════════════════════════
    // 10. HELPER FUNCTIONS
    // ══════════════════════════════════════════════════
    function formatDateDisplay(isoDate) {
        if (!isoDate) return '—';
        const parts = isoDate.split('-');
        return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDate;
    }

    function formatImporto(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return '0,00 €';
        const formatted = Math.abs(num).toLocaleString('it-IT', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        });
        return (num < 0 ? '-' : '') + formatted + ' €';
    }

    function formatEuro(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return '— €';
        return Math.abs(num).toLocaleString('it-IT', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        }) + ' €';
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function showToast(element, message, type) {
        if (!element) return;
        element.textContent = message;
        element.className = `upload-toast ${type}`;
        setTimeout(() => element.classList.add('hidden'), 6000);
    }


    // ═══════════════════════════════════════════════════
    // KEBAB MENU + MODALS
    // ═══════════════════════════════════════════════════
    const MONTH_NAMES = {
        1: 'Gennaio', 2: 'Febbraio', 3: 'Marzo', 4: 'Aprile',
        5: 'Maggio', 6: 'Giugno', 7: 'Luglio', 8: 'Agosto',
        9: 'Settembre', 10: 'Ottobre', 11: 'Novembre', 12: 'Dicembre'
    };

    // ── Kebab toggle ──
    const kebabBtn = document.getElementById('kebab-btn');
    const kebabDropdown = document.getElementById('kebab-dropdown');
    if (kebabBtn && kebabDropdown) {
        kebabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            kebabDropdown.classList.toggle('hidden');
        });
        document.addEventListener('click', () => kebabDropdown.classList.add('hidden'));
    }

    // ── Modal helpers ──
    function openModal(id) {
        document.getElementById(id)?.classList.remove('hidden');
        kebabDropdown?.classList.add('hidden');
    }
    function closeModal(id) {
        document.getElementById(id)?.classList.add('hidden');
    }

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    });

    // ── Subtask 1.1: Bulk Delete Modal ──
    document.getElementById('kebab-bulk-delete')?.addEventListener('click', async () => {
        openModal('modal-bulk-delete');
        const tree = document.getElementById('bulk-delete-tree');
        tree.innerHTML = '<p class="modal-hint">Caricamento periodi…</p>';

        try {
            const res = await fetch('/available-periods');
            const data = await res.json();
            const periods = data.periods || [];

            // Group by year
            const byYear = {};
            periods.forEach(p => {
                if (!byYear[p.year]) byYear[p.year] = [];
                byYear[p.year].push(p.month);
            });

            tree.innerHTML = '';
            Object.keys(byYear).sort((a, b) => b - a).forEach(year => {
                const months = byYear[year].sort((a, b) => a - b);
                const yearDiv = document.createElement('div');
                yearDiv.className = 'period-year';

                const yearHeader = document.createElement('div');
                yearHeader.className = 'period-year-header';
                const yearCb = document.createElement('input');
                yearCb.type = 'checkbox';
                yearCb.className = 'paid-checkbox';
                yearCb.dataset.year = year;
                const yearLabel = document.createElement('label');
                yearLabel.textContent = year;
                yearHeader.appendChild(yearCb);
                yearHeader.appendChild(yearLabel);
                yearDiv.appendChild(yearHeader);

                const monthsDiv = document.createElement('div');
                monthsDiv.className = 'period-months';
                months.forEach(m => {
                    const mLabel = document.createElement('label');
                    mLabel.className = 'period-month-label';
                    const mCb = document.createElement('input');
                    mCb.type = 'checkbox';
                    mCb.className = 'paid-checkbox';
                    mCb.dataset.month = m;
                    mCb.dataset.year = year;
                    mLabel.appendChild(mCb);
                    mLabel.appendChild(document.createTextNode(MONTH_NAMES[m]));
                    monthsDiv.appendChild(mLabel);

                    mCb.addEventListener('change', updateBulkDeleteButton);
                });
                yearDiv.appendChild(monthsDiv);
                tree.appendChild(yearDiv);

                // Year checkbox cascades to months
                yearCb.addEventListener('change', () => {
                    monthsDiv.querySelectorAll('input[type=checkbox]').forEach(cb => {
                        cb.checked = yearCb.checked;
                    });
                    updateBulkDeleteButton();
                });

                // Month checkboxes update year checkbox
                monthsDiv.addEventListener('change', () => {
                    const all = monthsDiv.querySelectorAll('input[type=checkbox]');
                    const checked = monthsDiv.querySelectorAll('input[type=checkbox]:checked');
                    yearCb.checked = checked.length === all.length;
                    yearCb.indeterminate = checked.length > 0 && checked.length < all.length;
                });
            });
        } catch {
            tree.innerHTML = '<p class="modal-hint" style="color:#e74c3c">Errore nel caricamento dei periodi.</p>';
        }
    });

    function updateBulkDeleteButton() {
        const btn = document.getElementById('confirm-bulk-delete');
        const checked = document.querySelectorAll('#bulk-delete-tree input[type=checkbox][data-month]:checked');
        btn.disabled = checked.length === 0;
    }

    document.getElementById('close-bulk-delete')?.addEventListener('click', () => closeModal('modal-bulk-delete'));

    document.getElementById('confirm-bulk-delete')?.addEventListener('click', () => {
        const checked = document.querySelectorAll('#bulk-delete-tree input[type=checkbox][data-month]:checked');
        const periods = Array.from(checked).map(cb => ({
            month: parseInt(cb.dataset.month),
            year: parseInt(cb.dataset.year)
        }));

        // Show custom confirmation modal
        document.getElementById('confirm-delete-msg').textContent =
            `Eliminare definitivamente i dati di ${periods.length} mese/i? Questa azione non può essere annullata.`;
        openModal('modal-confirm-delete');

        // Wire up confirm/cancel (one-time handlers)
        const proceedBtn = document.getElementById('proceed-confirm-delete');
        const cancelBtn = document.getElementById('cancel-confirm-delete');

        function cleanup() {
            proceedBtn.removeEventListener('click', onProceed);
            cancelBtn.removeEventListener('click', onCancel);
        }

        async function onProceed() {
            cleanup();
            closeModal('modal-confirm-delete');
            try {
                const res = await fetch('/expenses/bulk-delete', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ periods })
                });
                const data = await res.json();
                closeModal('modal-bulk-delete');

                // Force reload to update UI and verify data is gone
                window.location.reload();
            } catch {
                showToast(document.getElementById('elenco-toast'), 'Errore durante l\'eliminazione.', 'error');
            }
        }

        function onCancel() {
            cleanup();
            closeModal('modal-confirm-delete');
        }

        proceedBtn.addEventListener('click', onProceed);
        cancelBtn.addEventListener('click', onCancel);
    });

    // ── Subtask 1.2: Keywords Modal ──
    document.getElementById('kebab-keywords')?.addEventListener('click', () => {
        openModal('modal-keywords');
        loadKeywords();
    });
    document.getElementById('close-keywords')?.addEventListener('click', () => closeModal('modal-keywords'));

    async function loadKeywords() {
        const listEl = document.getElementById('keyword-list');
        try {
            const res = await fetch('/neutral-keywords');
            const keywords = await res.json();
            if (keywords.length === 0) {
                listEl.innerHTML = '<span class="keyword-list-empty">Nessuna keyword configurata.</span>';
                return;
            }
            listEl.innerHTML = '';
            keywords.forEach(kw => {
                const tag = document.createElement('span');
                tag.className = 'keyword-tag';
                tag.textContent = kw.keyword;
                const removeBtn = document.createElement('button');
                removeBtn.className = 'keyword-remove';
                removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                removeBtn.title = 'Rimuovi keyword';
                removeBtn.addEventListener('click', async () => {
                    await fetch(`/neutral-keywords/${kw.id}`, { method: 'DELETE' });
                    loadKeywords();
                    loadExpenses(); // refresh to update neutral flags
                });
                tag.appendChild(removeBtn);
                listEl.appendChild(tag);
            });
        } catch {
            listEl.innerHTML = '<span class="keyword-list-empty">Errore nel caricamento.</span>';
        }
    }

    // ══════════════════════════════════════════════════
    // 8. HELPERS — Custom Alert
    // ══════════════════════════════════════════════════
    function showCustomAlert(message) {
        const modal = document.getElementById('modal-alert');
        const msgEl = document.getElementById('alert-msg');
        const closeBtn = document.getElementById('close-alert-btn');
        if (!modal || !msgEl || !closeBtn) {
            alert(message); // fallback
            return;
        }

        msgEl.textContent = message;
        modal.classList.remove('hidden');

        // One-time listener
        const closeHandler = () => {
            modal.classList.add('hidden');
            closeBtn.removeEventListener('click', closeHandler);
        };
        closeBtn.addEventListener('click', closeHandler);
    }

    document.getElementById('add-keyword-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('keyword-input');
        const tooltip = document.getElementById('keyword-error-tooltip');
        const keyword = input.value.trim();

        if (!keyword) return;

        // Helper to show tooltip
        const showTooltip = (msg) => {
            if (tooltip) {
                tooltip.textContent = msg;
                tooltip.classList.add('show-error');
                // Auto-dismiss
                setTimeout(() => {
                    tooltip.classList.remove('show-error');
                }, 3000);
            } else {
                showCustomAlert(msg); // fallback
            }
        };

        // Remove tooltip on typing
        input.addEventListener('input', () => {
            tooltip?.classList.remove('show-error');
        }, { once: true }); // listener auto-removes

        try {
            const res = await fetch('/neutral-keywords', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword })
            });
            if (res.ok) {
                input.value = '';
                loadKeywords();
                loadExpenses(); // refresh to update neutral flags
            } else {
                const err = await res.json();
                // Check if duplicate (or generic error)
                showTooltip(err.error || 'Errore');
            }
        } catch {
            showTooltip('Errore di rete.');
        }
    });

    // Allow Enter to add keyword
    document.getElementById('keyword-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('add-keyword-btn')?.click();
        }
    });

});
