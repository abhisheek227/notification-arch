const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "notifications.db");
const db = new DatabaseSync(DB_PATH);

// Enable foreign keys & WAL mode for concurrency
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS notification_setting (
            id TEXT PRIMARY KEY,
            event_key TEXT UNIQUE NOT NULL,
            category TEXT NOT NULL,
            description TEXT NOT NULL,
            default_channels TEXT NOT NULL,
            is_mandatory INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            default_rules TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notification_template (
            id TEXT PRIMARY KEY,
            setting_id TEXT NOT NULL REFERENCES notification_setting(id) ON DELETE CASCADE,
            channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'PUSH')),
            locale TEXT DEFAULT 'en',
            version INTEGER DEFAULT 1,
            subject_template TEXT,
            body_template TEXT NOT NULL,
            action_url_template TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_template_active
            ON notification_template (setting_id, channel, locale)
            WHERE is_active = 1;

        CREATE TABLE IF NOT EXISTS notification_user_setting (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            setting_id TEXT NOT NULL REFERENCES notification_setting(id) ON DELETE CASCADE,
            is_enabled INTEGER DEFAULT 1,
            enabled_channels TEXT NOT NULL,
            frequency TEXT DEFAULT 'IMMEDIATE',
            filter_conditions TEXT DEFAULT '{}',
            quiet_hours TEXT,
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE (tenant_id, user_id, setting_id)
        );

        CREATE TABLE IF NOT EXISTS notification (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            setting_id TEXT NOT NULL REFERENCES notification_setting(id),
            template_id TEXT REFERENCES notification_template(id),
            idempotency_key TEXT UNIQUE,
            severity TEXT DEFAULT 'INFO',
            payload TEXT NOT NULL,
            rendered_content TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            read_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_notif_inbox
            ON notification (tenant_id, user_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_notif_unread
            ON notification (tenant_id, user_id)
            WHERE is_read = 0;

        CREATE TABLE IF NOT EXISTS notification_delivery (
            id TEXT PRIMARY KEY,
            notification_id TEXT NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
            channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'PUSH')),
            status TEXT NOT NULL,
            retry_count INTEGER DEFAULT 0,
            last_error TEXT,
            scheduled_for TEXT,
            sent_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);

    seedDefaults();
}

function seedDefaults() {
    const existing = db.prepare("SELECT COUNT(*) as cnt FROM notification_setting").get();
    if (existing.cnt > 0) return;

    const settings = [
        {
            id: "set-vuln-found",
            event_key: "vuln.found",
            category: "SECURITY",
            description: "Alert when a security vulnerability is discovered in a scan",
            default_channels: JSON.stringify(["IN_APP", "PUSH"]),
            is_mandatory: 0,
            is_active: 1,
            default_rules: JSON.stringify({ min_severity: "LOW" }),
            templates: [
                {
                    channel: "IN_APP",
                    subject: "[{{severity}}] Vulnerability found in {{asset}}",
                    body: "{{vuln_name}} ({{cve}}) detected during scan #{{scan_id}}. {{vuln_count}} issue(s) require attention.",
                    action_url: "/scans/{{scan_id}}/vulns",
                },
                {
                    channel: "PUSH",
                    subject: "Security Alert: {{severity}} Vulnerability",
                    body: "{{vuln_name}} detected on {{asset}} ({{cve}}).",
                    action_url: "/scans/{{scan_id}}/vulns",
                },
            ],
        },
        {
            id: "set-scan-completed",
            event_key: "scan.completed",
            category: "SCAN",
            description: "Notify when an automated security scan finishes",
            default_channels: JSON.stringify(["IN_APP"]),
            is_mandatory: 0,
            is_active: 1,
            default_rules: JSON.stringify({ only_if_vuln_found: false }),
            templates: [
                {
                    channel: "IN_APP",
                    subject: "Scan completed for {{asset}}",
                    body: "Scan #{{scan_id}} finished in {{duration}}. Vulnerabilities found: {{vuln_count}}.",
                    action_url: "/scans/{{scan_id}}",
                },
                {
                    channel: "PUSH",
                    subject: "Scan Finished: {{asset}}",
                    body: "{{vuln_count}} vulnerabilities found on {{asset}}.",
                    action_url: "/scans/{{scan_id}}",
                },
            ],
        },
        {
            id: "set-auth-login",
            event_key: "auth.new_login",
            category: "SYSTEM",
            description: "Mandatory security alert on new device login",
            default_channels: JSON.stringify(["IN_APP", "PUSH"]),
            is_mandatory: 1,
            is_active: 1,
            default_rules: JSON.stringify({}),
            templates: [
                {
                    channel: "IN_APP",
                    subject: "New login detected from {{location}}",
                    body: "Your account was accessed from {{device}} (IP: {{ip}}). If this wasn't you, secure your account immediately.",
                    action_url: "/settings/security",
                },
                {
                    channel: "PUSH",
                    subject: "New Login Alert",
                    body: "Sign-in from {{device}} in {{location}}.",
                    action_url: "/settings/security",
                },
            ],
        },
    ];

    const insertSetting = db.prepare(`
        INSERT INTO notification_setting (id, event_key, category, description, default_channels, is_mandatory, is_active, default_rules)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTemplate = db.prepare(`
        INSERT INTO notification_template (id, setting_id, channel, locale, version, subject_template, body_template, action_url_template, is_active)
        VALUES (?, ?, ?, 'en', 1, ?, ?, ?, 1)
    `);

    for (const s of settings) {
        insertSetting.run(
            s.id,
            s.event_key,
            s.category,
            s.description,
            s.default_channels,
            s.is_mandatory,
            s.is_active,
            s.default_rules
        );
        for (const t of s.templates) {
            insertTemplate.run(
                crypto.randomUUID(),
                s.id,
                t.channel,
                t.subject,
                t.body,
                t.action_url
            );
        }
    }
}

initSchema();

module.exports = { db };
