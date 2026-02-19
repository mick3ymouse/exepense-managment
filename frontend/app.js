/**
 * Expense Management App — Frontend Logic
 * Refactored & Modularized
 * ─────────────────────────────────────────
 * Modules:
 * - Utils: Formatting, helpers
 * - API: Backend communication
 * - UI: DOM manipulation, rendering
 * - Bonifici: Dashboard reimbursement table with year navigation
 * - App: State management, event listeners, initialization
 */

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

/* ══════════════════════════════════════════════════
   1. UTILITIES
   ══════════════════════════════════════════════════ */
const Utils = {
    MONTH_NAMES: {
        1: 'Gennaio', 2: 'Febbraio', 3: 'Marzo', 4: 'Aprile',
        5: 'Maggio', 6: 'Giugno', 7: 'Luglio', 8: 'Agosto',
        9: 'Settembre', 10: 'Ottobre', 11: 'Novembre', 12: 'Dicembre'
    },

    /** Format Date: YYYY-MM-DD -> DD/MM/YYYY */
    formatDateDisplay(isoDate) {
        if (!isoDate) return '—';
        const parts = isoDate.split('-');
        return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDate;
    },

    /** Format Currency with +/- sign if needed */
    formatImporto(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return '0,00 €';
        const formatted = Math.abs(num).toLocaleString('it-IT', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        });
        return (num < 0 ? '-' : '') + formatted + ' €';
    },

    /** Format Currency absolute value */
    formatEuro(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return '—\u00a0€';
        return Math.abs(num).toLocaleString('it-IT', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        }) + '\u00a0€';
    },

    /**
     * Format a raw float value as an Italian decimal string for display in input fields.
     * e.g. -10.3 → "-10,30", 1200.5 → "1200,50"
     */
    formatImportoForInput(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return '';
        return num.toFixed(2).replace('.', ',');
    },

    /**
     * Parse an importo string typed by the user into a numeric string
     * safe to send to the backend (dot as decimal separator, no thousands).
     */
    parseImportoInput(raw) {
        if (!raw) return null;
        let s = raw.trim().replace(/[€$£\s]/g, '');

        const hasDot = s.includes('.');
        const hasComma = s.includes(',');

        if (hasDot && hasComma) {
            s = s.replace(/\./g, '').replace(',', '.');
        } else if (hasComma && !hasDot) {
            s = s.replace(',', '.');
        }

        const num = parseFloat(s);
        return isNaN(num) ? null : String(num);
    },

    /** Safe HTML escaping */
    escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    /** Show temporary toast notification */
    showToast(element, message, type = 'success') {
        if (!element) return;
        element.textContent = message;
        element.className = `upload-toast ${type}`;
        setTimeout(() => element.classList.add('hidden'), 3000);
    },

    /** Extract unique values from data for autocomplete */
    extractUniqueValues(data, field) {
        const vals = new Set();
        if (!data) return [];
        Object.values(data).forEach(months => {
            Object.values(months).forEach(expenses => {
                expenses.forEach(exp => {
                    const v = (exp[field] || '').trim();
                    if (v) vals.add(v);
                });
            });
        });
        return [...vals].sort((a, b) => a.localeCompare(b, 'it'));
    }
};

/* ══════════════════════════════════════════════════
   2. API HANDLING
   ══════════════════════════════════════════════════ */
const API = {
    async fetchJSON(url, options = {}) {
        try {
            const res = await fetch(url, options);
            const data = await res.json();
            if (!res.ok) {
                console.error(`API ${options.method || 'GET'} ${url} failed [${res.status}]:`, data);
            }
            return { ok: res.ok, status: res.status, data };
        } catch (err) {
            console.error(`API Error (${url}):`, err);
            return { ok: false, error: err.message };
        }
    },

    /** Extract a human-readable error message from any API response */
    extractError(res) {
        if (!res) return 'Errore sconosciuto';
        if (res.data?.error) return res.data.error;
        if (res.data?.detail) {
            if (typeof res.data.detail === 'string') return res.data.detail;
            if (Array.isArray(res.data.detail)) {
                return res.data.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
            }
        }
        return res.error || 'Errore sconosciuto';
    },

    async getAvailablePeriods() {
        return this.fetchJSON('/available-periods');
    },

    async getDashboardStats(year, month) {
        return this.fetchJSON(`/dashboard-stats?year=${year}&month=${month}`);
    },

    async uploadFiles(files) {
        let totalNew = 0, totalDup = 0, totalErr = 0;
        let lastError = '';

        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            const res = await this.fetchJSON('/upload', { method: 'POST', body: formData });
            if (res.ok) {
                totalNew += res.data.new || 0;
                totalDup += res.data.duplicates || 0;
                totalErr += res.data.errors || 0;
            } else {
                lastError = res.data?.error || res.error;
            }
        }
        return { totalNew, totalDup, totalErr, lastError };
    },

    async getExpenses(params) {
        const qs = new URLSearchParams(params).toString();
        return this.fetchJSON(`/expenses?${qs}`);
    },

    async getMonthlyStatus() {
        return this.fetchJSON('/monthly-status');
    },

    async setMonthlyStatus(year, month, isPaid) {
        return this.fetchJSON('/monthly-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year, month, is_paid: isPaid })
        });
    },

    async addExpense(expenseData) {
        return this.fetchJSON('/expenses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(expenseData)
        });
    },

    async updateExpense(id, expenseData) {
        return this.fetchJSON(`/expenses/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(expenseData)
        });
    },

    async deleteExpense(id) {
        return this.fetchJSON(`/expenses/${id}`, { method: 'DELETE' });
    },

    async toggleExclude(id) {
        return this.fetchJSON(`/expenses/${id}/toggle`, { method: 'PATCH' });
    },

    async bulkDelete(periods) {
        return this.fetchJSON('/expenses/bulk-delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ periods })
        });
    },

    async getKeywords() {
        return this.fetchJSON('/neutral-keywords');
    },

    async addKeyword(keyword) {
        return this.fetchJSON('/neutral-keywords', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword })
        });
    },

    async removeKeyword(id) {
        return this.fetchJSON(`/neutral-keywords/${id}`, { method: 'DELETE' });
    }
};

/* ══════════════════════════════════════════════════
   3. UI RENDERING
   ══════════════════════════════════════════════════ */
const UI = {
    elements: {},

    cacheElements() {
        this.elements = {
            navItems: document.querySelectorAll('.nav-item[data-page]'),
            pages: document.querySelectorAll('.page'),

            // Dashboard
            yearFilter: document.getElementById('year-filter'),
            monthFilter: document.getElementById('month-filter'),
            panoramicaChartCtx: document.getElementById('panoramicaChart'),
            metricEntrate: document.getElementById('metric-entrate'),
            metricUscite: document.getElementById('metric-uscite'),
            metricSaldo: document.getElementById('metric-saldo'),
            topCatsContainer: document.getElementById('top-categories-container'),
            dropArea: document.getElementById('drop-area'),
            fileInput: document.getElementById('fileElem'),
            uploadBtn: document.getElementById('upload-btn'),
            uploadToast: document.getElementById('upload-toast'),

            // Elenco
            expensesList: document.getElementById('expenses-list'),
            searchInput: document.getElementById('search-input'),
            elencoExportBtn: document.getElementById('elenco-import-btn'),
            elencoFileInput: document.getElementById('elenco-file-input'),
            elencoToast: document.getElementById('elenco-toast'),
            dateFilterBtn: document.getElementById('date-filter-btn'),
            datePopover: document.getElementById('date-popover'),
            dateStart: document.getElementById('date-start'),
            dateEnd: document.getElementById('date-end'),
            applyDateBtn: document.getElementById('apply-date-filter'),
            clearDateBtn: document.getElementById('clear-date-filter'),

            // Modals
            kebabBtn: document.getElementById('kebab-btn'),
            kebabDropdown: document.getElementById('kebab-dropdown'),
            modalOverlays: document.querySelectorAll('.modal-overlay'),

            // Keywords
            keywordInput: document.getElementById('keyword-input'),
            keywordList: document.getElementById('keyword-list'),
            addKeywordBtn: document.getElementById('add-keyword-btn'),

            // Bonifici
            bonificiYearLabel: document.getElementById('bonifici-year-label'),
            bonificiYearPrev: document.getElementById('bonifici-year-prev'),
            bonificiYearNext: document.getElementById('bonifici-year-next'),
            bonificiTbody: document.getElementById('bonifici-tbody'),
            bonificiTfootTotal: document.getElementById('bonifici-tfoot-total')
        };
    },

    openModal(id) {
        document.getElementById(id)?.classList.remove('hidden');
        this.elements.kebabDropdown?.classList.add('hidden');
    },

    renderDashboardStats(data) {
        if (this.elements.metricEntrate) this.elements.metricEntrate.textContent = Utils.formatEuro(data.entrate);
        if (this.elements.metricUscite) this.elements.metricUscite.textContent = Utils.formatEuro(data.uscite);
        if (this.elements.metricSaldo) {
            const saldo = parseFloat(data.saldo);
            const sign = saldo >= 0 ? '+' : '−';
            this.elements.metricSaldo.textContent = sign + '\u00a0' + Utils.formatEuro(saldo);
            this.elements.metricSaldo.className = 'metric-value ' + (saldo >= 0 ? 'saldo-positive' : 'saldo-negative');
        }
        this.renderChart(data);
        this.renderTopCategories(data.top_categories || []);
    },

    chartInstance: null,
    renderChart(data) {
        if (!this.elements.panoramicaChartCtx) return;

        if (this.chartInstance) {
            this.chartInstance.data.datasets[0].data = [data.entrate, data.uscite];
            this.chartInstance.update();
            return;
        }

        this.chartInstance = new Chart(this.elements.panoramicaChartCtx.getContext('2d'), {
            type: 'bar',
            data: {
                labels: ['Entrate', 'Uscite'],
                datasets: [{
                    label: 'EUR',
                    data: [data.entrate, data.uscite],
                    backgroundColor: ['rgba(39, 174, 96, 0.65)', 'rgba(255, 107, 107, 0.60)'],
                    hoverBackgroundColor: ['rgba(39, 174, 96, 0.85)', 'rgba(255, 107, 107, 0.80)'],
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
                        ticks: { color: '#003B46', font: { family: 'Inter', weight: '500' } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#003B46', font: { family: 'Inter', weight: '600' } }
                    }
                }
            }
        });
    },

    renderTopCategories(categories) {
        const container = this.elements.topCatsContainer;
        if (!container) return;

        if (categories.length === 0) {
            container.innerHTML = '<p class="top-cat-empty" style="color: var(--primary-color); text-align: center; padding: 20px; font-weight: 500;">Nessuna spesa per questo mese.</p>';
            return;
        }

        const maxAmount = categories[0].totale;
        const medals = ['🥇', '🥈', '🥉'];

        let html = '<ul class="top-cat-list">';
        categories.forEach((cat, i) => {
            const pct = maxAmount > 0 ? (cat.totale / maxAmount) * 100 : 0;
            html += `
                <li class="top-cat-item">
                    <div class="top-cat-info">
                        <span class="top-cat-rank">${medals[i] || (i + 1)}</span>
                        <span class="top-cat-name">${Utils.escapeHtml(cat.categoria)}</span>
                        <span class="top-cat-amount">${Utils.formatEuro(cat.totale)}</span>
                    </div>
                    <div class="top-cat-bar-track">
                        <div class="top-cat-bar-fill" style="width: ${pct}%"></div>
                    </div>
                </li>`;
        });
        html += '</ul>';
        container.innerHTML = html;
    },

    renderExpenses(data, statusMap) {
        const container = this.elements.expensesList;
        if (!container) return;
        container.innerHTML = '';

        const years = Object.keys(data).sort((a, b) => b - a);
        if (years.length === 0) {
            container.appendChild(this.createEmptyState());
            return;
        }

        const MONTH_ORDER = {};
        Object.entries(Utils.MONTH_NAMES).forEach(([num, name]) => MONTH_ORDER[name] = parseInt(num));

        years.forEach(year => {
            const yearHeader = document.createElement('h2');
            yearHeader.className = 'year-header';
            yearHeader.textContent = `Anno ${year}`;
            container.appendChild(yearHeader);

            const yearSeparator = document.createElement('div');
            yearSeparator.className = 'year-separator';
            container.appendChild(yearSeparator);

            const months = data[year];
            const sortedMonths = Object.keys(months).sort((a, b) => (MONTH_ORDER[b] || 0) - (MONTH_ORDER[a] || 0));

            sortedMonths.forEach(month => {
                const expenses = months[month];
                const monthNum = MONTH_ORDER[month] || 1;
                const statusKey = `${year}-${String(monthNum).padStart(2, '0')}`;
                const isPaid = !!statusMap[statusKey];

                const section = this.createMonthSection(year, monthNum, month, expenses, isPaid);
                container.appendChild(section);
                this.recalcMonthTotals(section);
            });
        });
    },

    createMonthSection(year, monthNum, monthName, expenses, isPaid) {
        const section = document.createElement('div');
        section.className = 'month-section';
        section.dataset.year = year;
        section.dataset.month = monthNum;

        const headerFlex = document.createElement('div');
        headerFlex.style.cssText = 'display:flex; justify-content:flex-start; align-items:center; margin-bottom:1rem; gap:20px;';

        const title = document.createElement('h3');
        title.className = 'month-title-rounded';
        title.textContent = monthName;

        const badge = document.createElement('span');
        this.updateBadge(badge, isPaid, 0);

        headerFlex.appendChild(title);
        headerFlex.appendChild(badge);
        section.appendChild(headerFlex);

        const table = document.createElement('table');
        table.className = 'expense-table';
        table.innerHTML = `
            <colgroup>
                <col class="col-data"><col class="col-operazione"><col class="col-categoria"><col class="col-conto"><col class="col-importo"><col class="col-azioni">
            </colgroup>
            <thead><tr><th>Data</th><th>Operazione</th><th>Categoria</th><th>Conto</th><th>Importo</th><th></th></tr></thead>
            <tbody></tbody>
            <tfoot>
                <tr>
                    <td colspan="4" class="tfoot-total-label">Totale Spese: <span class="tfoot-spese-val">— €</span></td>
                    <td colspan="2" class="tfoot-rimborso">
                        <label class="paid-label ${isPaid ? 'label-paid' : 'label-unpaid'}">
                            <input type="checkbox" class="paid-checkbox" data-month="${monthNum}" data-year="${year}" ${isPaid ? 'checked' : ''}>
                            <span class="tfoot-rimborso-label">${isPaid ? 'Rimborsato:' : 'Da Rimborsare:'}</span>
                            <span class="tfoot-rimborso-val">— €</span>
                        </label>
                    </td>
                </tr>
            </tfoot>
        `;

        const tbody = table.querySelector('tbody');
        expenses.forEach(exp => tbody.appendChild(this.createExpenseRow(exp)));
        section.appendChild(table);

        const addBtn = document.createElement('button');
        addBtn.className = 'add-expense-btn';
        addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Aggiungi Spesa';
        addBtn.addEventListener('click', () => this.showInlineForm(section, tbody, year, monthNum));
        section.appendChild(addBtn);

        return section;
    },

    updateBadge(badgeEl, isPaid, amount) {
        badgeEl.className = 'month-badge ' + (isPaid ? 'badge-paid' : 'badge-unpaid');
        badgeEl.innerHTML = isPaid
            ? `<i class="fa-solid fa-sack-dollar"></i> Rimborsato: ${Utils.formatImporto(amount)}`
            : `<i class="fa-solid fa-hand-holding-dollar"></i> Da Rimborsare: ${Utils.formatImporto(amount)}`;
    },

    showErrorTooltip(element, message) {
        const existing = element.parentNode.querySelector('.error-tooltip');
        if (existing) existing.remove();

        const tooltip = document.createElement('div');
        tooltip.className = 'error-tooltip';
        tooltip.textContent = message;

        if (getComputedStyle(element.parentNode).position === 'static') {
            element.parentNode.style.position = 'relative';
        }

        element.parentNode.appendChild(tooltip);
        element.style.borderColor = '#e74c3c';

        requestAnimationFrame(() => tooltip.classList.add('show-error'));

        const removeTooltip = () => {
            tooltip.classList.remove('show-error');
            element.style.borderColor = '';
            setTimeout(() => { if (tooltip.parentNode) tooltip.remove(); }, 300);
            element.removeEventListener('input', removeTooltip);
        };
        element.addEventListener('input', removeTooltip);
        setTimeout(() => { if (tooltip.parentNode) removeTooltip(); }, 3000);
    },

    createExpenseRow(exp) {
        const tr = document.createElement('tr');
        tr.className = 'expense-row';
        tr.dataset.id = exp.id;
        tr.dataset.date = exp.data_valuta;
        tr.dataset.importo = parseFloat(exp.importo);
        if (exp.is_excluded) tr.classList.add('excluded');
        if (exp.is_neutral) tr.classList.add('neutral-row');

        const importoClass = exp.is_neutral ? 'importo-neutral' : (exp.importo >= 0 ? 'importo-positive' : 'importo-negative');

        tr.innerHTML = `
            <td>${Utils.formatDateDisplay(exp.data_valuta)}</td>
            <td>${Utils.escapeHtml(exp.operazione)}</td>
            <td>${Utils.escapeHtml(exp.categoria || '—')}</td>
            <td>${Utils.escapeHtml(exp.conto_carta || '—')}</td>
            <td class="${importoClass}">${Utils.formatImporto(exp.importo)}</td>
            <td>
                <div class="action-btns">
                    <button class="eye-toggle" data-id="${exp.id}" title="${exp.is_excluded ? 'Includi' : 'Escludi'}">
                        <i class="fa-solid ${exp.is_excluded ? 'fa-eye-slash' : 'fa-eye'}"></i>
                    </button>
                    <button class="edit-btn" data-id="${exp.id}" title="Modifica">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="delete-btn" data-id="${exp.id}" title="Elimina">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </td>
        `;
        return tr;
    },

    recalcMonthTotals(monthSection) {
        const rows = monthSection.querySelectorAll('.expense-row');
        let totalAll = 0, totalReimbursable = 0;

        rows.forEach(row => {
            const val = parseFloat(row.dataset.importo) || 0;
            if (!row.classList.contains('neutral-row')) totalAll += val;
            if (!row.classList.contains('excluded') && !row.classList.contains('neutral-row')) totalReimbursable += val;
        });

        const isPaid = monthSection.querySelector('.paid-checkbox')?.checked || false;

        const badge = monthSection.querySelector('.month-badge');
        if (badge) this.updateBadge(badge, isPaid, totalReimbursable);

        const tfootSpese = monthSection.querySelector('.tfoot-spese-val');
        const tfootRimborso = monthSection.querySelector('.tfoot-rimborso-val');
        const tfootLabel = monthSection.querySelector('.tfoot-rimborso-label');
        const paidLabel = monthSection.querySelector('.paid-label');

        if (tfootSpese) tfootSpese.textContent = Utils.formatImporto(totalAll);
        if (tfootRimborso) tfootRimborso.textContent = Utils.formatImporto(totalReimbursable);
        if (tfootLabel) tfootLabel.textContent = isPaid ? 'Rimborsato:' : 'Da Rimborsare:';
        if (paidLabel) {
            paidLabel.classList.toggle('label-paid', isPaid);
            paidLabel.classList.toggle('label-unpaid', !isPaid);
        }
    },

    createEmptyState() {
        const div = document.createElement('div');
        div.className = 'empty-state';
        div.innerHTML = `
            <i class="fa-solid fa-inbox"></i>
            <p>Nessuna spesa trovata.</p>
            <p class="empty-hint">Carica un file Excel dalla Dashboard per iniziare.</p>
        `;
        return div;
    },

    /** Shared importo validation for inline forms */
    validateImportoField(importoInput) {
        const impVal = Utils.parseImportoInput(importoInput.value);
        if (impVal === null) {
            this.showErrorTooltip(importoInput, 'Inserisci importo valido (es. -10,50)');
            return null;
        }
        return impVal;
    },

    showInlineForm(monthSection, tbody, year, monthNum) {
        monthSection.querySelector('.add-expense-btn').style.display = 'none';
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
            <td><input type="text" class="form-importo" placeholder="Importo"></td>
            <td>
                <div class="inline-form-actions">
                    <button class="btn-save-inline" title="Salva"><i class="fa-solid fa-check"></i></button>
                    <button class="btn-cancel-inline" title="Annulla"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);

        const uniqueCats = Utils.extractUniqueValues(App.state.lastExpenseData, 'categoria');
        const uniqueAccs = Utils.extractUniqueValues(App.state.lastExpenseData, 'conto_carta');
        UI.attachAutocomplete(tr.querySelector('.form-categoria'), uniqueCats);
        UI.attachAutocomplete(tr.querySelector('.form-conto'), uniqueAccs);

        tr.querySelector('.form-operazione').focus();

        const saveForm = async () => {
            const dataInput = tr.querySelector('.form-data');
            const operazioneInput = tr.querySelector('.form-operazione');
            const categoriaInput = tr.querySelector('.form-categoria');
            const contoInput = tr.querySelector('.form-conto');
            const importoInput = tr.querySelector('.form-importo');

            if (!dataInput.value) {
                UI.showErrorTooltip(dataInput, 'Inserisci una data!');
                return;
            }
            const [y, m] = dataInput.value.split('-').map(Number);
            if (y !== Number(year) || m !== Number(monthNum)) {
                const monthName = Utils.MONTH_NAMES[Number(monthNum)] || monthNum;
                UI.showErrorTooltip(dataInput, `La data deve essere in ${monthName} ${year}!`);
                return;
            }

            let isValid = true;
            if (!operazioneInput.value.trim()) {
                UI.showErrorTooltip(operazioneInput, 'Campo obbligatorio!'); isValid = false;
            }
            if (!categoriaInput.value.trim()) {
                UI.showErrorTooltip(categoriaInput, 'Categoria obbligatoria!'); isValid = false;
            }
            if (!contoInput.value.trim()) {
                UI.showErrorTooltip(contoInput, 'Conto obbligatorio!'); isValid = false;
            }

            const impVal = UI.validateImportoField(importoInput);
            if (impVal === null) isValid = false;

            if (!isValid) return;

            const res = await API.addExpense({
                data_valuta: dataInput.value,
                operazione: operazioneInput.value.trim(),
                categoria: categoriaInput.value.trim(),
                conto_carta: contoInput.value.trim(),
                importo: impVal
            });

            if (res.ok) {
                App.state.dashboardDirty = true;
                Utils.showToast(UI.elements.elencoToast, '✓ Spesa aggiunta!', 'success');
                if (document.getElementById('page-elenco').classList.contains('active')) {
                    await App.loadElenco();
                }
            } else {
                const errMsg = API.extractError(res);
                Utils.showToast(UI.elements.elencoToast, `Errore: ${errMsg}`, 'error');
            }
        };

        const cancelForm = () => {
            tr.remove();
            monthSection.querySelector('.add-expense-btn').style.display = '';
        };

        tr.querySelector('.btn-save-inline').addEventListener('click', saveForm);
        tr.querySelector('.btn-cancel-inline').addEventListener('click', cancelForm);
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveForm(); }
            if (e.key === 'Escape') cancelForm();
        });
    },

    showInlineEditForm(row) {
        if (row.nextElementSibling?.classList.contains('inline-edit-row')) return;

        const id = row.dataset.id;
        const rawDate = row.dataset.date;
        const rawImp = row.dataset.importo;
        const cells = row.querySelectorAll('td');

        row.style.display = 'none';

        const tr = document.createElement('tr');
        tr.className = 'inline-form-row inline-edit-row';
        tr.dataset.editingId = id;
        tr.innerHTML = `
            <td><input type="date" class="form-data" value="${rawDate}"></td>
            <td><input type="text" class="form-operazione" value="${Utils.escapeHtml(cells[1].textContent.trim() === '—' ? '' : cells[1].textContent.trim())}"></td>
            <td><input type="text" class="form-categoria" value="${Utils.escapeHtml(cells[2].textContent.trim() === '—' ? '' : cells[2].textContent.trim())}"></td>
            <td><input type="text" class="form-conto" value="${Utils.escapeHtml(cells[3].textContent.trim() === '—' ? '' : cells[3].textContent.trim())}"></td>
            <td><input type="text" class="form-importo" value="${Utils.formatImportoForInput(rawImp)}"></td>
            <td>
                <div class="inline-form-actions">
                    <button class="btn-save-inline" title="Salva"><i class="fa-solid fa-check"></i></button>
                    <button class="btn-cancel-inline" title="Annulla"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </td>
        `;
        row.insertAdjacentElement('afterend', tr);

        const uniqueCats = Utils.extractUniqueValues(App.state.lastExpenseData, 'categoria');
        const uniqueAccs = Utils.extractUniqueValues(App.state.lastExpenseData, 'conto_carta');
        UI.attachAutocomplete(tr.querySelector('.form-categoria'), uniqueCats);
        UI.attachAutocomplete(tr.querySelector('.form-conto'), uniqueAccs);

        tr.querySelector('.form-operazione').focus();

        const cancelEdit = () => {
            tr.remove();
            row.style.display = '';
        };

        const saveEdit = async () => {
            const dataInput = tr.querySelector('.form-data');
            const operazioneInput = tr.querySelector('.form-operazione');
            const categoriaInput = tr.querySelector('.form-categoria');
            const contoInput = tr.querySelector('.form-conto');
            const importoInput = tr.querySelector('.form-importo');

            let isValid = true;
            if (!dataInput.value) {
                UI.showErrorTooltip(dataInput, 'Inserisci una data!'); isValid = false;
            }
            if (!operazioneInput.value.trim()) {
                UI.showErrorTooltip(operazioneInput, 'Campo obbligatorio!'); isValid = false;
            }

            const impVal = UI.validateImportoField(importoInput);
            if (impVal === null) isValid = false;

            if (!isValid) return;

            const res = await API.updateExpense(id, {
                data_valuta: dataInput.value,
                operazione: operazioneInput.value.trim(),
                categoria: categoriaInput.value.trim(),
                conto_carta: contoInput.value.trim(),
                importo: impVal
            });

            if (res.ok) {
                App.state.dashboardDirty = true;
                Utils.showToast(UI.elements.elencoToast, '✓ Spesa aggiornata!', 'success');
                await App.loadElenco();
            } else {
                const errMsg = API.extractError(res);
                Utils.showToast(UI.elements.elencoToast, `Errore: ${errMsg}`, 'error');
                cancelEdit();
            }
        };

        tr.querySelector('.btn-save-inline').addEventListener('click', saveEdit);
        tr.querySelector('.btn-cancel-inline').addEventListener('click', cancelEdit);
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
            if (e.key === 'Escape') cancelEdit();
        });
    },

    attachAutocomplete(input, items) {
        if (!input || !items.length) return;
        let list = null, activeIdx = -1;

        const close = () => {
            if (list) { list.remove(); list = null; activeIdx = -1; }
        };

        const setActive = (idx) => {
            if (!list) return;
            const lis = list.querySelectorAll('li');
            lis.forEach(li => li.classList.remove('ac-active'));
            activeIdx = Math.max(-1, Math.min(idx, lis.length - 1));
            if (activeIdx >= 0) {
                lis[activeIdx].classList.add('ac-active');
                lis[activeIdx].scrollIntoView({ block: 'nearest' });
            }
        };

        const open = (filter) => {
            close();
            const q = (filter || '').toLowerCase();
            const filtered = q ? items.filter(it => it.toLowerCase().includes(q)) : items;
            if (!filtered.length) return;

            list = document.createElement('ul');
            list.className = 'autocomplete-list';
            filtered.forEach(item => {
                const li = document.createElement('li');
                if (q) {
                    const start = item.toLowerCase().indexOf(q);
                    if (start >= 0) {
                        li.innerHTML = Utils.escapeHtml(item.substring(0, start)) +
                            '<mark>' + Utils.escapeHtml(item.substring(start, start + q.length)) + '</mark>' +
                            Utils.escapeHtml(item.substring(start + q.length));
                    } else li.textContent = item;
                } else li.textContent = item;

                li.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    input.value = item;
                    close();
                });
                list.appendChild(li);
            });
            document.body.appendChild(list);

            const rect = input.getBoundingClientRect();
            list.style.left = rect.left + 'px';
            list.style.width = rect.width + 'px';
            list.style.top = rect.bottom + 'px';

            if (window.innerHeight - rect.bottom < 160) {
                list.classList.add('drop-up');
                list.style.top = (rect.top - list.offsetHeight) + 'px';
            }
        };

        input.addEventListener('focus', () => open(input.value));
        input.addEventListener('input', () => open(input.value));
        input.addEventListener('blur', () => setTimeout(close, 200));
        input.addEventListener('keydown', (e) => {
            if (!list) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
            else if (e.key === 'Enter' && activeIdx >= 0) {
                e.preventDefault();
                input.value = list.querySelectorAll('li')[activeIdx].textContent;
                close();
            } else if (e.key === 'Escape') close();
        });
    }
};

/* ══════════════════════════════════════════════════
   3b. BONIFICI MODULE
   Manages the Dashboard "Gestione Bonifici" card:
   - Year navigation
   - Populating the table from /expenses + /monthly-status
   - Bidirectional sync with Elenco checkboxes
   ══════════════════════════════════════════════════ */
const Bonifici = {
    /** The year currently displayed in the card */
    currentYear: null,
    /** Sorted list of available years across all data */
    availableYears: [],
    /** Cache: { "YYYY-MM": reimbursableAmount } computed from expenses data */
    monthlyAmounts: {},
    /** Cache: { "YYYY-MM": isPaid } from monthly-status */
    statusMap: {},

    /**
     * Initialize with the available years array.
     * Called once after periods are fetched.
     */
    init(years) {
        this.availableYears = [...years].sort((a, b) => b - a);
        this.currentYear = this.availableYears[0] || new Date().getFullYear();
        this.updateYearLabel();
        this.updateNavButtons();
    },

    /** Set year from outside (e.g. after new data upload) */
    setYear(year) {
        if (this.availableYears.includes(year)) {
            this.currentYear = year;
        } else {
            // If year not in list, pick closest available or keep
            this.currentYear = this.availableYears[0] || year;
        }
        this.updateYearLabel();
        this.updateNavButtons();
    },

    updateYearLabel() {
        const label = UI.elements.bonificiYearLabel;
        if (label) label.textContent = this.currentYear || '—';
    },

    updateNavButtons() {
        const { bonificiYearPrev, bonificiYearNext } = UI.elements;
        if (!bonificiYearPrev || !bonificiYearNext) return;
        const idx = this.availableYears.indexOf(this.currentYear);
        // Prev = older year = higher idx in descending array
        bonificiYearPrev.disabled = idx >= this.availableYears.length - 1;
        // Next = newer year = lower idx
        bonificiYearNext.disabled = idx <= 0;
    },

    navigateYear(direction) {
        const idx = this.availableYears.indexOf(this.currentYear);
        let newIdx = idx + direction; // direction: +1 = older, -1 = newer
        if (newIdx < 0 || newIdx >= this.availableYears.length) return;
        this.currentYear = this.availableYears[newIdx];
        this.updateYearLabel();
        this.updateNavButtons();
        this.render();
    },

    /**
     * Compute monthly reimbursable amounts from the raw expenses data object
     * (the same grouped structure returned by /expenses).
     * Only non-excluded, non-neutral expenses count.
     */
    computeAmountsFromData(expensesData) {
        this.monthlyAmounts = {};
        if (!expensesData) return;

        const MONTH_ORDER = {};
        Object.entries(Utils.MONTH_NAMES).forEach(([num, name]) => MONTH_ORDER[name] = parseInt(num));

        Object.entries(expensesData).forEach(([year, months]) => {
            Object.entries(months).forEach(([monthName, expenses]) => {
                const monthNum = MONTH_ORDER[monthName];
                if (!monthNum) return;
                const key = `${year}-${String(monthNum).padStart(2, '0')}`;
                let total = 0;
                expenses.forEach(exp => {
                    if (!exp.is_excluded && !exp.is_neutral) {
                        total += parseFloat(exp.importo) || 0;
                    }
                });
                this.monthlyAmounts[key] = total;
            });
        });
    },

    /**
     * Full async load: fetch expenses (no filters) + monthly status,
     * compute amounts, then render.
     */
    async load() {
        const [expRes, statusRes] = await Promise.all([
            API.getExpenses({}),
            API.getMonthlyStatus()
        ]);

        if (expRes.ok) {
            this.computeAmountsFromData(expRes.data);
        }
        if (statusRes.ok) {
            this.statusMap = statusRes.data || {};
        }

        this.render();
    },

    /**
     * Render the table rows for the currentYear.
     * Shows all 12 months; greys out months with no data.
     */
    render() {
        const tbody = UI.elements.bonificiTbody;
        const tfootTotal = UI.elements.bonificiTfootTotal;
        if (!tbody) return;

        tbody.innerHTML = '';
        let yearTotal = 0;

        const allMonths = Object.keys(Utils.MONTH_NAMES).map(Number); // [1..12]

        allMonths.forEach(monthNum => {
            const key = `${this.currentYear}-${String(monthNum).padStart(2, '0')}`;
            const amount = this.monthlyAmounts[key];
            const isPaid = !!this.statusMap[key];
            const hasData = amount !== undefined;

            if (!hasData) return; // Only show months that have data

            yearTotal += amount;

            const tr = document.createElement('tr');
            tr.className = 'expense-row' + (isPaid ? ' bonifici-row-paid' : '');
            tr.dataset.year = this.currentYear;
            tr.dataset.month = monthNum;

            const importoClass = amount < 0 ? 'importo-negative' : (amount > 0 ? 'importo-positive' : '');
            const labelClass = isPaid ? 'label-paid' : 'label-unpaid';

            tr.innerHTML = `
                <td>${Utils.MONTH_NAMES[monthNum]}</td>
                <td class="${importoClass}" style="text-align:right; padding-right:18px;">
                    ${Utils.formatImporto(amount)}
                </td>
                <td style="text-align:center;">
                    <label class="paid-label ${labelClass}">
                        <input type="checkbox" class="paid-checkbox bonifici-paid-cb"
                            data-year="${this.currentYear}"
                            data-month="${monthNum}"
                            ${isPaid ? 'checked' : ''}>
                    </label>
                </td>
            `;
            tbody.appendChild(tr);
        });

        if (tbody.children.length === 0) {
            const emptyTr = document.createElement('tr');
            emptyTr.className = 'bonifici-empty-row';
            emptyTr.innerHTML = `<td colspan="3" style="text-align:center; color: var(--text-muted); padding: 32px 0; font-weight:500;">Nessun dato per il ${this.currentYear}</td>`;
            tbody.appendChild(emptyTr);
        }

        if (tfootTotal) {
            tfootTotal.textContent = Utils.formatImporto(yearTotal);
        }
    },

    /**
     * Update a single row's visual state (paid/unpaid) without re-rendering the whole table.
     * Called after a checkbox change.
     */
    updateRowState(year, month, isPaid) {
        if (parseInt(year) !== this.currentYear) return;

        const key = `${year}-${String(month).padStart(2, '0')}`;
        this.statusMap[key] = isPaid;

        const tbody = UI.elements.bonificiTbody;
        if (!tbody) return;

        const row = tbody.querySelector(`tr[data-year="${year}"][data-month="${month}"]`);
        if (!row) return;

        // Update checkbox
        const cb = row.querySelector('.bonifici-paid-cb');
        if (cb) cb.checked = isPaid;

        // Update label class
        const label = row.querySelector('.paid-label');
        if (label) {
            label.classList.toggle('label-paid', isPaid);
            label.classList.toggle('label-unpaid', !isPaid);
        }

        // Update row background
        row.classList.toggle('bonifici-row-paid', isPaid);
    },

    /**
     * Called when Elenco recalculates month totals (e.g. after toggle exclude).
     * Updates the amount cache and refreshes the corresponding row if visible.
     */
    updateMonthAmount(year, month, newAmount) {
        const key = `${year}-${String(month).padStart(2, '0')}`;
        this.monthlyAmounts[key] = newAmount;

        if (parseInt(year) !== this.currentYear) return;

        const tbody = UI.elements.bonificiTbody;
        if (!tbody) return;

        const row = tbody.querySelector(`tr[data-year="${year}"][data-month="${month}"]`);
        if (!row) {
            // Month might not be in table yet (e.g. was empty) — re-render
            this.render();
            return;
        }

        const amountCell = row.querySelector('td:nth-child(2)');
        if (amountCell) {
            amountCell.textContent = Utils.formatImporto(newAmount);
            amountCell.className = newAmount < 0 ? 'importo-negative' : (newAmount > 0 ? 'importo-positive' : '');
            amountCell.style.cssText = 'text-align:right; padding-right:18px;';
        }

        // Update footer total
        let yearTotal = 0;
        Object.entries(this.monthlyAmounts).forEach(([k, v]) => {
            if (k.startsWith(`${this.currentYear}-`)) yearTotal += v;
        });
        if (UI.elements.bonificiTfootTotal) {
            UI.elements.bonificiTfootTotal.textContent = Utils.formatImporto(yearTotal);
        }
    }
};

/* ══════════════════════════════════════════════════
   4. APP LOGIC
   ══════════════════════════════════════════════════ */
const App = {
    state: {
        currentYear: null,
        currentMonth: null,
        availablePeriods: [],
        dashboardDirty: false,
        lastExpenseData: null
    },

    init() {
        UI.cacheElements();
        this.setupNavigation();
        this.setupDashboard();
        this.setupElenco();
        this.setupBonifici();

        const savedTab = localStorage.getItem('activeTab') || 'dashboard';
        this.navigateTo(savedTab);
    },

    setupNavigation() {
        UI.elements.navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(item.dataset.page);
            });
        });
    },

    navigateTo(viewId) {
        localStorage.setItem('activeTab', viewId);
        UI.elements.navItems.forEach(item => item.classList.toggle('active', item.dataset.page === viewId));
        UI.elements.pages.forEach(page => {
            page.classList.toggle('active', page.id === `page-${viewId}`);
        });

        if (viewId === 'elenco') {
            this.loadElenco();
        } else if (viewId === 'dashboard' && this.state.dashboardDirty) {
            this.state.dashboardDirty = false;
            this.loadDashboard(this.state.currentYear, this.state.currentMonth);
            // Refresh Bonifici amounts when returning to dashboard
            Bonifici.load();
        } else if (viewId === 'dashboard' && !this.state.currentYear) {
            this.initDashboardData();
        }
    },

    async initDashboardData() {
        const res = await API.getAvailablePeriods();
        if (res.ok && res.data.periods.length > 0) {
            this.state.availablePeriods = res.data.periods;

            const years = res.data.years || [...new Set(res.data.periods.map(p => p.year))].sort((a, b) => b - a);
            UI.elements.yearFilter.innerHTML = '';
            years.forEach(y => {
                const opt = document.createElement('option');
                opt.value = y; opt.textContent = y;
                UI.elements.yearFilter.appendChild(opt);
            });

            this.state.currentYear = res.data.latest_year;
            this.state.currentMonth = res.data.latest_month;
            UI.elements.yearFilter.value = this.state.currentYear;

            this.updateMonthFilter();
            UI.elements.monthFilter.value = this.state.currentMonth;

            this.loadDashboard(this.state.currentYear, this.state.currentMonth);

            // Initialize Bonifici with available years
            Bonifici.init(years);
            Bonifici.load();
        }
    },

    updateMonthFilter() {
        const year = parseInt(UI.elements.yearFilter.value);
        const months = this.state.availablePeriods.filter(p => p.year === year).sort((a, b) => b.month - a.month);
        UI.elements.monthFilter.innerHTML = '';
        months.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.month;
            opt.textContent = Utils.MONTH_NAMES[p.month];
            UI.elements.monthFilter.appendChild(opt);
        });
    },

    async loadDashboard(year, month) {
        if (!year || !month) return;
        const res = await API.getDashboardStats(year, month);
        if (res.ok) {
            UI.renderDashboardStats(res.data);
        }
    },

    setupDashboard() {
        UI.elements.yearFilter?.addEventListener('change', () => {
            this.state.currentYear = parseInt(UI.elements.yearFilter.value);
            this.updateMonthFilter();
            this.state.currentMonth = parseInt(UI.elements.monthFilter.value);
            this.loadDashboard(this.state.currentYear, this.state.currentMonth);
        });
        UI.elements.monthFilter?.addEventListener('change', () => {
            this.state.currentMonth = parseInt(UI.elements.monthFilter.value);
            this.loadDashboard(this.state.currentYear, this.state.currentMonth);
        });

        const handleFiles = async (files) => {
            if (!files.length) return;
            UI.elements.uploadBtn.textContent = 'Caricamento...';
            UI.elements.uploadBtn.disabled = true;

            const result = await API.uploadFiles(files);

            Utils.showToast(UI.elements.uploadToast,
                `✓ ${result.totalNew} importati, ${result.totalDup} duplicati` + (result.totalErr ? `, ${result.totalErr} errori` : ''),
                result.totalErr ? 'error' : 'success'
            );

            if (result.lastError) Utils.showToast(UI.elements.uploadToast, result.lastError, 'error');

            UI.elements.uploadBtn.textContent = 'Carica e Analizza';
            UI.elements.uploadBtn.disabled = false;
            UI.elements.fileInput.value = '';

            await this.initDashboardData();
        };

        if (UI.elements.dropArea) {
            UI.elements.dropArea.addEventListener('click', () => UI.elements.fileInput.click());
            UI.elements.dropArea.addEventListener('dragover', (e) => { e.preventDefault(); UI.elements.dropArea.classList.add('highlight'); });
            UI.elements.dropArea.addEventListener('dragleave', () => UI.elements.dropArea.classList.remove('highlight'));
            UI.elements.dropArea.addEventListener('drop', (e) => {
                e.preventDefault();
                UI.elements.dropArea.classList.remove('highlight');
                handleFiles(Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.xlsx')));
            });
            UI.elements.fileInput?.addEventListener('change', (e) => handleFiles(Array.from(e.target.files)));
            UI.elements.uploadBtn?.addEventListener('click', () => handleFiles(Array.from(UI.elements.fileInput.files)));
        }
    },

    /**
     * Setup the Bonifici year navigator buttons.
     * The card's checkbox changes are handled here and also sync to Elenco.
     */
    setupBonifici() {
        UI.elements.bonificiYearPrev?.addEventListener('click', () => Bonifici.navigateYear(+1));
        UI.elements.bonificiYearNext?.addEventListener('click', () => Bonifici.navigateYear(-1));

        // Delegated click on Bonifici table checkboxes
        UI.elements.bonificiTbody?.addEventListener('change', async (e) => {
            const cb = e.target.closest('.bonifici-paid-cb');
            if (!cb) return;

            const year = cb.dataset.year;
            const month = parseInt(cb.dataset.month);
            const isPaid = cb.checked;

            // Persist to backend
            await API.setMonthlyStatus(year, month, isPaid);

            // Update Bonifici state immediately
            Bonifici.updateRowState(year, month, isPaid);

            // ── SYNC TO ELENCO ──────────────────────────────────
            // Find the corresponding paid-checkbox in Elenco and update it
            const elencoSection = document.querySelector(
                `#page-elenco .month-section[data-year="${year}"][data-month="${month}"]`
            );
            if (elencoSection) {
                const elencoCb = elencoSection.querySelector(`.paid-checkbox[data-year="${year}"][data-month="${month}"]`);
                if (elencoCb && elencoCb.checked !== isPaid) {
                    elencoCb.checked = isPaid;
                    UI.recalcMonthTotals(elencoSection);
                }
            }

            this.state.dashboardDirty = false; // We already refreshed inline
        });
    },

    setupElenco() {
        // Upload (+)
        UI.elements.elencoExportBtn?.addEventListener('click', () => UI.elements.elencoFileInput.click());
        UI.elements.elencoFileInput?.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files).filter(f => f.name.endsWith('.xlsx'));
            if (!files.length) return;
            const res = await API.uploadFiles(files);
            Utils.showToast(UI.elements.elencoToast, `✓ ${res.totalNew} nuovi, ${res.totalDup} duplicati`, 'success');
            await this.loadElenco();
            Bonifici.load();
        });

        // Real-time Search
        let timer;
        UI.elements.searchInput?.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => this.filterElencoLocally(e.target.value), 250);
        });

        // Date Filter
        if (UI.elements.dateFilterBtn) {
            UI.elements.dateFilterBtn.addEventListener('click', (e) => {
                UI.elements.datePopover.classList.toggle('hidden');
                UI.elements.kebabDropdown?.classList.add('hidden');
                e.stopPropagation();
            });
            UI.elements.applyDateBtn?.addEventListener('click', () => {
                this.loadElenco();
                UI.elements.datePopover.classList.add('hidden');
            });
            UI.elements.clearDateBtn?.addEventListener('click', () => {
                UI.elements.dateStart.value = ''; UI.elements.dateEnd.value = '';
                this.loadElenco();
                UI.elements.datePopover.classList.add('hidden');
            });
            document.addEventListener('click', (e) => {
                if (!UI.elements.datePopover.contains(e.target) && !UI.elements.dateFilterBtn.contains(e.target)) {
                    UI.elements.datePopover.classList.add('hidden');
                }
            });
        }

        // Action Delegation (Delete, Toggle Eye, Edit)
        UI.elements.expensesList?.addEventListener('click', async (e) => {
            const btnDelete = e.target.closest('.delete-btn');
            const btnEye = e.target.closest('.eye-toggle');
            const btnEdit = e.target.closest('.edit-btn');

            if (btnDelete) {
                const id = btnDelete.dataset.id;
                const res = await API.deleteExpense(id);
                if (res.ok) {
                    Utils.showToast(UI.elements.elencoToast, '✓ Spesa eliminata.', 'success');
                    const row = btnDelete.closest('.expense-row');
                    const section = row.closest('.month-section');

                    row.classList.add('fade-out');

                    setTimeout(() => {
                        row.remove();

                        if (section.querySelectorAll('.expense-row').length === 0) {
                            let yearHeader = section.previousElementSibling;
                            while (yearHeader && !yearHeader.classList.contains('year-header')) {
                                yearHeader = yearHeader.previousElementSibling;
                            }
                            section.classList.add('fade-out');
                            setTimeout(() => {
                                section.remove();
                                if (yearHeader) {
                                    let next = yearHeader.nextElementSibling;
                                    let separator = null;
                                    if (next && next.classList.contains('year-separator')) {
                                        separator = next;
                                        next = next.nextElementSibling;
                                    }
                                    if (!next || !next.classList.contains('month-section')) {
                                        yearHeader.remove();
                                        if (separator) separator.remove();
                                    }
                                }
                            }, 500);
                        } else {
                            UI.recalcMonthTotals(section);
                            // Refresh Bonifici amount for this month
                            this._syncBonificiAmountFromSection(section);
                        }
                    }, 500);

                    this.state.dashboardDirty = true;
                }

            } else if (btnEdit) {
                const row = btnEdit.closest('.expense-row');
                if (row.nextElementSibling?.classList.contains('inline-edit-row')) return;
                UI.showInlineEditForm(row);

            } else if (btnEye) {
                const id = btnEye.dataset.id;
                const res = await API.toggleExclude(id);
                if (res.ok) {
                    const row = btnEye.closest('.expense-row');
                    row.classList.toggle('excluded', res.data.is_excluded);
                    const icon = btnEye.querySelector('i');
                    icon.className = `fa-solid ${res.data.is_excluded ? 'fa-eye-slash' : 'fa-eye'}`;
                    btnEye.title = res.data.is_excluded ? 'Includi' : 'Escludi';
                    const section = row.closest('.month-section');
                    UI.recalcMonthTotals(section);
                    // ── SYNC Bonifici amount ──
                    this._syncBonificiAmountFromSection(section);
                    this.state.dashboardDirty = true;
                }
            }
        });

        UI.elements.expensesList?.addEventListener('change', async (e) => {
            if (e.target.classList.contains('paid-checkbox') && !e.target.classList.contains('bonifici-paid-cb')) {
                const cb = e.target;
                const section = cb.closest('.month-section');
                const year = cb.dataset.year;
                const month = parseInt(cb.dataset.month);
                const isPaid = cb.checked;

                try {
                    await API.setMonthlyStatus(year, month, isPaid);
                    UI.recalcMonthTotals(section);
                    this.state.dashboardDirty = true;

                    // ── SYNC TO BONIFICI DASHBOARD ──────────────────────
                    Bonifici.updateRowState(year, month, isPaid);

                } catch (err) {
                    cb.checked = !cb.checked;
                }
            }
        });

        this.setupModals();
    },

    /**
     * Helper: read the reimbursable total from an Elenco month-section
     * and push the update to Bonifici.
     */
    _syncBonificiAmountFromSection(section) {
        if (!section) return;
        const year = section.dataset.year;
        const month = section.dataset.month;

        // Recompute reimbursable (non-excluded, non-neutral) from DOM
        let total = 0;
        section.querySelectorAll('.expense-row').forEach(row => {
            if (!row.classList.contains('excluded') && !row.classList.contains('neutral-row')) {
                total += parseFloat(row.dataset.importo) || 0;
            }
        });

        Bonifici.updateMonthAmount(year, parseInt(month), total);
    },

    setupModals() {
        if (UI.elements.kebabBtn) {
            UI.elements.kebabBtn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                UI.elements.kebabDropdown?.classList.toggle('hidden');
                UI.elements.datePopover?.classList.add('hidden');
            });
            document.addEventListener('click', () => UI.elements.kebabDropdown?.classList.add('hidden'));
        }

        UI.elements.modalOverlays.forEach(ov => ov.addEventListener('click', (e) => {
            if (e.target === ov) ov.classList.add('hidden');
        }));
        document.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', (e) => {
            e.target.closest('.modal-overlay').classList.add('hidden');
        }));

        document.getElementById('kebab-bulk-delete')?.addEventListener('click', () => {
            UI.openModal('modal-bulk-delete');
            this.loadBulkDeleteTree();
        });
        document.getElementById('confirm-bulk-delete')?.addEventListener('click', async () => {
            const checked = document.querySelectorAll('#bulk-delete-tree input[data-month]:checked');
            const periods = Array.from(checked).map(c => ({
                year: parseInt(c.dataset.year), month: parseInt(c.dataset.month)
            }));

            if (confirm(`Eliminare ${periods.length} mesi? Azione irreversibile.`)) {
                const res = await API.bulkDelete(periods);
                if (res.ok) window.location.reload();
            }
        });

        document.getElementById('kebab-keywords')?.addEventListener('click', async () => {
            UI.openModal('modal-keywords');
            this.loadKeywordsList();
        });
        UI.elements.addKeywordBtn?.addEventListener('click', async () => {
            const kw = UI.elements.keywordInput.value.trim();
            if (!kw) {
                UI.showErrorTooltip(UI.elements.keywordInput, 'Inserisci una keyword');
                return;
            }
            const res = await API.addKeyword(kw);
            if (res.ok) {
                UI.elements.keywordInput.value = '';
                this.loadKeywordsList();
                this.state.dashboardDirty = true;
                if (document.getElementById('page-elenco').classList.contains('active')) this.loadElenco();
            } else {
                UI.showErrorTooltip(UI.elements.keywordInput, API.extractError(res));
            }
        });

        UI.elements.keywordInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') UI.elements.addKeywordBtn.click();
        });
    },

    async loadElenco() {
        const params = {};
        if (UI.elements.searchInput?.value) params.search_text = UI.elements.searchInput.value;
        if (UI.elements.dateStart?.value) params.start_date = UI.elements.dateStart.value;
        if (UI.elements.dateEnd?.value) params.end_date = UI.elements.dateEnd.value;

        const [expRes, statsRes] = await Promise.all([
            API.getExpenses(params),
            API.getMonthlyStatus()
        ]);

        if (expRes.ok) {
            this.state.lastExpenseData = expRes.data;
            UI.renderExpenses(expRes.data, statsRes.data || {});

            // Keep Bonifici amounts in sync with the full (unfiltered) data
            // Only if no filters are active (to avoid partial data)
            if (!params.search_text && !params.start_date && !params.end_date) {
                Bonifici.computeAmountsFromData(expRes.data);
                if (statsRes.ok) Bonifici.statusMap = statsRes.data || {};
                Bonifici.render();
            }
        }
    },

    filterElencoLocally(query) {
        const q = query.toLowerCase();
        const rows = document.querySelectorAll('.expense-row');
        rows.forEach(row => {
            row.style.display = row.innerText.toLowerCase().includes(q) ? '' : 'none';
        });
        document.querySelectorAll('.month-section').forEach(sec => {
            const visibleRows = sec.querySelectorAll('.expense-row:not([style*="none"])');
            sec.style.display = visibleRows.length ? '' : 'none';
        });
    },

    async loadBulkDeleteTree() {
        const tree = document.getElementById('bulk-delete-tree');
        tree.innerHTML = 'Caricamento...';
        const res = await API.getAvailablePeriods();
        if (!res.ok) return;

        const byYear = {};
        res.data.periods.forEach(p => {
            if (!byYear[p.year]) byYear[p.year] = [];
            byYear[p.year].push(p.month);
        });

        tree.innerHTML = '';
        Object.keys(byYear).sort((a, b) => b - a).forEach(y => {
            const div = document.createElement('div');
            div.className = 'period-year';
            div.innerHTML = `<div class="period-year-header"><input type="checkbox" class="paid-checkbox" data-year="${y}"> <b>${y}</b></div><div class="period-months"></div>`;
            const mDiv = div.querySelector('.period-months');
            byYear[y].sort((a, b) => a - b).forEach(m => {
                mDiv.innerHTML += `<label class="period-month-label"><input type="checkbox" class="paid-checkbox" data-year="${y}" data-month="${m}"> ${Utils.MONTH_NAMES[m]}</label>`;
            });
            tree.appendChild(div);
        });

        tree.querySelectorAll('input[data-year]:not([data-month])').forEach(yCb => {
            yCb.addEventListener('change', () => {
                tree.querySelectorAll(`input[data-year="${yCb.dataset.year}"][data-month]`).forEach(mCb => mCb.checked = yCb.checked);
                this.checkBulkDeleteBtn();
            });
        });
        tree.querySelectorAll('input[data-month]').forEach(mCb => {
            mCb.addEventListener('change', () => {
                this.checkBulkDeleteBtn();
                const year = mCb.dataset.year;
                const yearCb = tree.querySelector(`input[data-year="${year}"]:not([data-month])`);
                const allMonths = tree.querySelectorAll(`input[data-year="${year}"][data-month]`);
                if (yearCb && allMonths.length > 0) {
                    yearCb.checked = Array.from(allMonths).every(cb => cb.checked);
                }
            });
        });
    },

    checkBulkDeleteBtn() {
        const checked = document.querySelectorAll('#bulk-delete-tree input[data-month]:checked');
        document.getElementById('confirm-bulk-delete').disabled = checked.length === 0;
    },

    async loadKeywordsList() {
        const list = UI.elements.keywordList;
        list.innerHTML = 'Caricamento...';
        const res = await API.getKeywords();
        if (res.ok) {
            list.innerHTML = '';
            res.data.forEach(k => {
                const tag = document.createElement('span');
                tag.className = 'keyword-tag';
                tag.innerHTML = `${Utils.escapeHtml(k.keyword)} <button class="keyword-remove"><i class="fa-solid fa-xmark"></i></button>`;
                tag.querySelector('button').addEventListener('click', async () => {
                    await API.removeKeyword(k.id);
                    this.loadKeywordsList();
                });
                list.appendChild(tag);
            });
        }
    }
};
