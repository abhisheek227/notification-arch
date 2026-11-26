const NOTIFICATION_API = "http://localhost:4000";
const PRODUCER_API = "http://localhost:4001";
const USER_ID = "user-1";

// Tab switching
document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
        if (btn.dataset.tab === "settings") loadSettings();
        if (btn.dataset.tab === "audit") loadAudit();
    });
});

// Browser Push Permission
const pushPermBtn = document.getElementById("pushPermBtn");
function updatePushButton() {
    if (!("Notification" in window)) {
        pushPermBtn.textContent = "Push Unsupported";
        pushPermBtn.disabled = true;
        return;
    }
    if (Notification.permission === "granted") {
        pushPermBtn.textContent = "Browser Push: ON";
    } else if (Notification.permission === "denied") {
        pushPermBtn.textContent = "Browser Push: Blocked";
    } else {
        pushPermBtn.textContent = "Enable Browser Push";
    }
}
pushPermBtn.addEventListener("click", async () => {
    if ("Notification" in window) {
        await Notification.requestPermission();
        updatePushButton();
    }
});
updatePushButton();

function showToast(channel, title, body) {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `
        <div class="toast-channel">${channel} NOTIFICATION</div>
        <div class="notif-title">${title}</div>
        <div class="notif-body">${body}</div>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// SSE Connection to Server 2
function connectSSE() {
    const statusEl = document.getElementById("sseStatus");
    const es = new EventSource(`${NOTIFICATION_API}/api/v1/notifications/stream?user_id=${USER_ID}`);

    es.addEventListener("connected", () => {
        statusEl.textContent = "SSE: Connected";
        statusEl.className = "pill pill-online";
    });

    es.addEventListener("in_app_notification", (e) => {
        const data = JSON.parse(e.data);
        showToast("IN_APP", data.rendered_content.title, data.rendered_content.body);
        loadInbox();
    });

    es.addEventListener("push_notification", (e) => {
        const data = JSON.parse(e.data);
        const { title, body } = data.rendered_content;
        showToast("PUSH", title, body);
        if ("Notification" in window && Notification.permission === "granted") {
            new Notification(title, { body });
        }
    });

    es.onerror = () => {
        statusEl.textContent = "SSE: Reconnecting...";
        statusEl.className = "pill pill-offline";
    };
}

// Load In-App Inbox
async function loadInbox() {
    const unreadOnly = document.getElementById("unreadOnlyToggle").checked;
    const [feedRes, countRes] = await Promise.all([
        fetch(`${NOTIFICATION_API}/api/v1/notifications?user_id=${USER_ID}&unread_only=${unreadOnly}`),
        fetch(`${NOTIFICATION_API}/api/v1/notifications/unread-count?user_id=${USER_ID}`),
    ]);
    const { notifications } = await feedRes.json();
    const { unread_count } = await countRes.json();

    document.getElementById("unreadBadge").textContent = unread_count;

    const list = document.getElementById("inboxList");
    if (!notifications.length) {
        list.innerHTML = `<div class="card"><p>No notifications yet. Go to <strong>Trigger Events (Server 1)</strong> to send one!</p></div>`;
        return;
    }

    list.innerHTML = notifications
        .map(
            (n) => `
        <div class="notif-item ${n.is_read ? "" : "unread"}">
            <div class="notif-meta">
                <span><span class="sev sev-${n.severity}">${n.severity}</span> &bull; ${n.event_key}</span>
                <span>${new Date(n.created_at).toLocaleTimeString()}</span>
            </div>
            <div class="notif-title">${n.rendered_content.title}</div>
            <div class="notif-body">${n.rendered_content.body}</div>
            ${
                !n.is_read
                    ? `<button class="btn btn-secondary" style="margin-top:8px;" onclick="markRead('${n.id}')">Mark Read</button>`
                    : ""
            }
        </div>
    `
        )
        .join("");
}

async function markRead(id) {
    await fetch(`${NOTIFICATION_API}/api/v1/notifications/${id}/read`, { method: "PATCH" });
    loadInbox();
}

document.getElementById("markAllReadBtn").addEventListener("click", async () => {
    await fetch(`${NOTIFICATION_API}/api/v1/notifications/read-all?user_id=${USER_ID}`, {
        method: "PATCH",
    });
    loadInbox();
});

document.getElementById("unreadOnlyToggle").addEventListener("change", loadInbox);

// Trigger Preset via Server 1 (Producer Server)
window.triggerPreset = async function (endpoint, body) {
    const out = document.getElementById("triggerOutput");
    out.textContent = `Sending POST ${PRODUCER_API}${endpoint}...`;
    try {
        const res = await fetch(`${PRODUCER_API}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
        loadInbox();
    } catch (err) {
        out.textContent = `Error reaching Producer Server (${PRODUCER_API}): ${err.message}`;
    }
};

// Load & Save User Settings
async function loadSettings() {
    const res = await fetch(`${NOTIFICATION_API}/api/v1/notification-settings/me?user_id=${USER_ID}`);
    const { settings } = await res.json();

    const container = document.getElementById("settingsList");
    container.innerHTML = settings
        .map((s) => {
            const hasInApp = s.enabled_channels.includes("IN_APP");
            const hasPush = s.enabled_channels.includes("PUSH");
            const onlyVuln = Boolean(s.filter_conditions?.only_if_vuln_found);
            const minSev = s.filter_conditions?.min_severity || "INFO";

            return `
            <div class="card setting-row">
                <div>
                    <h3>${s.event_key} ${s.is_mandatory ? '<span class="badge">MANDATORY</span>' : ""}</h3>
                    <p>${s.description}</p>
                </div>
                <div class="setting-controls">
                    <label><input type="checkbox" id="en-${s.setting_id}" ${s.is_enabled ? "checked" : ""} ${s.is_mandatory ? "disabled" : ""}/> Enabled</label>
                    <label><input type="checkbox" id="ch-inapp-${s.setting_id}" ${hasInApp ? "checked" : ""} ${s.is_mandatory ? "disabled" : ""}/> IN_APP</label>
                    <label><input type="checkbox" id="ch-push-${s.setting_id}" ${hasPush ? "checked" : ""} ${s.is_mandatory ? "disabled" : ""}/> PUSH</label>
                </div>
                ${
                    !s.is_mandatory
                        ? `
                <div class="setting-controls">
                    <label><input type="checkbox" id="vuln-${s.setting_id}" ${onlyVuln ? "checked" : ""}/> Only if vuln found</label>
                    <label>Min Severity:
                        <select id="sev-${s.setting_id}">
                            ${["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
                                .map((lvl) => `<option value="${lvl}" ${minSev === lvl ? "selected" : ""}>${lvl}</option>`)
                                .join("")}
                        </select>
                    </label>
                </div>
                <button class="btn btn-primary" onclick="saveSetting('${s.setting_id}')">Save Preference</button>
                `
                        : ""
                }
            </div>
        `;
        })
        .join("");
}

window.saveSetting = async function (settingId) {
    const is_enabled = document.getElementById(`en-${settingId}`).checked;
    const enabled_channels = [];
    if (document.getElementById(`ch-inapp-${settingId}`).checked) enabled_channels.push("IN_APP");
    if (document.getElementById(`ch-push-${settingId}`).checked) enabled_channels.push("PUSH");

    const filter_conditions = {
        only_if_vuln_found: document.getElementById(`vuln-${settingId}`).checked,
        min_severity: document.getElementById(`sev-${settingId}`).value,
    };

    await fetch(`${NOTIFICATION_API}/api/v1/notification-settings/me/${settingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: USER_ID, is_enabled, enabled_channels, filter_conditions }),
    });
    showToast("SETTINGS", "Preferences Saved", `Updated rules for ${settingId}`);
};

// Load Templates & Delivery Audit
async function loadAudit() {
    const [delRes, tmplRes] = await Promise.all([
        fetch(`${NOTIFICATION_API}/api/v1/admin/deliveries`),
        fetch(`${NOTIFICATION_API}/api/v1/admin/notification-templates`),
    ]);
    const { deliveries } = await delRes.json();
    const { templates } = await tmplRes.json();

    document.getElementById("deliveryList").innerHTML = deliveries.length
        ? deliveries
              .map(
                  (d) => `
            <div class="notif-item">
                <div class="notif-meta">
                    <span><strong>${d.channel}</strong> &bull; ${d.event_key} &bull; <span class="sev sev-${d.severity}">${d.status}</span></span>
                    <span>${new Date(d.created_at).toLocaleTimeString()}</span>
                </div>
            </div>
        `
              )
              .join("")
        : `<div class="card"><p>No deliveries recorded yet.</p></div>`;

    document.getElementById("templateList").innerHTML = templates
        .map(
            (t) => `
        <div class="notif-item">
            <div class="notif-meta">
                <span><strong>${t.event_key}</strong> &bull; Channel: <code>${t.channel}</code></span>
                <span>v${t.version} (${t.locale})</span>
            </div>
            <div class="notif-title">${t.subject_template}</div>
            <div class="notif-body">${t.body_template}</div>
        </div>
    `
        )
        .join("");
}

document.getElementById("refreshAuditBtn").addEventListener("click", loadAudit);

// Init
connectSSE();
loadInbox();
