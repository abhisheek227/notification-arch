const API_BASE = window.location.origin.startsWith("http")
    ? window.location.origin
    : "http://localhost:3000";

let notifications = [];
let activeFilter = "all";

// DOM Elements
const sseStatusEl = document.getElementById("sse-status");
const notifyForm = document.getElementById("notify-form");
const titleInput = document.getElementById("notif-title");
const messageInput = document.getElementById("notif-message");
const typeSelect = document.getElementById("notif-type");
const listEl = document.getElementById("notification-list");
const emptyStateEl = document.getElementById("empty-state");
const unreadCountEl = document.getElementById("unread-count");
const markAllReadBtn = document.getElementById("mark-all-read-btn");
const clearAllBtn = document.getElementById("clear-all-btn");
const filterButtons = document.querySelectorAll(".filter-btn");
const toastContainer = document.getElementById("toast-container");

function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function setSseStatus(text, stateClass = "") {
    sseStatusEl.textContent = text;
    sseStatusEl.className = `status-pill${stateClass ? ` ${stateClass}` : ""}`;
}

// Connect to SSE stream
function connectSSE() {
    const eventSource = new EventSource(`${API_BASE}/events`);

    eventSource.addEventListener("connected", () => {
        setSseStatus("SSE Connected", "connected");
    });

    eventSource.addEventListener("notification", (event) => {
        try {
            const data = JSON.parse(event.data);
            const notif = { ...data, read: false };
            notifications.unshift(notif);
            render();
            showToast(notif);
        } catch (err) {
            console.error("Failed to parse SSE notification:", err);
        }
    });

    eventSource.onerror = () => {
        setSseStatus("Disconnected (retrying...)", "disconnected");
    };
}

// Rendering
function getFilteredNotifications() {
    if (activeFilter === "all") return notifications;
    if (activeFilter === "unread") return notifications.filter((n) => !n.read);
    return notifications.filter((n) => n.type === activeFilter);
}

function createNotificationElement(notif) {
    const li = document.createElement("li");
    li.className = `notification-card type-${notif.type}${notif.read ? "" : " unread"}`;
    li.dataset.id = notif.id;

    const indicator = document.createElement("div");
    indicator.className = "notification-indicator";

    const body = document.createElement("div");
    body.className = "notification-body";

    const meta = document.createElement("div");
    meta.className = "notification-meta";

    const title = document.createElement("span");
    title.className = "notification-title";
    title.textContent = notif.title;

    const time = document.createElement("span");
    time.className = "notification-time";
    time.textContent = formatTimeAgo(notif.createdAt);

    meta.append(title, time);

    const message = document.createElement("p");
    message.className = "notification-message";
    message.textContent = notif.message;

    body.append(meta, message);

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "icon-btn dismiss-btn";
    dismissBtn.type = "button";
    dismissBtn.setAttribute("aria-label", "Dismiss notification");
    dismissBtn.innerHTML = "&times;";

    li.append(indicator, body, dismissBtn);
    return li;
}

function render() {
    unreadCountEl.textContent = notifications.filter((n) => !n.read).length;

    const filtered = getFilteredNotifications();
    listEl.innerHTML = "";

    if (filtered.length === 0) {
        emptyStateEl.classList.remove("hidden");
    } else {
        emptyStateEl.classList.add("hidden");
        const fragment = document.createDocumentFragment();
        filtered.forEach((n) => fragment.appendChild(createNotificationElement(n)));
        listEl.appendChild(fragment);
    }
}

function showToast({ title, message, type }) {
    const toast = document.createElement("div");
    toast.className = `toast type-${type}`;

    const content = document.createElement("div");

    const titleEl = document.createElement("div");
    titleEl.className = "notification-title";
    titleEl.textContent = title;

    const msgEl = document.createElement("p");
    msgEl.className = "notification-message";
    msgEl.textContent = message;

    content.append(titleEl, msgEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close toast");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", () => toast.remove());

    toast.append(content, closeBtn);
    toastContainer.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
}

// Event Listeners
notifyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const message = messageInput.value.trim();
    const type = typeSelect.value;

    if (!title || !message) return;

    try {
        const res = await fetch(`${API_BASE}/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, message, type }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        notifyForm.reset();
        titleInput.focus();
    } catch (err) {
        showToast({ title: "Send Failed", message: err.message, type: "error" });
    }
});

listEl.addEventListener("click", (e) => {
    const card = e.target.closest(".notification-card");
    if (!card) return;
    const { id } = card.dataset;

    if (e.target.closest(".dismiss-btn")) {
        notifications = notifications.filter((n) => n.id !== id);
    } else {
        const notif = notifications.find((n) => n.id === id);
        if (notif) notif.read = !notif.read;
    }
    render();
});

markAllReadBtn.addEventListener("click", () => {
    notifications.forEach((n) => (n.read = true));
    render();
});

clearAllBtn.addEventListener("click", () => {
    notifications = [];
    render();
});

filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        activeFilter = btn.dataset.filter;
        filterButtons.forEach((b) => b.classList.toggle("active", b === btn));
        render();
    });
});

// Start
render();
connectSSE();
