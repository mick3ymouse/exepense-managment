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

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetPage = item.dataset.page;

            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            pages.forEach(p => p.classList.remove('active'));
            const page = document.getElementById(`page-${targetPage}`);
            if (page) page.classList.add('active');

            if (targetPage === 'elenco') loadExpenses();

            // Auto-refresh stale data when navigating to Dashboard (or future pages)
            if (targetPage === 'dashboard' && dashboardDirty) {
                dashboardDirty = false;
                loadDashboardStats(currentYear, currentMonth);
            }
        });
    });

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
            const res = await fetch(`/expenses?${params.toString()}`);
            const data = await res.json();
            renderExpenses(data);
        } catch (err) {
            console.error('Errore caricamento spese:', err);
        }
    }

    function renderExpenses(data) {
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
                const monthSection = document.createElement('div');
                monthSection.className = 'month-section';

                const monthTitle = document.createElement('h3');
                monthTitle.className = 'month-title';
                monthTitle.textContent = month;
                monthSection.appendChild(monthTitle);

                const table = document.createElement('table');
                table.className = 'expense-table';

                const thead = document.createElement('thead');
                thead.innerHTML = `<tr><th>Data</th><th>Operazione</th><th>Categoria</th><th>Conto</th><th>Importo</th><th></th></tr>`;
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                expenses.forEach(exp => {
                    const tr = document.createElement('tr');
                    tr.className = 'expense-row';
                    tr.dataset.id = exp.id;
                    if (exp.is_excluded) tr.classList.add('excluded');

                    const dateDisplay = formatDateDisplay(exp.data_valuta);
                    const importoFormatted = formatImporto(exp.importo);
                    const importoClass = exp.importo >= 0 ? 'importo-positive' : 'importo-negative';

                    tr.innerHTML = `
                        <td>${dateDisplay}</td>
                        <td>${escapeHtml(exp.operazione)}</td>
                        <td>${escapeHtml(exp.categoria || '—')}</td>
                        <td>${escapeHtml(exp.conto_carta || '—')}</td>
                        <td class="${importoClass}">${importoFormatted}</td>
                        <td>
                            <button class="eye-toggle" data-id="${exp.id}" title="${exp.is_excluded ? 'Includi nei calcoli' : 'Escludi dai calcoli'}">
                                <i class="fa-solid ${exp.is_excluded ? 'fa-eye-slash' : 'fa-eye'}"></i>
                            </button>
                        </td>
                    `;
                    tbody.appendChild(tr);
                });

                table.appendChild(tbody);
                monthSection.appendChild(table);
                container.appendChild(monthSection);
            });
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

                // Mark dashboard as stale so it refreshes on navigation
                dashboardDirty = true;
            }
        } catch (err) {
            console.error('Errore toggle:', err);
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

});
