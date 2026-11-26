const STORAGE_KEY = "notifications_v2";

// State
let notifications = loadNotifications();
let activeFilter = "all";
let pollTimerId = null;

// DOM Elements
const fetchForm = document.getElementById("fetch-form");
const apiSourceSelect = document.getElementById("api-source");
const customUrlGroup = document.getElementById("custom-url-group");
const customUrlInput = document.getElementById("custom-url");
const fetchNowBtn = document.getElementById("fetch-now-btn");
const fetchStatusEl = document.getElementById("fetch-status");
const pollIntervalSelect = document.getElementById("poll-interval");
const pollToggleBtn = document.getElementById("poll-toggle-btn");

const listEl = document.getElementById("notification-list");
const emptyStateEl = document.getElementById("empty-state");
const unreadCountEl = document.getElementById("unread-count");
const markAllReadBtn = document.getElementById("mark-all-read-btn");
const clearAllBtn = document.getElementById("clear-all-btn");
const filterButtons = document.querySelectorAll(".filter-btn");
const toastContainer = document.getElementById("toast-container");

// API Adapters
const API_SOURCES = {
    jsonplaceholder: async () => {
        const randomId = Math.floor(Math.random() * 100) + 1;
        const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${randomId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return {
            title: `Post #${data.id}: ${data.title}`,
            message: data.body,
            type: "info",
        };
    },

    advice: async () => {
        const res = await fetch("https://api.adviceslip.com/advice", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return {
            title: `Advice #${data.slip.id}`,
            message: data.slip.advice,
            type: "success",
        };
    },

    joke: async () => {
        const res = await fetch("https://official-joke-api.appspot.com/random_joke");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return {
            title: `Joke (${data.type})`,
            message: `${data.setup} — ${data.punchline}`,
            type: "info",
        };
    },

    custom: async () => {
        const url = customUrlInput.value.trim();
        if (!url) throw new Error("Please enter a custom API URL.");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const title = data.title || data.name || `Response from ${new URL(url).hostname}`;
        const message =
            data.body ||
            data.message ||
            data.description ||
            JSON.stringify(data).slice(0, 180);
        return { title, message, type: "success" };
    },
};

// Storage helpers
function loadNotifications() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveNotifications() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
}

// Status helper
function setStatus(text, stateClass = "") {
    fetchStatusEl.textContent = text;
    fetchStatusEl.className = `status-pill${stateClass ? ` ${stateClass}` : ""}`;
}

// Time formatting
function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// Fetch & push notification
async function fetchAndNotify() {
    let sourceKey = apiSourceSelect.value;
    if (sourceKey === "random") {
        const keys = ["jsonplaceholder", "advice", "joke"];
        sourceKey = keys[Math.floor(Math.random() * keys.length)];
    }

    fetchNowBtn.disabled = true;
    setStatus("Fetching...", "fetching");

    try {
        const payload = await API_SOURCES[sourceKey]();
        addNotification(payload.title, payload.message, payload.type);
        setStatus(pollTimerId ? "Polling" : "Idle", pollTimerId ? "polling" : "");
    } catch (err) {
        addNotification("API Fetch Failed", err.message || "Could not reach API.", "error");
        setStatus("Error", "error");
    } finally {
        fetchNowBtn.disabled = false;
    }
}

// Auto-polling
function startPolling() {
    const ms = Number(pollIntervalSelect.value);
    pollToggleBtn.textContent = "Stop Auto-Fetch";
    setStatus("Polling", "polling");
    fetchAndNotify();
    pollTimerId = setInterval(fetchAndNotify, ms);
}

function stopPolling() {
    if (pollTimerId) {
        clearInterval(pollTimerId);
        pollTimerId = null;
    }
    pollToggleBtn.textContent = "Start Auto-Fetch";
    setStatus("Idle");
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
    li.dataset.type = notif.type;

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
    const unreadCount = notifications.filter((n) => !n.read).length;
    unreadCountEl.textContent = unreadCount;

    const filtered = getFilteredNotifications();
    listEl.innerHTML = "";

    if (filtered.length === 0) {
        emptyStateEl.classList.remove("hidden");
    } else {
        emptyStateEl.classList.add("hidden");
        const fragment = document.createDocumentFragment();
        filtered.forEach((notif) => {
            fragment.appendChild(createNotificationElement(notif));
        });
        listEl.appendChild(fragment);
    }
}

// Toast
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

    setTimeout(() => {
        toast.remove();
    }, 4000);
}

// Notification state actions
function addNotification(title, message, type) {
    const newNotif = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        title: String(title).trim(),
        message: String(message).trim(),
        type,
        read: false,
        createdAt: Date.now(),
    };

    notifications.unshift(newNotif);
    saveNotifications();
    render();
    showToast(newNotif);
}

function toggleRead(id) {
    const notif = notifications.find((n) => n.id === id);
    if (!notif) return;
    notif.read = !notif.read;
    saveNotifications();
    render();
}

function dismissNotification(id) {
    notifications = notifications.filter((n) => n.id !== id);
    saveNotifications();
    render();
}

function markAllRead() {
    notifications.forEach((n) => {
        n.read = true;
    });
    saveNotifications();
    render();
}

function clearAll() {
    notifications = [];
    saveNotifications();
    render();
}

// Event Listeners
apiSourceSelect.addEventListener("change", () => {
    customUrlGroup.classList.toggle("hidden", apiSourceSelect.value !== "custom");
});

fetchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    fetchAndNotify();
});

pollToggleBtn.addEventListener("click", () => {
    if (pollTimerId) {
        stopPolling();
    } else {
        startPolling();
    }
});

pollIntervalSelect.addEventListener("change", () => {
    if (pollTimerId) {
        stopPolling();
        startPolling();
    }
});

listEl.addEventListener("click", (e) => {
    const card = e.target.closest(".notification-card");
    if (!card) return;

    const { id } = card.dataset;
    if (e.target.closest(".dismiss-btn")) {
        dismissNotification(id);
    } else {
        toggleRead(id);
    }
});

markAllReadBtn.addEventListener("click", markAllRead);
clearAllBtn.addEventListener("click", clearAll);

filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        activeFilter = btn.dataset.filter;
        filterButtons.forEach((b) => b.classList.toggle("active", b === btn));
        render();
    });
});

// Initial render
render();
