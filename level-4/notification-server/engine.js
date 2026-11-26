// Simple in-memory TTL cache (replaces Redis for local 2-server setup)
class TTLCache {
    constructor(defaultTtlMs = 60_000) {
        this.defaultTtlMs = defaultTtlMs;
        this.store = new Map();
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key, value, ttlMs = this.defaultTtlMs) {
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }

    del(key) {
        this.store.delete(key);
    }

    // SETNX-style helper for idempotency / deduplication
    setIfAbsent(key, value, ttlMs = 300_000) {
        if (this.get(key) !== undefined) return false;
        this.set(key, value, ttlMs);
        return true;
    }
}

const SEVERITY_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Logic-less {{variable}} template renderer
function renderTemplateString(template, payload, escape = false) {
    if (!template) return "";
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
        const val = payload[key];
        if (val === undefined || val === null) return "";
        return escape ? escapeHtml(val) : String(val);
    });
}

function renderTemplate(templateRow, payload) {
    return {
        title: renderTemplateString(templateRow.subject_template, payload, false),
        body: renderTemplateString(templateRow.body_template, payload, false),
        action_url: renderTemplateString(templateRow.action_url_template, payload, false),
    };
}

// Preference & Condition Evaluation Engine
function evaluatePreferences(setting, userSetting, payload, severity = "INFO") {
    if (!setting.is_active) {
        return { allowed: false, reason: "Setting is globally inactive", channels: [] };
    }

    const defaultChannels = JSON.parse(setting.default_channels || '["IN_APP"]');
    const defaultRules = JSON.parse(setting.default_rules || "{}");

    // Mandatory notifications bypass user opt-out & filters
    if (setting.is_mandatory) {
        return { allowed: true, channels: defaultChannels, frequency: "IMMEDIATE" };
    }

    const isEnabled = userSetting ? Boolean(userSetting.is_enabled) : true;
    if (!isEnabled) {
        return { allowed: false, reason: "Disabled by user preference", channels: [] };
    }

    const channels = userSetting
        ? JSON.parse(userSetting.enabled_channels || "[]")
        : defaultChannels;

    // Restrict strictly to IN_APP and PUSH
    const validChannels = channels.filter((c) => c === "IN_APP" || c === "PUSH");
    if (validChannels.length === 0) {
        return { allowed: false, reason: "No active channels enabled", channels: [] };
    }

    const filters = {
        ...defaultRules,
        ...(userSetting ? JSON.parse(userSetting.filter_conditions || "{}") : {}),
    };

    // Condition 1: only_if_vuln_found
    if (filters.only_if_vuln_found) {
        const vulnCount = Number(payload.vuln_count ?? 0);
        if (vulnCount <= 0) {
            return {
                allowed: false,
                reason: "Suppressed: user enabled 'only_if_vuln_found' and vuln_count is 0",
                channels: [],
            };
        }
    }

    // Condition 2: min_severity
    if (filters.min_severity) {
        const eventRank = SEVERITY_RANK[String(severity).toUpperCase()] ?? 0;
        const minRank = SEVERITY_RANK[String(filters.min_severity).toUpperCase()] ?? 0;
        if (eventRank < minRank) {
            return {
                allowed: false,
                reason: `Suppressed: severity ${severity} is below user minimum ${filters.min_severity}`,
                channels: [],
            };
        }
    }

    const frequency = userSetting?.frequency || "IMMEDIATE";
    return { allowed: true, channels: validChannels, frequency };
}

module.exports = {
    TTLCache,
    renderTemplate,
    evaluatePreferences,
};
