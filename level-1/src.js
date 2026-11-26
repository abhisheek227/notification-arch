const STORAGE_KEY = "notifications_v1";

const DEFAULT_NOTIFICATIONS = [
    {
        id: "sample-1",
        title: "System Update",
        message: "Notification service is up and running.",
        type: "info",
        read: false,
        createdAt: Date.now() - 30 * 1000,
    },
    {
        id: "sample-2",
        title: "Connected",
        message: "Successfully initialized notification channel.",
        type: "success",
        read: true,
        createdAt: Date.now() - 2 * 60 * 1000,
    },
];

// State
let notifications = loadNotifications();
let activeFilter = "all";

// DOM Elements
const form = document.getElementById("notification-form");
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

// Storage helpers
function loadNotifications() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [...DEFAULT_NOTIFICATIONS];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [...DEFAULT_NOTIFICATIONS];
    } catch {
        return [...DEFAULT_NOTIFICATIONS];
    }
}

function saveNotifications() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
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

// Actions
function addNotification(title, message, type) {
    const newNotif = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        title: title.trim(),
        message: message.trim(),
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
form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const message = messageInput.value.trim();
    const type = typeSelect.value;

    if (!title || !message) return;

    addNotification(title, message, type);
    form.reset();
    titleInput.focus();
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
