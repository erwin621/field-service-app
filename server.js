'use strict';
require('dotenv').config();

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const axios     = require('axios');
const FormData  = require('form-data');
const bcrypt    = require('bcryptjs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase (optional — falls back to local JSON) ────────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );
    console.log('✅  Supabase connected');
} else {
    console.log('⚠️   Supabase not configured — using local database.json');
}

// ─── Telegram ───────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Local JSON DB (fallback when Supabase is not configured) ───────────────
const DB_PATH = path.join(__dirname, 'database.json');

// NOTE: readDB/writeDB were referenced throughout this file but never
// defined, so the no-Supabase fallback path would crash. Added here so the
// local-JSON mode (and the new sync engine's local fallback) actually works.
function readDB() {
    if (!fs.existsSync(DB_PATH)) {
        return { users: [], tickets: [], task_batches: [], task_sync_logs: [], route_reservations: [], technician_statuses: [] };
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db  = raw.trim() ? JSON.parse(raw) : {};
    db.users                 = db.users                 || [];
    db.tickets               = db.tickets               || [];
    db.task_batches          = db.task_batches          || [];
    db.task_sync_logs        = db.task_sync_logs        || [];
    db.route_reservations    = db.route_reservations    || [];
    db.technician_statuses   = db.technician_statuses   || [];
    return db;
}

// ─── Route Reservation helpers ──────────────────────────────────────────────
const ROUTE_EXPIRY_HOURS = 4; // default — reservations expire after 4 hrs inactivity

function nowIso() { return new Date().toISOString(); }

/** Returns the active (non-expired) reservation for a given tech (local mode). */
function getActiveRouteLocal(db, technicianId) {
    const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    return db.route_reservations.find(r =>
        r.technician_id === technicianId &&
        r.status === 'ACTIVE' &&
        r.last_activity >= cutoff
    ) || null;
}

/** Lazily expires overdue reservations and returns the cleaned list (local mode). */
function expireRoutesLocal(db) {
    const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    let changed = false;
    db.route_reservations.forEach(r => {
        if (r.status === 'ACTIVE' && r.last_activity < cutoff) {
            r.status = 'EXPIRED';
            r.expired_at = nowIso();
            changed = true;
        }
    });
    if (changed) writeDB(db);
    return db;
}

/** Returns a map of ticketId → { reserved_by, reserved_by_name } for ACTIVE reservations (local). */
function buildReservationMapLocal(db) {
    const map = {};
    const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    for (const r of db.route_reservations) {
        if (r.status !== 'ACTIVE' || r.last_activity < cutoff) continue;
        for (const sid of (r.site_ids || [])) {
            map[sid] = { reserved_by: r.technician_id, reserved_by_name: r.technician_name };
        }
    }
    return map;
}

/** Get or create a technician status record (local). */
function getTechStatusLocal(db, technicianId) {
    let rec = db.technician_statuses.find(s => s.technician_id === technicianId);
    if (!rec) {
        rec = { technician_id: technicianId, is_on_duty: true, last_activity: nowIso(), current_gps: null };
        db.technician_statuses.push(rec);
    }
    return rec;
}
function writeDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── Supabase helper: get all tickets ─────────────────
async function getAllTickets() {
    const { data, error } = await supabase
        .from('tickets')
        .select('*, assigned_user:users(display_name, tech_code)')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
}

// ─── Supabase helper: get user by tech_code ────────────
async function getUserByTechCode(techCode) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('tech_code', techCode)
        .single();
    if (error) throw error;
    return data;
}

// ─── Ticket NUMBER generation (claim-time only — see sync engine below) ────
// Local-mode fallback: a simple in-file sequence. Supabase mode uses the
// generate_ticket_number() Postgres function (atomic, race-free — see
// supabase_migration.sql) via supabase.rpc().
function genTicketNumberLocal(db) {
    db.meta = db.meta || {};
    db.meta.ticketSeq = (db.meta.ticketSeq || 0) + 1;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `FO-${today}-${String(db.meta.ticketSeq).padStart(6, '0')}`;
}

// Escape special HTML characters so user-typed content (notes, reasons, names)
// never breaks Telegram's HTML parse mode
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Simple UUID v4 for local mode (no external dependency)
function generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIELD OPS TASK SYNCHRONIZATION ENGINE
//  -----------------------------------------------------------------------
//  Operates on the existing `tickets` table — there is no separate "tasks"
//  table, because tickets already are the tasks, and every other feature
//  (claim, submit, cancel, reopen, geolocation, Telegram) is built around
//  that table. Status mapping used throughout this engine:
//
//      OPEN      -> OPEN        unclaimed, visible to all technicians
//      CLAIMED   -> ON_GOING    technician accepted the job
//      VISITED   -> COMPLETED   technician submitted proof of work
//      RECOVERED -> RECOVERED   site vanished from a FULL_SNAPSHOT upload
//
//  CANCELLED is pre-existing, unrelated functionality and is never touched
//  by this engine.
//
//  RULES IMPLEMENTED (see SQL migration for schema):
//   - Never DELETE. Every state change is an UPDATE or a guarded INSERT.
//   - Priority escalates one rung at a time: LOW -> MEDIUM -> HIGH -> CRITICAL,
//     capped at CRITICAL. A brand-new site starts at MEDIUM unless the
//     upload row explicitly specifies a priority.
//   - FULL_SNAPSHOT: any currently-active (OPEN/ON_GOING) site missing from
//     the upload is recovered. OPEN -> RECOVERED. ON_GOING (claimed) keeps
//     its status but is flagged recovered_while_claimed so it stays visible
//     in My Jobs with a warning, exactly as claimed tasks must never vanish.
//   - INCREMENTAL_ESCALATION: only escalates sites that are already active
//     and present in this file. Sites missing from the file are NEVER
//     touched, and sites that aren't already tracked are NOT created — this
//     upload type is for re-prioritizing known sites, not reporting new ones.
//   - upload_type is always required from the caller and is never inferred
//     from row count or file size.
// ═══════════════════════════════════════════════════════════════════════════
const PRIORITY_LADDER          = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const DEFAULT_NEW_SITE_PRIORITY = 'MEDIUM';

function escalatePriority(current) {
    const idx  = PRIORITY_LADDER.indexOf(String(current || 'LOW').toUpperCase());
    const next = idx === -1 ? 1 : Math.min(idx + 1, PRIORITY_LADDER.length - 1);
    return PRIORITY_LADDER[next];
}

function normalizeUploadType(t) {
    const v = String(t || '').toUpperCase();
    return (v === 'FULL_SNAPSHOT' || v === 'INCREMENTAL_ESCALATION') ? v : null;
}

async function runTaskSync({ sites, upload_type, batch_name, uploaded_by }) {
    const stats = { created: 0, escalated: 0, recovered: 0, skipped: 0, invalid: 0 };
    const nowIso = () => new Date().toISOString();

    // ── Supabase mode ────────────────────────────────────────────────────
    if (supabase) {
        const { data: batchRow, error: batchErr } = await supabase
            .from('task_batches')
            .insert({
                batch_name,
                upload_type,
                uploaded_by: uploaded_by || null,
                total_tasks: sites.length
            })
            .select('id')
            .single();
        if (batchErr) throw batchErr;
        const batchId = batchRow.id;

        // Walk uploaded rows IN ORDER. A site_id repeated within the same
        // file is treated as a separate sighting (this preserves the app's
        // original "duplicate row in one batch escalates priority" demo
        // behavior used by the Quick Simulation button).
        for (const site of sites) {
            if (!site || !site.site_id || !site.site_name) { stats.invalid++; continue; }
            const siteId = String(site.site_id).trim();

            const { data: existing, error: findErr } = await supabase
                .from('tickets')
                .select('id, priority, recurrence_count')
                .eq('site_id', siteId)
                .in('status', ['OPEN', 'ON_GOING'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            if (findErr) throw findErr;

            if (existing) {
                const { error: updErr } = await supabase.from('tickets').update({
                    priority:          escalatePriority(existing.priority),
                    recurrence_count:  (existing.recurrence_count || 1) + 1,
                    last_seen_batch_id: batchId,
                    updated_at:        nowIso()
                }).eq('id', existing.id);
                if (updErr) throw updErr;
                stats.escalated++;
            } else {
                if (upload_type === 'INCREMENTAL_ESCALATION') { stats.skipped++; continue; }
                const { error: insErr } = await supabase.from('tickets').insert({
                    site_id:     siteId,
                    site_name:   site.site_name,
                    locality:    site.locality    || '',
                    address:     site.address     || '',
                    coordinates: site.coordinates || '',
                    status:      'OPEN',
                    priority:    (site.priority || DEFAULT_NEW_SITE_PRIORITY).toUpperCase(),
                    ticket_id:   null, // ticket NUMBER only exists from claim onward
                    recurrence_count:   1,
                    first_seen_batch_id: batchId,
                    last_seen_batch_id:  batchId
                });
                if (insErr) throw insErr;
                stats.created++;
            }
        }

        // Recovery sweep — FULL_SNAPSHOT only. "Missing sites must NOT be
        // touched" for INCREMENTAL_ESCALATION, so this block is skipped
        // entirely for that upload type.
        if (upload_type === 'FULL_SNAPSHOT') {
            const incomingIds = new Set(
                sites.filter(s => s && s.site_id).map(s => String(s.site_id).trim())
            );
            const { data: active, error: activeErr } = await supabase
                .from('tickets').select('id, site_id, status').in('status', ['OPEN', 'ON_GOING']);
            if (activeErr) throw activeErr;

            const toRecoverOpen = [], toFlagClaimed = [];
            for (const t of (active || [])) {
                if (incomingIds.has(String(t.site_id).trim())) continue; // still down — untouched
                if (t.status === 'OPEN') toRecoverOpen.push(t.id);
                else toFlagClaimed.push(t.id); // ON_GOING (claimed) — never removed
            }

            if (toRecoverOpen.length) {
                const { error } = await supabase.from('tickets').update({
                    status: 'RECOVERED', recovered_at: nowIso(), last_seen_batch_id: batchId, updated_at: nowIso()
                }).in('id', toRecoverOpen);
                if (error) throw error;
                stats.recovered += toRecoverOpen.length;
            }
            if (toFlagClaimed.length) {
                // Status intentionally NOT changed — stays ON_GOING (CLAIMED)
                // so it remains visible in My Jobs, per spec.
                const { error } = await supabase.from('tickets').update({
                    recovered_while_claimed: true, recovered_at: nowIso(), updated_at: nowIso()
                }).in('id', toFlagClaimed);
                if (error) throw error;
                stats.recovered += toFlagClaimed.length;
            }
        }

        const { error: logErr } = await supabase.from('task_sync_logs').insert({
            batch_id:        batchId,
            added_count:     stats.created,
            updated_count:   stats.escalated,
            recovered_count: stats.recovered,
            skipped_count:   stats.skipped
        });
        if (logErr) throw logErr;

        return { batchId, stats };
    }

    // ── Local JSON fallback (mirrors the Supabase logic above) ────────────
    const db = readDB();
    const batchId = generateId();
    db.task_batches.push({
        id: batchId, batch_name, upload_type, uploaded_by: uploaded_by || null,
        uploaded_at: nowIso(), total_tasks: sites.length
    });

    for (const site of sites) {
        if (!site || !site.site_id || !site.site_name) { stats.invalid++; continue; }
        const siteId  = String(site.site_id).trim();
        const existing = db.tickets.find(t => t.site_id === siteId && ['OPEN', 'ON_GOING'].includes(t.status));
        if (existing) {
            existing.priority         = escalatePriority(existing.priority);
            existing.recurrence_count = (existing.recurrence_count || 1) + 1;
            existing.last_seen_batch_id = batchId;
            existing.updated_at       = nowIso();
            stats.escalated++;
        } else {
            if (upload_type === 'INCREMENTAL_ESCALATION') { stats.skipped++; continue; }
            db.tickets.push({
                id: generateId(), ticket_id: null,
                site_id: siteId, site_name: site.site_name,
                locality: site.locality || '', address: site.address || '', coordinates: site.coordinates || '',
                status: 'OPEN', priority: (site.priority || DEFAULT_NEW_SITE_PRIORITY).toUpperCase(),
                assigned_to: null, proof_url: [], notes: '',
                cancellation_reason: null, cancelled_by: null,
                recurrence_count: 1, recovered_at: null, recovered_while_claimed: false,
                first_seen_batch_id: batchId, last_seen_batch_id: batchId,
                created_at: nowIso(), updated_at: nowIso()
            });
            stats.created++;
        }
    }

    if (upload_type === 'FULL_SNAPSHOT') {
        const incomingIds = new Set(sites.filter(s => s && s.site_id).map(s => String(s.site_id).trim()));
        for (const t of db.tickets) {
            if (!['OPEN', 'ON_GOING'].includes(t.status)) continue;
            if (incomingIds.has(t.site_id)) continue;
            if (t.status === 'OPEN') {
                t.status = 'RECOVERED'; t.recovered_at = nowIso(); t.last_seen_batch_id = batchId;
            } else {
                t.recovered_while_claimed = true; t.recovered_at = nowIso();
            }
            stats.recovered++;
        }
    }

    db.task_sync_logs.push({
        id: generateId(), batch_id: batchId, added_count: stats.created,
        updated_count: stats.escalated, recovered_count: stats.recovered,
        skipped_count: stats.skipped, created_at: nowIso()
    });
    writeDB(db);
    return { batchId, stats };
}

// ─── File Storage (multer) ──────────────────────────────────────────────────
const upload = multer({
    storage: multer.diskStorage({
        destination(req, file, cb) {
            const dir = path.join(__dirname, 'uploads');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename(req, file, cb) {
            cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`);
        }
    }),
    limits: { files: 5, fileSize: 50 * 1024 * 1024 }
});

// ─── Supabase helper: look up a user by their tech_code ────────────────────
async function getUserByTechCode(techCode) {
    if (!supabase) {
        // Local mode: treat the tech code itself as the user ID
        return { id: techCode, display_name: techCode, tech_code: techCode };
    }
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('tech_code', techCode)
        .single();
    if (error) throw new Error(`Technician "${techCode}" not found: ${error.message}`);
    return data;
}

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG — exposes non-secret runtime config to the frontend
//  Never put SECRET keys here — ORS key is safe (client-side API, rate-limited)
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
    res.json({
        orsApiKey: process.env.ORS_API_KEY || '',
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/auth/techs  — list of technicians for the login dropdown ──────
app.get('/api/auth/techs', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('users')
                .select('display_name, tech_code')
                .eq('role', 'technician')
                .order('display_name');
            if (error) throw error;
            return res.json(data);
        }
        const db = readDB();
        res.json(
            db.users
                .filter(u => u.role === 'technician')
                .map(u => ({ display_name: u.display_name, tech_code: u.tech_code }))
        );
    } catch (err) {
        console.error('[GET /auth/techs]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/auth/admin/register ─────────────────────────────────────────
app.post('/api/auth/admin/register', async (req, res) => {
    const { display_name, username, password } = req.body;
    if (!display_name || !username || !password)
        return res.status(400).json({ error: 'All fields are required' });
    if (username.trim().length < 3)
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const credential_hash = await bcrypt.hash(password, 10);
    const tc = username.trim().toLowerCase();

    try {
        if (supabase) {
            const { data: ex } = await supabase.from('users').select('id')
                .eq('tech_code', tc).eq('role', 'admin').maybeSingle();
            if (ex) return res.status(409).json({ error: 'Username already taken' });
            const { error } = await supabase.from('users').insert({
                id: generateId(), role: 'admin',
                display_name: display_name.trim(), tech_code: tc, credential_hash
            });
            if (error) throw error;
        } else {
            const db = readDB();
            if (db.users.find(u => u.tech_code === tc && u.role === 'admin'))
                return res.status(409).json({ error: 'Username already taken' });
            db.users.push({
                id: generateId(), role: 'admin',
                display_name: display_name.trim(), tech_code: tc,
                credential_hash, created_at: new Date().toISOString()
            });
            writeDB(db);
        }
        res.json({ message: 'Admin account created successfully' });
    } catch (err) {
        console.error('[POST /auth/admin/register]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/auth/admin/login ────────────────────────────────────────────
app.post('/api/auth/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Username and password required' });
    try {
        let user = null;
        const tc = username.trim().toLowerCase();
        if (supabase) {
            const { data } = await supabase.from('users').select('*')
                .eq('tech_code', tc).eq('role', 'admin').maybeSingle();
            user = data;
        } else {
            const db = readDB();
            user = db.users.find(u => u.tech_code === tc && u.role === 'admin');
        }
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });
        const valid = await bcrypt.compare(password, user.credential_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
        res.json({ id: user.tech_code, display_name: user.display_name, role: 'admin' });
    } catch (err) {
        console.error('[POST /auth/admin/login]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/auth/tech/register ──────────────────────────────────────────
app.post('/api/auth/tech/register', async (req, res) => {
    const { display_name, pin } = req.body;
    if (!display_name || !pin)
        return res.status(400).json({ error: 'Name and PIN are required' });
    if (!/^\d{4,6}$/.test(String(pin)))
        return res.status(400).json({ error: 'PIN must be 4–6 digits' });

    const tech_code       = display_name.trim().replace(/\s+/g, '_');
    const credential_hash = await bcrypt.hash(String(pin), 10);

    try {
        if (supabase) {
            const { data: ex } = await supabase.from('users').select('id')
                .eq('tech_code', tech_code).maybeSingle();
            if (ex) return res.status(409).json({ error: 'A technician with this name already exists' });
            const { error } = await supabase.from('users').insert({
                id: generateId(), role: 'technician',
                display_name: display_name.trim(), tech_code, credential_hash
            });
            if (error) throw error;
        } else {
            const db = readDB();
            if (db.users.find(u => u.tech_code === tech_code))
                return res.status(409).json({ error: 'A technician with this name already exists' });
            db.users.push({
                id: generateId(), role: 'technician',
                display_name: display_name.trim(), tech_code,
                credential_hash, created_at: new Date().toISOString()
            });
            writeDB(db);
        }
        res.json({ message: 'Account created', tech_code, display_name: display_name.trim() });
    } catch (err) {
        console.error('[POST /auth/tech/register]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/auth/tech/login ─────────────────────────────────────────────
app.post('/api/auth/tech/login', async (req, res) => {
    const { tech_code, pin } = req.body;
    if (!tech_code || !pin)
        return res.status(400).json({ error: 'Please select your name and enter your PIN' });
    try {
        let user = null;
        if (supabase) {
            const { data } = await supabase.from('users').select('*')
                .eq('tech_code', tech_code).eq('role', 'technician').maybeSingle();
            user = data;
        } else {
            const db = readDB();
            user = db.users.find(u => u.tech_code === tech_code && u.role === 'technician');
        }
        if (!user) return res.status(401).json({ error: 'Technician not found' });
        const valid = await bcrypt.compare(String(pin), user.credential_hash);
        if (!valid) return res.status(401).json({ error: 'Incorrect PIN. Please try again.' });
        res.json({ id: user.tech_code, display_name: user.display_name, tech_code: user.tech_code, role: 'technician' });
    } catch (err) {
        console.error('[POST /auth/tech/login]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/tickets/open  — all unassigned OPEN tickets
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/open', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .eq('status', 'OPEN')
                .is('assigned_to', null)
                .order('created_at', { ascending: false });
            if (error) throw error;

            // Attach active reservation metadata so the client can render lock badges
            const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
            const { data: routes } = await supabase
                .from('route_reservations')
                .select('technician_id, technician_name, site_ids')
                .eq('status', 'ACTIVE')
                .gte('last_activity', cutoff);

            const resMap = {};
            for (const r of (routes || [])) {
                for (const sid of (r.site_ids || [])) {
                    resMap[sid] = { reserved_by: r.technician_id, reserved_by_name: r.technician_name };
                }
            }
            const enriched = data.map(t => ({
                ...t,
                reservation: resMap[t.id] || null
            }));
            return res.json(enriched);
        }
        let db = readDB();
        db = expireRoutesLocal(db);
        const resMap = buildReservationMapLocal(db);
        const tickets = db.tickets
            .filter(t => t.status === 'OPEN' && !t.assigned_to)
            .map(t => ({ ...t, reservation: resMap[t.id] || null }));
        res.json(tickets);
    } catch (err) {
        console.error('[GET /open]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/tickets/all  — every ticket (admin view, newest first)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/all', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.json(data);
        }
        const { tickets } = readDB();
        res.json([...tickets].reverse());
    } catch (err) {
        console.error('[GET /all]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/tickets/ongoing?technician_id=Tech_Juan
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/ongoing', async (req, res) => {
    const { technician_id } = req.query;
    if (!technician_id) return res.status(400).json({ error: 'Missing technician_id' });
    try {
        if (supabase) {
            const user = await getUserByTechCode(technician_id);
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .eq('status', 'ON_GOING')
                .eq('assigned_to', user.id);
            if (error) throw error;
            return res.json(data);
        }
        const { tickets } = readDB();
        res.json(tickets.filter(t => t.status === 'ON_GOING' && t.assigned_to === technician_id));
    } catch (err) {
        console.error('[GET /ongoing]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/tickets/completed?technician_id=Tech_Juan
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/completed', async (req, res) => {
    const { technician_id } = req.query;
    if (!technician_id) return res.status(400).json({ error: 'Missing technician_id' });
    try {
        if (supabase) {
            const user = await getUserByTechCode(technician_id);
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .eq('status', 'COMPLETED')
                .eq('assigned_to', user.id)
                .order('completed_at', { ascending: false });
            if (error) throw error;
            return res.json(data);
        }
        const { tickets } = readDB();
        res.json(
            tickets.filter(t => t.status === 'COMPLETED' && t.assigned_to === technician_id)
        );
    } catch (err) {
        console.error('[GET /completed]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/tickets/cancelled?technician_id=Tech_Juan
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/cancelled', async (req, res) => {
    const { technician_id } = req.query;
    if (!technician_id) return res.status(400).json({ error: 'Missing technician_id' });
    try {
        if (supabase) {
            const user = await getUserByTechCode(technician_id);
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .eq('status', 'CANCELLED')
                .or(`assigned_to.eq.${user.id},cancelled_by.eq.${technician_id}`)
                .order('cancelled_at', { ascending: false });
            if (error) throw error;
            return res.json(data);
        }
        const { tickets } = readDB();
        res.json(
            tickets.filter(t =>
                t.status === 'CANCELLED' &&
                (t.assigned_to === technician_id || t.cancelled_by === technician_id)
            )
        );
    } catch (err) {
        console.error('[GET /cancelled]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/tickets/recovered — admin audit view
//  Every site no longer active because it disappeared from the latest
//  FULL_SNAPSHOT — whether it was unclaimed (status=RECOVERED) or already
//  claimed by a technician (status stays ON_GOING, recovered_while_claimed
//  = true). Combines both so admins have a single audit trail.
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tickets/recovered', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .or('status.eq.RECOVERED,recovered_while_claimed.eq.true')
                .order('recovered_at', { ascending: false });
            if (error) throw error;
            return res.json(data);
        }
        const { tickets } = readDB();
        res.json(
            tickets
                .filter(t => t.status === 'RECOVERED' || t.recovered_while_claimed)
                .sort((a, b) => new Date(b.recovered_at || 0) - new Date(a.recovered_at || 0))
        );
    } catch (err) {
        console.error('[GET /recovered]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/claim
//  body: { id, technician_id }
//
//  Looked up by the row's internal `id`, NOT the ticket number — an
//  unclaimed (OPEN) task has ticket_id = NULL right up until this call.
//  The ticket number is minted here, and ONLY here. If one already exists
//  (e.g. a retried request) it is reused — never replaced, never duplicated.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/claim', async (req, res) => {
    // Accept `id` (current) or a legacy `ticket_id` body field with the same
    // value, in case an older cached client is still in the field during a
    // deploy rollout. Either way this must be the row's internal id.
    const id = req.body.id || req.body.ticket_id;
    const { technician_id } = req.body;
    if (!id || !technician_id)
        return res.status(400).json({ error: 'Missing id or technician_id' });
    try {
        if (supabase) {
            const user = await getUserByTechCode(technician_id);

            const { data: existing, error: findErr } = await supabase
                .from('tickets').select('id, status, ticket_id').eq('id', id).maybeSingle();
            if (findErr) throw findErr;
            if (!existing || existing.status !== 'OPEN')
                return res.status(409).json({ error: 'Ticket is no longer available' });

            // Check route reservation — only block if reserved by ANOTHER technician
            const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
            const { data: routes } = await supabase
                .from('route_reservations')
                .select('technician_id, technician_name, site_ids')
                .eq('status', 'ACTIVE')
                .gte('last_activity', cutoff);
            for (const r of (routes || [])) {
                if ((r.site_ids || []).includes(id) && r.technician_id !== technician_id) {
                    return res.status(409).json({
                        error: `This site is reserved by ${r.technician_name}. Wait for them to release it.`
                    });
                }
            }

            // Immutable ticket number — generate once, on claim, never again
            let ticketNumber = existing.ticket_id;
            if (!ticketNumber) {
                const { data: generated, error: genErr } = await supabase.rpc('generate_ticket_number');
                if (genErr) throw genErr;
                ticketNumber = generated;
            }

            const { error } = await supabase.from('tickets').update({
                status:      'ON_GOING',
                assigned_to: user.id,
                claimed_at:  new Date().toISOString(),
                ticket_id:   ticketNumber
            }).eq('id', id);
            if (error) throw error;

            // Move this site from "reserved" to "claimed" on any active route of the claiming tech
            // (keeps it in the route for progress display, but no longer locks it for others)
            await supabase.from('route_reservations')
                .select('id, site_ids, claimed_ids')
                .eq('technician_id', technician_id)
                .eq('status', 'ACTIVE')
                .then(async ({ data: myRoutes }) => {
                    for (const r of (myRoutes || [])) {
                        if (!(r.site_ids || []).includes(id)) continue;
                        const newIds = (r.site_ids || []).filter(s => s !== id);
                        const newClaimed = [...(r.claimed_ids || []), id];
                        await supabase.from('route_reservations').update({
                            site_ids: newIds,
                            claimed_ids: newClaimed,
                            last_activity: new Date().toISOString()
                        }).eq('id', r.id);
                    }
                });

            return res.json({
                message:   `Ticket ${ticketNumber} claimed by ${user.display_name}`,
                ticket_id: ticketNumber
            });
        }
        // Local fallback
        const db = readDB();
        expireRoutesLocal(db);
        const t  = db.tickets.find(x => x.id === id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        if (t.status !== 'OPEN')
            return res.status(409).json({ error: 'Ticket is no longer available' });

        // Check reservation by another tech
        const resMap = buildReservationMapLocal(db);
        if (resMap[id] && resMap[id].reserved_by !== technician_id) {
            return res.status(409).json({
                error: `This site is reserved by ${resMap[id].reserved_by_name}. Wait for them to release it.`
            });
        }

        if (!t.ticket_id) t.ticket_id = genTicketNumberLocal(db);
        t.status      = 'ON_GOING';
        t.assigned_to = technician_id;
        t.claimed_at  = new Date().toISOString();

        // Move this site from "reserved" to "claimed" on the tech's active route
        // (keeps it in the route for progress display, but no longer locks it for others)
        const myRoute = getActiveRouteLocal(db, technician_id);
        if (myRoute && (myRoute.site_ids || []).includes(id)) {
            myRoute.site_ids = (myRoute.site_ids || []).filter(s => s !== id);
            myRoute.claimed_ids = [...(myRoute.claimed_ids || []), id];
            myRoute.last_activity = nowIso();
        }

        writeDB(db);
        res.json({ message: `Ticket ${t.ticket_id} claimed by ${technician_id}`, ticket_id: t.ticket_id });
    } catch (err) {
        console.error('[POST /claim]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/submit  (multipart/form-data)
//  fields : id, technician_id, notes
//  files  : proof[] (max 5, max 50 MB each)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/submit', upload.array('proof', 5), async (req, res) => {
    const id = req.body.id || req.body.ticket_id;
    const { technician_id, notes } = req.body;
    if (!id || !technician_id || !req.files?.length)
        return res.status(400).json({ error: 'Missing id, technician_id, or proof files' });
    try {
        let proofUrls    = [];
        let ticketNumber = id; // fallback label for Telegram/storage if lookup is thin
        let siteId       = '';  // hoisted — needed by sendTelegramProof outside if/else
        let siteName     = '';

        if (supabase) {
            const user = await getUserByTechCode(technician_id);

            const { data: tktRow } = await supabase
                .from('tickets').select('ticket_id, site_id, site_name').eq('id', id).maybeSingle();
            if (!tktRow) return res.status(404).json({ error: 'Ticket not found' });
            ticketNumber = tktRow.ticket_id || ticketNumber;
            siteId   = tktRow.site_id   || '';
            siteName = tktRow.site_name  || '';

            for (const file of req.files) {
                const storagePath = `${ticketNumber}/${Date.now()}-${file.originalname.replace(/\s/g, '_')}`;
                const fileBuffer  = fs.readFileSync(file.path);

                const { error: upErr } = await supabase.storage
                    .from('proofs')
                    .upload(storagePath, fileBuffer, { contentType: file.mimetype, upsert: true });

                if (upErr) { console.error('Storage upload error:', upErr.message); continue; }

                const { data: { publicUrl } } = supabase.storage
                    .from('proofs')
                    .getPublicUrl(storagePath);

                proofUrls.push(publicUrl);

                // Record proof metadata — ticket_proofs.ticket_id references tickets.id
                await supabase.from('ticket_proofs').insert({
                    ticket_id:   id,
                    file_url:    publicUrl,
                    file_type:   file.mimetype.startsWith('video') ? 'video' : 'image',
                    file_name:   file.originalname,
                    uploaded_by: user.id
                });
            }

            const { error } = await supabase.from('tickets').update({
                status:       'COMPLETED',
                proof_url:    proofUrls,
                notes:        notes || '',
                completed_at: new Date().toISOString()
            }).eq('id', id);
            if (error) throw error;

        } else {
            // Local fallback — store files in /uploads
            proofUrls = req.files.map(f => `/uploads/${f.filename}`);
            const db = readDB();
            const t  = db.tickets.find(x => x.id === id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            ticketNumber   = t.ticket_id || ticketNumber;
            siteId   = t.site_id   || '';
            siteName = t.site_name  || '';
            t.status       = 'COMPLETED';
            t.proof_url    = proofUrls;
            t.notes        = notes || '';
            t.completed_at = new Date().toISOString();
            writeDB(db);
        }

        // Send proof to Telegram (non-blocking)
        sendTelegramProof(ticketNumber, technician_id, notes, req.files, siteId, siteName).catch(() => {});

        res.json({ message: 'Job submitted and marked as Completed.' });
    } catch (err) {
        console.error('[POST /submit]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/cancel
//  body: { id, cancelled_by, reason }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/cancel', async (req, res) => {
    const id = req.body.id || req.body.ticket_id;
    const { cancelled_by, reason } = req.body;
    if (!id || !reason)
        return res.status(400).json({ error: 'Missing id or reason' });
    try {
        let ticketNumber = id;
        if (supabase) {
            const { data: row } = await supabase.from('tickets').select('ticket_id').eq('id', id).maybeSingle();
            ticketNumber = row?.ticket_id || ticketNumber;

            const { error } = await supabase.from('tickets').update({
                status:               'CANCELLED',
                cancellation_reason:  reason,
                cancelled_by:         cancelled_by || 'unknown',
                cancelled_at:         new Date().toISOString(),
                assigned_to:          null
            }).eq('id', id).in('status', ['OPEN', 'ON_GOING']);
            if (error) throw error;
        } else {
            const db = readDB();
            const t  = db.tickets.find(x => x.id === id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            if (!['OPEN', 'ON_GOING'].includes(t.status))
                return res.status(409).json({ error: 'Only OPEN or ON_GOING tickets can be cancelled' });
            ticketNumber           = t.ticket_id || ticketNumber;
            t.status              = 'CANCELLED';
            t.cancellation_reason = reason;
            t.cancelled_by        = cancelled_by || 'unknown';
            t.cancelled_at        = new Date().toISOString();
            writeDB(db);
        }

        // Telegram notification (non-blocking)
        if (BOT_TOKEN && CHAT_ID) {
            axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id:    CHAT_ID,
                parse_mode: 'HTML',
                text: `🚫 <b>Job Cancelled</b>\n` +
                      `🎫 Ticket: <code>${escapeHtml(ticketNumber)}</code>\n` +
                      `👷 By: ${escapeHtml(cancelled_by || 'unknown')}\n` +
                      `📝 Reason: ${escapeHtml(reason)}`
            }).catch(e => console.warn('[Telegram] Cancel notification failed:', e.message));
        }

        res.json({ message: `Ticket ${ticketNumber} cancelled.` });
    } catch (err) {
        console.error('[POST /cancel]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/reopen   (admin only)
//  body: { id }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/reopen', async (req, res) => {
    const id = req.body.id || req.body.ticket_id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
        if (supabase) {
            const { error } = await supabase.from('tickets').update({
                status:              'OPEN',
                assigned_to:         null,
                cancellation_reason: null,
                cancelled_by:        null,
                cancelled_at:        null,
                claimed_at:          null
                // ticket_id intentionally left untouched: ticket numbers are
                // permanent and immutable once minted, even across reopen.
            }).eq('id', id);
            if (error) throw error;
        } else {
            const db = readDB();
            const t  = db.tickets.find(x => x.id === id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            t.status              = 'OPEN';
            t.assigned_to         = null;
            t.cancellation_reason = null;
            t.cancelled_by        = null;
            t.cancelled_at        = null;
            t.claimed_at          = null;
            writeDB(db);
        }
        res.json({ message: `Ticket re-opened as OPEN.` });
    } catch (err) {
        console.error('[POST /reopen]', err.message);
        res.status(500).json({ error: err.message });

    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/batch-upload
//  body: { sites: [...], upload_type: 'FULL_SNAPSHOT' | 'INCREMENTAL_ESCALATION',
//          batch_name?, uploaded_by? }
//
//  upload_type is MANDATORY and is never inferred from file size or row
//  count — a one-site upload could mean either upload type, so the admin
//  must always say which one this is.
//
//  FULL_SNAPSHOT          — this file is the complete list of currently-down
//                            sites. Anything active but missing is recovered.
//  INCREMENTAL_ESCALATION — this file only re-prioritizes the sites listed.
//                            Everything else is left completely untouched.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/batch-upload', async (req, res) => {
    const { sites, upload_type, batch_name, uploaded_by } = req.body;
    if (!Array.isArray(sites) || !sites.length)
        return res.status(400).json({ error: 'sites array is required' });

    const normalizedType = normalizeUploadType(upload_type);
    if (!normalizedType) {
        return res.status(400).json({
            error: 'upload_type is required and must be exactly "FULL_SNAPSHOT" or ' +
                   '"INCREMENTAL_ESCALATION". It is never inferred from the file.'
        });
    }

    try {
        const { stats } = await runTaskSync({
            sites,
            upload_type: normalizedType,
            batch_name:  batch_name || `Upload — ${new Date().toISOString()}`,
            uploaded_by: uploaded_by || 'admin'
        });

        const parts = [`Created: ${stats.created}`, `Escalated: ${stats.escalated}`];
        if (normalizedType === 'FULL_SNAPSHOT') parts.push(`Recovered: ${stats.recovered}`);
        if (stats.skipped) parts.push(`Skipped (not currently tracked): ${stats.skipped}`);
        if (stats.invalid) parts.push(`Invalid rows: ${stats.invalid}`);

        res.json({
            message: `${normalizedType === 'FULL_SNAPSHOT' ? 'Full snapshot' : 'Incremental escalation'} ` +
                      `processed — ${parts.join(' · ')}`,
            upload_type: normalizedType,
            stats
        });
    } catch (err) {
        console.error('[POST /batch-upload]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/single-site  — add ONE new site ticket
//
//  REJECTION RULES (all checked before insert):
//   1. site_id has an active OPEN ticket    → 409 Conflict
//   2. site_id has an ON_GOING ticket       → 409 Conflict
//   3. site_id has a COMPLETED ticket whose
//      completed_at is within the last 15 days → 409 Conflict
//
//  All other statuses (CANCELLED, RECOVERED, older COMPLETED) are
//  ignored — re-adding those sites is allowed.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/single-site', async (req, res) => {
    const { site_id, site_name, locality, address, coordinates, priority, uploaded_by } = req.body;
    if (!site_id || !site_name)
        return res.status(400).json({ error: 'site_id and site_name are required' });

    const siteId         = String(site_id).trim();
    const now            = new Date();
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();

    try {
        if (supabase) {
            // ── Rule 1 & 2: OPEN or ON_GOING already exists ───────────────
            const { data: activeRows, error: ae } = await supabase
                .from('tickets')
                .select('id, status')
                .eq('site_id', siteId)
                .in('status', ['OPEN', 'ON_GOING'])
                .limit(1);
            if (ae) throw ae;

            if (activeRows && activeRows.length) {
                const s = activeRows[0].status;
                return res.status(409).json({
                    error: `Site ${siteId} already has an ${s === 'OPEN' ? 'Open' : 'On-Going'} ticket. ` +
                           `It cannot be added again until that ticket is resolved.`
                });
            }

            // ── Rule 3: COMPLETED within the last 15 days ─────────────────
            const { data: recentRows, error: re } = await supabase
                .from('tickets')
                .select('id, completed_at')
                .eq('site_id', siteId)
                .eq('status', 'COMPLETED')
                .gte('completed_at', fifteenDaysAgo)
                .limit(1);
            if (re) throw re;

            if (recentRows && recentRows.length) {
                const doneAt = recentRows[0].completed_at
                    ? new Date(recentRows[0].completed_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'recently';
                return res.status(409).json({
                    error: `Site ${siteId} was completed on ${doneAt} — within the 15-day cooldown. ` +
                           `It can be re-added after the cooldown expires.`
                });
            }

            // ── All clear: insert ──────────────────────────────────────────
            const { error: insErr } = await supabase.from('tickets').insert({
                site_id:     siteId,
                site_name:   site_name.trim(),
                locality:    locality    || '',
                address:     address     || '',
                coordinates: coordinates || '',
                status:      'OPEN',
                priority:    (priority || 'MEDIUM').toUpperCase(),
                ticket_id:   null,
                recurrence_count:    1,
                recovered_at:        null,
                recovered_while_claimed: false
            });
            if (insErr) throw insErr;

        } else {
            // ── Local JSON fallback ────────────────────────────────────────
            const db = readDB();

            const active = db.tickets.find(t =>
                t.site_id === siteId && ['OPEN', 'ON_GOING'].includes(t.status)
            );
            if (active) {
                const s = active.status;
                return res.status(409).json({
                    error: `Site ${siteId} already has an ${s === 'OPEN' ? 'Open' : 'On-Going'} ticket. ` +
                           `It cannot be added again until that ticket is resolved.`
                });
            }

            const fifteenDaysAgoMs = now.getTime() - 15 * 24 * 60 * 60 * 1000;
            const recentDone = db.tickets.find(t =>
                t.site_id === siteId &&
                t.status  === 'COMPLETED' &&
                t.completed_at &&
                new Date(t.completed_at).getTime() >= fifteenDaysAgoMs
            );
            if (recentDone) {
                const doneAt = recentDone.completed_at
                    ? new Date(recentDone.completed_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'recently';
                return res.status(409).json({
                    error: `Site ${siteId} was completed on ${doneAt} — within the 15-day cooldown. ` +
                           `It can be re-added after the cooldown expires.`
                });
            }

            db.tickets.push({
                id: generateId(), ticket_id: null,
                site_id: siteId, site_name: site_name.trim(),
                locality: locality || '', address: address || '', coordinates: coordinates || '',
                status: 'OPEN', priority: (priority || 'MEDIUM').toUpperCase(),
                assigned_to: null, proof_url: [], notes: '',
                cancellation_reason: null, cancelled_by: null,
                recurrence_count: 1, recovered_at: null, recovered_while_claimed: false,
                created_at: now.toISOString(), updated_at: now.toISOString()
            });
            writeDB(db);
        }

        res.json({ message: `✓ Site ${siteId} — ${site_name} added as a new OPEN ticket.` });
    } catch (err) {
        console.error('[POST /single-site]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Telegram: send proof files ─────────────────────────────────────────────
//
//  Fixes applied vs original:
//  1. Single-file uploads use sendPhoto / sendVideo — sendMediaGroup requires ≥ 2
//  2. FormData.append now passes { filename, contentType } so Telegram correctly
//     identifies each file type instead of treating everything as octet-stream
//  3. axios options include maxBodyLength/maxContentLength: Infinity so large
//     videos are not silently truncated
//  4. Full error detail is logged (err.response.data) instead of swallowed
//
async function sendTelegramProof(ticketId, techId, notes, files, siteId, siteName) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.log('[Telegram] Skipped — BOT_TOKEN or CHAT_ID not set in .env');
        return;
    }
    if (!files || !files.length) {
        console.log('[Telegram] Skipped — no files attached');
        return;
    }

    const API     = `https://api.telegram.org/bot${BOT_TOKEN}`;
    // HTML parse mode is used throughout — it is immune to special characters
    // in tech notes/IDs that would break Telegram's Markdown (v1) parser.
    // All user-supplied strings are passed through escapeHtml() for safety.
    // Format: site_id / site_name / Issue — plain text, no emojis
    const caption =
        `${escapeHtml(siteId || ticketId)}\n` +
        `${escapeHtml(siteName)}\n` +
        `Issue: ${escapeHtml(notes || '—')}`;

    // Axios config — Infinity prevents large videos from being cut off
    const axiosCfg = {
        maxBodyLength:    Infinity,
        maxContentLength: Infinity,
    };

    try {
        if (files.length === 1) {
            // ── Single file ─────────────────────────────────────────────────
            // sendMediaGroup requires ≥ 2 items; use sendPhoto / sendVideo instead
            const f       = files[0];
            const isVideo = f.mimetype.startsWith('video');
            const method  = isVideo ? 'sendVideo' : 'sendPhoto';
            const field   = isVideo ? 'video'     : 'photo';

            const form = new FormData();
            form.append('chat_id',    CHAT_ID);
            form.append('caption',    caption);
            form.append('parse_mode', 'HTML');
            // Pass { filename, contentType } so Telegram knows the file type
            form.append(field, fs.createReadStream(f.path), {
                filename:    f.originalname,
                contentType: f.mimetype,
            });

            await axios.post(`${API}/${method}`, form, {
                headers: form.getHeaders(),
                ...axiosCfg,
            });
            console.log(`[Telegram] ✔ Sent 1 ${field} for ticket ${ticketId}`);

        } else {
            // ── Multiple files ──────────────────────────────────────────────
            // Telegram allows 2–10 items per sendMediaGroup call
            const batch = files.slice(0, 10);

            const media = batch.map((f, i) => ({
                type:  f.mimetype.startsWith('video') ? 'video' : 'photo',
                media: `attach://file${i}`,
                // Caption only on the first item (Telegram rule)
                ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
            }));

            const form = new FormData();
            form.append('chat_id', CHAT_ID);
            form.append('media',   JSON.stringify(media));
            batch.forEach((f, i) => {
                // { filename, contentType } required — plain string breaks type detection
                form.append(`file${i}`, fs.createReadStream(f.path), {
                    filename:    f.originalname,
                    contentType: f.mimetype,
                });
            });

            await axios.post(`${API}/sendMediaGroup`, form, {
                headers: form.getHeaders(),
                ...axiosCfg,
            });
            console.log(`[Telegram] ✔ Sent ${batch.length} files for ticket ${ticketId}`);
        }
    } catch (err) {
        // Log the full Telegram error response so it is easy to diagnose
        const detail = err.response?.data
            ? JSON.stringify(err.response.data, null, 2)
            : err.message;
        console.error(`[Telegram] ✘ Upload failed for ticket ${ticketId}:\n`, detail);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTE RESERVATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/routes/my-route?technician_id= ──────────────────────────────
app.get('/api/routes/my-route', async (req, res) => {
    const { technician_id } = req.query;
    if (!technician_id) return res.status(400).json({ error: 'Missing technician_id' });
    try {
        if (supabase) {
            const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
            const { data: routes, error } = await supabase
                .from('route_reservations')
                .select('*')
                .eq('technician_id', technician_id)
                .eq('status', 'ACTIVE')
                .gte('last_activity', cutoff)
                .order('created_at', { ascending: false })
                .limit(1);
            if (error) throw error;
            if (!routes || !routes.length) return res.json(null);
            const route = routes[0];
            // Hydrate ticket details for both reserved (unclaimed) and claimed sites
            const allIds = [...(route.site_ids || []), ...(route.claimed_ids || [])];
            let tickets = [];
            if (allIds.length) {
                const { data: tix } = await supabase.from('tickets')
                    .select('*').in('id', allIds);
                tickets = tix || [];
            }
            return res.json({ ...route, tickets });
        }
        let db = readDB();
        db = expireRoutesLocal(db);
        const route = getActiveRouteLocal(db, technician_id);
        if (!route) return res.json(null);
        const allIds = [...(route.site_ids || []), ...(route.claimed_ids || [])];
        const tickets = allIds
            .map(sid => db.tickets.find(t => t.id === sid))
            .filter(Boolean);
        res.json({ ...route, tickets });
    } catch (err) {
        console.error('[GET /routes/my-route]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/routes/reserve ──────────────────────────────────────────────
// body: { technician_id, technician_name, locality, site_ids[] }
app.post('/api/routes/reserve', async (req, res) => {
    const { technician_id, technician_name, locality, site_ids } = req.body;
    if (!technician_id || !locality || !Array.isArray(site_ids))
        return res.status(400).json({ error: 'technician_id, locality, and site_ids are required' });
    if (!site_ids.length)
        return res.status(400).json({ error: 'site_ids must not be empty' });
    try {
        const expiresAt = new Date(Date.now() + ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
        if (supabase) {
            // Release any existing active route for this tech first
            await supabase.from('route_reservations')
                .update({ status: 'RELEASED', released_at: nowIso() })
                .eq('technician_id', technician_id).eq('status', 'ACTIVE');
            const { data, error } = await supabase.from('route_reservations').insert({
                technician_id,
                technician_name: technician_name || technician_id,
                locality,
                site_ids,
                claimed_ids: [],
                status: 'ACTIVE',
                created_at: nowIso(),
                last_activity: nowIso(),
                expires_at: expiresAt
            }).select().single();
            if (error) throw error;
            return res.json({ message: `Route reserved for ${locality}`, route: data });
        }
        const db = readDB();
        // Release existing active routes
        db.route_reservations.forEach(r => {
            if (r.technician_id === technician_id && r.status === 'ACTIVE') {
                r.status = 'RELEASED'; r.released_at = nowIso();
            }
        });
        const newRoute = {
            id: generateId(),
            technician_id,
            technician_name: technician_name || technician_id,
            locality,
            site_ids,
            claimed_ids: [],
            status: 'ACTIVE',
            created_at: nowIso(),
            last_activity: nowIso(),
            expires_at: expiresAt
        };
        db.route_reservations.push(newRoute);
        writeDB(db);
        res.json({ message: `Route reserved for ${locality}`, route: newRoute });
    } catch (err) {
        console.error('[POST /routes/reserve]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/routes/update-sites ─────────────────────────────────────────
// body: { technician_id, site_ids[] }  — replace site list in-place
app.post('/api/routes/update-sites', async (req, res) => {
    const { technician_id, site_ids } = req.body;
    if (!technician_id || !Array.isArray(site_ids))
        return res.status(400).json({ error: 'technician_id and site_ids are required' });
    try {
        if (supabase) {
            const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
            const { error } = await supabase.from('route_reservations')
                .update({ site_ids, last_activity: nowIso() })
                .eq('technician_id', technician_id)
                .eq('status', 'ACTIVE')
                .gte('last_activity', cutoff);
            if (error) throw error;
            return res.json({ message: 'Route updated' });
        }
        const db = readDB();
        const route = getActiveRouteLocal(db, technician_id);
        if (!route) return res.status(404).json({ error: 'No active route found' });
        route.site_ids = site_ids;
        route.last_activity = nowIso();
        writeDB(db);
        res.json({ message: 'Route updated' });
    } catch (err) {
        console.error('[POST /routes/update-sites]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/routes/release ──────────────────────────────────────────────
// body: { technician_id }
app.post('/api/routes/release', async (req, res) => {
    const { technician_id } = req.body;
    if (!technician_id) return res.status(400).json({ error: 'technician_id required' });
    try {
        if (supabase) {
            const { error } = await supabase.from('route_reservations')
                .update({ status: 'RELEASED', released_at: nowIso() })
                .eq('technician_id', technician_id).eq('status', 'ACTIVE');
            if (error) throw error;
            return res.json({ message: 'Route released' });
        }
        const db = readDB();
        db.route_reservations.forEach(r => {
            if (r.technician_id === technician_id && r.status === 'ACTIVE') {
                r.status = 'RELEASED'; r.released_at = nowIso();
            }
        });
        writeDB(db);
        res.json({ message: 'Route released' });
    } catch (err) {
        console.error('[POST /routes/release]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/routes/admin-release ───────────────────────────────────────
// Admin-only: release any tech's route. body: { technician_id, admin_id }
app.post('/api/routes/admin-release', async (req, res) => {
    const { technician_id } = req.body;
    if (!technician_id) return res.status(400).json({ error: 'technician_id required' });
    try {
        if (supabase) {
            const { error } = await supabase.from('route_reservations')
                .update({ status: 'RELEASED', released_at: nowIso() })
                .eq('technician_id', technician_id).eq('status', 'ACTIVE');
            if (error) throw error;
            return res.json({ message: `Route released for ${technician_id}` });
        }
        const db = readDB();
        db.route_reservations.forEach(r => {
            if (r.technician_id === technician_id && r.status === 'ACTIVE') {
                r.status = 'RELEASED'; r.released_at = nowIso();
            }
        });
        writeDB(db);
        res.json({ message: `Route released for ${technician_id}` });
    } catch (err) {
        console.error('[POST /routes/admin-release]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/routes/all  — admin view of all active routes ───────────────
app.get('/api/routes/all', async (req, res) => {
    try {
        if (supabase) {
            const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
            const { data, error } = await supabase
                .from('route_reservations')
                .select('*')
                .eq('status', 'ACTIVE')
                .gte('last_activity', cutoff)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.json(data || []);
        }
        let db = readDB();
        db = expireRoutesLocal(db);
        const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
        res.json(db.route_reservations.filter(r => r.status === 'ACTIVE' && r.last_activity >= cutoff));
    } catch (err) {
        console.error('[GET /routes/all]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DUTY STATUS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/duty/toggle ─────────────────────────────────────────────────
// body: { technician_id, technician_name, is_on_duty, current_gps? }
app.post('/api/duty/toggle', async (req, res) => {
    const { technician_id, technician_name, is_on_duty, current_gps } = req.body;
    if (!technician_id || is_on_duty === undefined)
        return res.status(400).json({ error: 'technician_id and is_on_duty required' });
    try {
        if (supabase) {
            const { data: existing } = await supabase.from('technician_statuses')
                .select('id').eq('technician_id', technician_id).maybeSingle();
            if (existing) {
                await supabase.from('technician_statuses')
                    .update({ is_on_duty, last_activity: nowIso(), current_gps: current_gps || null })
                    .eq('technician_id', technician_id);
            } else {
                await supabase.from('technician_statuses').insert({
                    technician_id,
                    technician_name: technician_name || technician_id,
                    is_on_duty,
                    last_activity: nowIso(),
                    current_gps: current_gps || null
                });
            }
            return res.json({ message: `Status set to ${is_on_duty ? 'On Duty' : 'Off Duty'}` });
        }
        const db = readDB();
        const rec = getTechStatusLocal(db, technician_id);
        rec.is_on_duty = is_on_duty;
        rec.last_activity = nowIso();
        rec.technician_name = technician_name || technician_id;
        if (current_gps) rec.current_gps = current_gps;
        writeDB(db);
        res.json({ message: `Status set to ${is_on_duty ? 'On Duty' : 'Off Duty'}` });
    } catch (err) {
        console.error('[POST /duty/toggle]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/duty/heartbeat ──────────────────────────────────────────────
// body: { technician_id, current_gps? }  — keeps session alive, updates GPS
app.post('/api/duty/heartbeat', async (req, res) => {
    const { technician_id, current_gps } = req.body;
    if (!technician_id) return res.status(400).json({ error: 'technician_id required' });
    try {
        if (supabase) {
            await supabase.from('technician_statuses')
                .update({ last_activity: nowIso(), current_gps: current_gps || null })
                .eq('technician_id', technician_id);
            // Also bump active route last_activity to prevent premature expiry
            await supabase.from('route_reservations')
                .update({ last_activity: nowIso() })
                .eq('technician_id', technician_id).eq('status', 'ACTIVE');
            return res.json({ ok: true });
        }
        const db = readDB();
        const rec = getTechStatusLocal(db, technician_id);
        rec.last_activity = nowIso();
        if (current_gps) rec.current_gps = current_gps;
        const route = getActiveRouteLocal(db, technician_id);
        if (route) route.last_activity = nowIso();
        writeDB(db);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/duty/status?technician_id= ──────────────────────────────────
app.get('/api/duty/status', async (req, res) => {
    const { technician_id } = req.query;
    if (!technician_id) return res.status(400).json({ error: 'technician_id required' });
    try {
        if (supabase) {
            const { data } = await supabase.from('technician_statuses')
                .select('*').eq('technician_id', technician_id).maybeSingle();
            return res.json(data || { technician_id, is_on_duty: true });
        }
        const db = readDB();
        const rec = getTechStatusLocal(db, technician_id);
        res.json(rec);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/duty/all — admin view of all technician statuses + routes ────
app.get('/api/duty/all', async (req, res) => {
    try {
        if (supabase) {
            const [{ data: statuses }, { data: routes }, { data: techs }] = await Promise.all([
                supabase.from('technician_statuses').select('*').order('last_activity', { ascending: false }),
                supabase.from('route_reservations').select('*').eq('status', 'ACTIVE'),
                supabase.from('users').select('tech_code, display_name').eq('role', 'technician')
            ]);
            // Build combined view
            const routeMap = {};
            for (const r of (routes || [])) routeMap[r.technician_id] = r;
            const statusMap = {};
            for (const s of (statuses || [])) statusMap[s.technician_id] = s;
            const result = (techs || []).map(t => ({
                technician_id: t.tech_code,
                technician_name: t.display_name,
                is_on_duty: statusMap[t.tech_code]?.is_on_duty ?? false,
                last_activity: statusMap[t.tech_code]?.last_activity || null,
                current_gps: statusMap[t.tech_code]?.current_gps || null,
                active_route: routeMap[t.tech_code] || null
            }));
            return res.json(result);
        }
        let db = readDB();
        db = expireRoutesLocal(db);
        const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
        const techs = db.users.filter(u => u.role === 'technician');
        const routeMap = {};
        for (const r of db.route_reservations) {
            if (r.status === 'ACTIVE' && r.last_activity >= cutoff) routeMap[r.technician_id] = r;
        }
        const statusMap = {};
        for (const s of db.technician_statuses) statusMap[s.technician_id] = s;
        // Count claimed tickets per tech
        const claimedMap = {};
        for (const t of db.tickets) {
            if (t.status === 'ON_GOING' && t.assigned_to) {
                claimedMap[t.assigned_to] = (claimedMap[t.assigned_to] || 0) + 1;
            }
        }
        res.json(techs.map(t => ({
            technician_id: t.tech_code,
            technician_name: t.display_name,
            is_on_duty: statusMap[t.tech_code]?.is_on_duty ?? false,
            last_activity: statusMap[t.tech_code]?.last_activity || null,
            current_gps: statusMap[t.tech_code]?.current_gps || null,
            active_route: routeMap[t.tech_code] || null,
            claimed_count: claimedMap[t.tech_code] || 0
        })));
    } catch (err) {
        console.error('[GET /duty/all]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/sync/poll — lightweight state fingerprint for real-time polling
// Returns a compact snapshot for efficient change detection on the client
app.get('/api/sync/poll', async (req, res) => {
    try {
        if (supabase) {
            const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
            const [{ data: openTix }, { data: routes }, { data: statuses }] = await Promise.all([
                supabase.from('tickets').select('id, updated_at').eq('status', 'OPEN').is('assigned_to', null),
                supabase.from('route_reservations').select('id, technician_id, site_ids, last_activity').eq('status', 'ACTIVE').gte('last_activity', cutoff),
                supabase.from('technician_statuses').select('technician_id, is_on_duty, last_activity')
            ]);
            return res.json({
                ts: nowIso(),
                open_count: (openTix || []).length,
                routes: (routes || []).map(r => ({ id: r.id, tech: r.technician_id, sites: r.site_ids?.length || 0 })),
                statuses: statuses || []
            });
        }
        let db = readDB();
        db = expireRoutesLocal(db);
        const cutoff = new Date(Date.now() - ROUTE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
        res.json({
            ts: nowIso(),
            open_count: db.tickets.filter(t => t.status === 'OPEN' && !t.assigned_to).length,
            routes: db.route_reservations
                .filter(r => r.status === 'ACTIVE' && r.last_activity >= cutoff)
                .map(r => ({ id: r.id, tech: r.technician_id, sites: r.site_ids?.length || 0 })),
            statuses: db.technician_statuses.map(s => ({ technician_id: s.technician_id, is_on_duty: s.is_on_duty, last_activity: s.last_activity }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.listen(PORT, () => {
    console.log(`\n🚀  FieldOps running → http://localhost:${PORT}`);
    console.log(`    Mode : ${supabase ? 'Supabase (cloud database)' : 'Local JSON  (database.json)'}`);
    console.log(`    Telegram : ${BOT_TOKEN ? 'enabled' : 'disabled (no BOT_TOKEN)'}\n`);
});
