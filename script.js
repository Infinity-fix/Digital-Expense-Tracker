/**
 * LedgerFlow Expense Tracker — Frontend Controller (script.js)
 * Connects Dashboard & All Expenses templates to Flask SQLite API endpoints.
 */

let categoryChartInstance = null;
let monthlyChartInstance = null;
let pendingDeleteId = null;
let cachedExpenses = [];

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initSidebarToggle();
    initDefaultDateInputs();
    initAddExpenseForm();
    initModals();

    const currentPage = document.body.getAttribute("data-page");
    if (currentPage === "dashboard") {
        refreshDashboard();
    } else if (currentPage === "expenses") {
        initExpenseFilters();
        loadFilteredExpenses();
    }
});

function initTheme() {
    const savedTheme = localStorage.getItem("ledgerflow_theme") || "light";
    setTheme(savedTheme);

    const toggleBtn = document.getElementById("themeToggleBtn");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
            const current = document.documentElement.getAttribute("data-theme") || "light";
            const next = current === "dark" ? "light" : "dark";
            setTheme(next);
            if (document.body.getAttribute("data-page") === "dashboard") {
                refreshDashboard();
            }
        });
    }
}

function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ledgerflow_theme", theme);
    const label = document.getElementById("themeToggleLabel");
    if (label) {
        label.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
    }
}

function initSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const openBtn = document.getElementById("openSidebarBtn");
    const closeBtn = document.getElementById("closeSidebarBtn");

    if (openBtn && sidebar) {
        openBtn.addEventListener("click", () => sidebar.classList.add("open"));
    }
    if (closeBtn && sidebar) {
        closeBtn.addEventListener("click", () => sidebar.classList.remove("open"));
    }
}

function initDefaultDateInputs() {
    const dateInput = document.getElementById("expenseDate");
    if (dateInput && !dateInput.value) {
        const today = new Date().toISOString().split("T")[0];
        dateInput.value = today;
    }
}

function formatCurrency(value) {
    const num = Number(value) || 0;
    return "₹" + num.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function showToast(message, type = "success") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = `${type === "error" ? "Error: " : "Success: "}${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3500);
}

function validateFormFields({ date, category, description, amount }) {
    if (!date || !date.trim()) {
        return "Please select a valid date.";
    }
    if (!category || !category.trim()) {
        return "Please choose an expense category.";
    }
    if (!description || !description.trim()) {
        return "Please enter a brief description.";
    }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return "Amount must be a positive number greater than 0.";
    }
    return null;
}

function initAddExpenseForm() {
    const form = document.getElementById("addExpenseForm");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const payload = {
            date: document.getElementById("expenseDate").value,
            category: document.getElementById("expenseCategory").value,
            description: document.getElementById("expenseDescription").value,
            amount: document.getElementById("expenseAmount").value,
        };

        const validationError = validateFormFields(payload);
        if (validationError) {
            showToast(validationError, "error");
            return;
        }

        try {
            const response = await fetch("/api/expenses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const result = await response.json();

            if (!response.ok || !result.success) {
                showToast(result.error || "Failed to add expense.", "error");
                return;
            }

            showToast("Expense saved to SQLite database.", "success");
            document.getElementById("expenseDescription").value = "";
            document.getElementById("expenseAmount").value = "";

            const currentPage = document.body.getAttribute("data-page");
            if (currentPage === "dashboard") {
                refreshDashboard();
            } else {
                loadFilteredExpenses();
            }
        } catch (err) {
            showToast("Network error while saving expense.", "error");
        }
    });
}

async function refreshDashboard() {
    try {
        const [summaryRes, expensesRes] = await Promise.all([
            fetch("/api/summary"),
            fetch("/api/expenses?sort_by=date&sort_order=desc"),
        ]);

        const summaryData = await summaryRes.json();
        const expensesData = await expensesRes.json();

        if (summaryData.success) {
            updateKpiCards(summaryData.kpis);
            renderCategorySummaryTable(summaryData.category_breakdown);
            renderCategoryChart(summaryData.category_breakdown);
            renderMonthlyChart(summaryData.monthly_breakdown);
        }

        if (expensesData.success) {
            cachedExpenses = expensesData.expenses || [];
            renderRecentExpensesTable(cachedExpenses.slice(0, 8));
        }
    } catch (err) {
        showToast("Unable to load dashboard metrics.", "error");
    }
}

function updateKpiCards(kpis) {
    const totalEl = document.getElementById("kpiTotalExpenses");
    const monthEl = document.getElementById("kpiMonthExpenses");
    const todayEl = document.getElementById("kpiTodayExpenses");
    const countEl = document.getElementById("kpiTransactionCount");

    if (totalEl) totalEl.textContent = formatCurrency(kpis.total_expenses);
    if (monthEl) monthEl.textContent = formatCurrency(kpis.month_expenses);
    if (todayEl) todayEl.textContent = formatCurrency(kpis.today_expenses);
    if (countEl) countEl.textContent = String(kpis.total_transactions);
}

function renderCategorySummaryTable(breakdown) {
    const tbody = document.getElementById("categorySummaryBody");
    if (!tbody) return;

    if (!breakdown || breakdown.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">No category spending recorded yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = breakdown
        .map(
            (item) => `
            <tr>
                <td>${escapeHtml(item.category)}</td>
                <td class="text-right tabular-nums">${item.count}</td>
                <td class="text-right tabular-nums">${item.percentage.toFixed(1)}%</td>
                <td class="text-right tabular-nums"><strong>${formatCurrency(item.total)}</strong></td>
            </tr>
        `
        )
        .join("");
}

function renderRecentExpensesTable(expenses) {
    const tbody = document.getElementById("recentExpensesBody");
    if (!tbody) return;

    if (!expenses || expenses.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">No expenses logged yet. Use the form above to add your first expense.</td></tr>`;
        return;
    }

    tbody.innerHTML = expenses
        .map(
            (exp) => `
            <tr>
                <td class="tabular-nums">${escapeHtml(exp.display_date)}</td>
                <td>${escapeHtml(exp.category)}</td>
                <td>${escapeHtml(exp.description)}</td>
                <td class="text-right tabular-nums"><strong>${formatCurrency(exp.amount)}</strong></td>
                <td class="text-right">
                    <div class="action-group">
                        <button type="button" class="btn-secondary btn-table" onclick="openEditModal(${exp.id})">Edit</button>
                        <button type="button" class="btn-danger btn-table" onclick="openDeleteModal(${exp.id})">Delete</button>
                    </div>
                </td>
            </tr>
        `
        )
        .join("");
}

function renderCategoryChart(categoryBreakdown) {
    const canvas = document.getElementById("categoryChart");
    if (!canvas || typeof Chart === "undefined") return;

    if (categoryChartInstance) {
        categoryChartInstance.destroy();
    }

    const labels = categoryBreakdown.map((c) => c.category);
    const values = categoryBreakdown.map((c) => c.total);
    const palette = [
        "#2563eb",
        "#0d9488",
        "#d97706",
        "#7c3aed",
        "#e11d48",
        "#0284c7",
        "#16a34a",
        "#64748b",
    ];

    categoryChartInstance = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: labels.length ? labels : ["No Data"],
            datasets: [
                {
                    data: values.length ? values : [1],
                    backgroundColor: values.length ? palette.slice(0, values.length) : ["#cbd5e1"],
                    borderWidth: 1,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: "right",
                },
            },
        },
    });
}

function renderMonthlyChart(monthlyBreakdown) {
    const canvas = document.getElementById("monthlyChart");
    if (!canvas || typeof Chart === "undefined") return;

    if (monthlyChartInstance) {
        monthlyChartInstance.destroy();
    }

    const labels = monthlyBreakdown.map((m) => m.month);
    const values = monthlyBreakdown.map((m) => m.total);

    monthlyChartInstance = new Chart(canvas, {
        type: "bar",
        data: {
            labels: labels.length ? labels : ["No Data"],
            datasets: [
                {
                    label: "Monthly Spending (₹)",
                    data: values.length ? values : [0],
                    backgroundColor: "#2563eb",
                    borderRadius: 6,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                },
            },
        },
    });
}

function initExpenseFilters() {
    const controls = ["searchInput", "filterCategory", "filterStartDate", "filterEndDate", "sortBySelect"];
    controls.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("input", () => loadFilteredExpenses());
            el.addEventListener("change", () => loadFilteredExpenses());
        }
    });

    const resetBtn = document.getElementById("resetFiltersBtn");
    if (resetBtn) {
        resetBtn.addEventListener("click", () => {
            document.getElementById("searchInput").value = "";
            document.getElementById("filterCategory").value = "All";
            document.getElementById("filterStartDate").value = "";
            document.getElementById("filterEndDate").value = "";
            document.getElementById("sortBySelect").value = "date-desc";
            loadFilteredExpenses();
        });
    }

    const exportBtn = document.getElementById("exportFilteredCsvBtn");
    if (exportBtn) {
        exportBtn.addEventListener("click", () => {
            const params = buildFilterQueryParams();
            window.location.href = `/api/export-csv?${params.toString()}`;
        });
    }
}

function buildFilterQueryParams() {
    const search = document.getElementById("searchInput")?.value || "";
    const category = document.getElementById("filterCategory")?.value || "All";
    const startDate = document.getElementById("filterStartDate")?.value || "";
    const endDate = document.getElementById("filterEndDate")?.value || "";
    const sortRaw = document.getElementById("sortBySelect")?.value || "date-desc";
    const [sortBy, sortOrder] = sortRaw.split("-");

    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (category && category !== "All") params.set("category", category);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    if (sortBy) params.set("sort_by", sortBy);
    if (sortOrder) params.set("sort_order", sortOrder);
    return params;
}

async function loadFilteredExpenses() {
    const tbody = document.getElementById("allExpensesBody");
    if (!tbody) return;

    try {
        const params = buildFilterQueryParams();
        const response = await fetch(`/api/expenses?${params.toString()}`);
        const data = await response.json();

        if (!response.ok || !data.success) {
            showToast(data.error || "Failed to filter expenses.", "error");
            return;
        }

        cachedExpenses = data.expenses || [];
        const countLabel = document.getElementById("filteredCountLabel");
        const totalLabel = document.getElementById("filteredTotalLabel");
        if (countLabel) countLabel.textContent = String(data.count);
        if (totalLabel) totalLabel.textContent = formatCurrency(data.filtered_total);

        if (cachedExpenses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No matching expenses found for the selected filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = cachedExpenses
            .map(
                (exp) => `
                <tr>
                    <td class="tabular-nums">#${exp.id}</td>
                    <td class="tabular-nums">${escapeHtml(exp.display_date)}</td>
                    <td class="tabular-nums">${escapeHtml(exp.date)}</td>
                    <td>${escapeHtml(exp.category)}</td>
                    <td>${escapeHtml(exp.description)}</td>
                    <td class="text-right tabular-nums"><strong>${formatCurrency(exp.amount)}</strong></td>
                    <td class="text-right">
                        <div class="action-group">
                            <button type="button" class="btn-secondary btn-table" onclick="openEditModal(${exp.id})">Edit</button>
                            <button type="button" class="btn-danger btn-table" onclick="openDeleteModal(${exp.id})">Delete</button>
                        </div>
                    </td>
                </tr>
            `
            )
            .join("");
    } catch (err) {
        showToast("Error loading expenses table.", "error");
    }
}

function initModals() {
    const closeEditBtn = document.getElementById("closeEditModalBtn");
    const cancelEditBtn = document.getElementById("cancelEditBtn");
    const editForm = document.getElementById("editExpenseForm");

    if (closeEditBtn) closeEditBtn.addEventListener("click", closeEditModal);
    if (cancelEditBtn) cancelEditBtn.addEventListener("click", closeEditModal);

    if (editForm) {
        editForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const id = document.getElementById("editExpenseId").value;
            const payload = {
                date: document.getElementById("editExpenseDate").value,
                category: document.getElementById("editExpenseCategory").value,
                description: document.getElementById("editExpenseDescription").value,
                amount: document.getElementById("editExpenseAmount").value,
            };

            const validationError = validateFormFields(payload);
            if (validationError) {
                showToast(validationError, "error");
                return;
            }

            try {
                const res = await fetch(`/api/expenses/${id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                const result = await res.json();
                if (!res.ok || !result.success) {
                    showToast(result.error || "Update failed.", "error");
                    return;
                }

                showToast("Expense updated successfully.", "success");
                closeEditModal();
                reloadCurrentPageData();
            } catch (err) {
                showToast("Network error while updating expense.", "error");
            }
        });
    }

    const closeDeleteBtn = document.getElementById("closeDeleteModalBtn");
    const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
    const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");

    if (closeDeleteBtn) closeDeleteBtn.addEventListener("click", closeDeleteModal);
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteModal);

    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener("click", async () => {
            if (!pendingDeleteId) return;
            try {
                const res = await fetch(`/api/expenses/${pendingDeleteId}`, {
                    method: "DELETE",
                });
                const result = await res.json();
                if (!res.ok || !result.success) {
                    showToast(result.error || "Failed to delete expense.", "error");
                    return;
                }

                showToast("Expense deleted from database.", "success");
                closeDeleteModal();
                reloadCurrentPageData();
            } catch (err) {
                showToast("Network error while deleting expense.", "error");
            }
        });
    }
}

window.openEditModal = function (expenseId) {
    const expense = cachedExpenses.find((item) => item.id === expenseId);
    if (!expense) return;

    document.getElementById("editExpenseId").value = expense.id;
    document.getElementById("editExpenseDate").value = expense.date;
    document.getElementById("editExpenseCategory").value = expense.category;
    document.getElementById("editExpenseDescription").value = expense.description;
    document.getElementById("editExpenseAmount").value = expense.amount;

    document.getElementById("editModalBackdrop").classList.remove("hidden");
};

function closeEditModal() {
    document.getElementById("editModalBackdrop")?.classList.add("hidden");
}

window.openDeleteModal = function (expenseId) {
    pendingDeleteId = expenseId;
    const expense = cachedExpenses.find((item) => item.id === expenseId);
    const msg = document.getElementById("deleteModalMessage");
    if (msg && expense) {
        msg.textContent = `Are you sure you want to delete "${expense.description}" (${formatCurrency(expense.amount)} on ${expense.display_date})?`;
    }
    document.getElementById("deleteModalBackdrop").classList.remove("hidden");
};

function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById("deleteModalBackdrop")?.classList.add("hidden");
}

function reloadCurrentPageData() {
    const currentPage = document.body.getAttribute("data-page");
    if (currentPage === "dashboard") {
        refreshDashboard();
    } else {
        loadFilteredExpenses();
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}