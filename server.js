'use strict';
require('dotenv').config();

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const axios     = require('axios');
const FormData  = require('form-data');
const bcrypt    = require('bcryptjs');
const ExcelJS   = require('exceljs'); // Ticket Export (.xlsx) — run `npm install exceljs`

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
// BOT_TOKEN/CHAT_ID below are the admin/global bot — used ONLY for the
// ticket-cancellation notification. Task proofs no longer use this bot; each
// technician's proof is sent through their OWN bot/chat, stored on their user
// row as telegram_bot_token / telegram_chat_id (see /api/users/:tech_code/telegram-settings).
// Supabase mode requires these two columns on `users`:
//   ALTER TABLE users ADD COLUMN telegram_bot_token text;
//   ALTER TABLE users ADD COLUMN telegram_chat_id   text;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Personal Info (Profile → Personal Info) ───────────────────────────────
// Nickname / birth date / current address, plus a profile photo that
// replaces the initial-letter avatar in the header and on the Profile
// screen (see /api/users/:tech_code/personal-info and /photo below).
// Supabase mode requires these four columns on `users`:
//   ALTER TABLE users ADD COLUMN nickname   text;
//   ALTER TABLE users ADD COLUMN birth_date date;
//   ALTER TABLE users ADD COLUMN address    text;
//   ALTER TABLE users ADD COLUMN photo_url  text;

// ─── Local JSON DB (fallback when Supabase is not configured) ───────────────
const DB_PATH = path.join(__dirname, 'database.json');

// ─── Contact Support module (Profile → Help & Support → Contact Support) ───
// Local-JSON-mode default categories, mirroring the INSERT in
// contact_support_migration.sql so both modes start out identical.
// Contacts start empty in both modes — added later via Supabase directly
// (or a future Admin page) — never hardcoded into the frontend.
function defaultSupportCategories() {
    return [
        { id: 'cat-technical',     name: 'Technical Support',      description: 'Application issues, bugs and troubleshooting',   sort_order: 1, is_active: true },
        { id: 'cat-operations',    name: 'Operations Support',     description: 'Job assignments, routing and field operations',  sort_order: 2, is_active: true },
        { id: 'cat-administrative', name: 'Administrative Support', description: 'Accounts, approvals and general inquiries',      sort_order: 3, is_active: true },
    ];
}

// NOTE: readDB/writeDB were referenced throughout this file but never
// defined, so the no-Supabase fallback path would crash. Added here so the
// local-JSON mode (and the new sync engine's local fallback) actually works.
function readDB() {
    if (!fs.existsSync(DB_PATH)) {
        return { users: [], tickets: [], task_batches: [], task_sync_logs: [], route_reservations: [], technician_statuses: [], support_categories: defaultSupportCategories(), support_contacts: [], notifications: [] };
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db  = raw.trim() ? JSON.parse(raw) : {};
    db.users                 = db.users                 || [];
    db.tickets               = db.tickets               || [];
    db.task_batches          = db.task_batches          || [];
    db.task_sync_logs        = db.task_sync_logs        || [];
    db.route_reservations    = db.route_reservations    || [];
    db.technician_statuses   = db.technician_statuses   || [];
    // Guided Troubleshooting & Help Center (see supabase_migration_troubleshooting.sql)
    db.troubleshooting_drafts    = db.troubleshooting_drafts    || [];
    db.troubleshooting_responses = db.troubleshooting_responses || [];
    db.troubleshooting_media     = db.troubleshooting_media     || [];
    // Contact Support module (see contact_support_migration.sql)
    db.support_categories = db.support_categories || defaultSupportCategories();
    db.support_contacts   = db.support_contacts   || [];
    // Notifications & Alerts (see supabase_migration_notifications.sql)
    db.notifications = db.notifications || [];
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
//  GUIDED TROUBLESHOOTING & HELP CENTER — data layer
//  -----------------------------------------------------------------------
//  ADDITIVE feature: three new tables, all namespaced troubleshooting_*.
//  See supabase_migration_troubleshooting.sql for the matching Supabase
//  schema (or the local database.json fallback initialised in readDB()
//  above). Nothing in this section is read or written by any existing
//  ticket/claim/submit/cancel/Telegram code — it is only ever called from
//  the new /api/troubleshooting/* routes and from two clearly-marked
//  additive hooks inside GET /api/tickets/ongoing and POST /api/tickets/submit
//  further down this file.
//
//  draft.status lifecycle:   in_progress -> completed -> submitted
//  draft.completed (boolean) mirrors status !== 'in_progress' and is the
//  single flag the frontend (and the submit-gate below) rely on to unlock
//  Submit Proof — this keeps the "is troubleshooting done?" check to one
//  field instead of scattering status-string comparisons everywhere.
// ═══════════════════════════════════════════════════════════════════════════

/** Get the current (non-submitted) troubleshooting draft for a job, or create one. */
async function tsGetOrCreateDraft(jobId, technicianId) {
    if (supabase) {
        const { data: existing, error: findErr } = await supabase
            .from('troubleshooting_drafts')
            .select('*')
            .eq('job_id', jobId)
            .neq('status', 'submitted')
            .order('created_at', { ascending: false })
            .limit(1);
        if (findErr) throw findErr;
        if (existing && existing.length) return existing[0];

        const { data: created, error: insErr } = await supabase
            .from('troubleshooting_drafts')
            .insert({ job_id: jobId, technician_id: technicianId, current_phase: 1, current_step: 0, completed: false, status: 'in_progress' })
            .select()
            .single();
        if (insErr) throw insErr;
        return created;
    }
    const db = readDB();
    let draft = db.troubleshooting_drafts
        .filter(d => d.job_id === jobId && d.status !== 'submitted')
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
    if (!draft) {
        draft = {
            id: generateId(), job_id: jobId, technician_id: technicianId,
            current_phase: 1, current_step: 0, completed: false, ai_summary: null,
            status: 'in_progress', created_at: nowIso(), updated_at: nowIso()
        };
        db.troubleshooting_drafts.push(draft);
        writeDB(db);
    }
    return draft;
}

/** All check responses recorded so far for a draft. */
async function tsGetResponses(draftId) {
    if (supabase) {
        const { data, error } = await supabase.from('troubleshooting_responses').select('*').eq('draft_id', draftId);
        if (error) throw error;
        return data || [];
    }
    const db = readDB();
    return db.troubleshooting_responses.filter(r => r.draft_id === draftId);
}

/** All media captured so far for a draft, oldest first. */
async function tsGetMedia(draftId) {
    if (supabase) {
        const { data, error } = await supabase.from('troubleshooting_media').select('*').eq('draft_id', draftId).order('uploaded_at', { ascending: true });
        if (error) throw error;
        return data || [];
    }
    const db = readDB();
    return db.troubleshooting_media
        .filter(m => m.draft_id === draftId)
        .sort((a, b) => (a.uploaded_at || '').localeCompare(b.uploaded_at || ''));
}

/** Upsert one check's Pass/Fail result (unique on draft_id+check, so re-answering
 *  a check updates it in place). Mutating a previously-completed draft
 *  automatically reopens it (completed:false) so a stale AI summary can never
 *  be carried into Submit Proof after the technician changes an earlier answer. */
async function tsUpsertResponse(draftId, phase, check, result, notes) {
    if (supabase) {
        const { data, error } = await supabase
            .from('troubleshooting_responses')
            .upsert({ draft_id: draftId, phase, check, result, notes: notes || '' }, { onConflict: 'draft_id,check' })
            .select()
            .single();
        if (error) throw error;
        await supabase.from('troubleshooting_drafts')
            .update({ completed: false, status: 'in_progress', updated_at: nowIso() })
            .eq('id', draftId).neq('status', 'in_progress');
        return data;
    }
    const db = readDB();
    let row = db.troubleshooting_responses.find(r => r.draft_id === draftId && r.check === check);
    if (row) { row.result = result; row.notes = notes || ''; }
    else {
        row = { id: generateId(), draft_id: draftId, phase, check, result, notes: notes || '', created_at: nowIso() };
        db.troubleshooting_responses.push(row);
    }
    const draft = db.troubleshooting_drafts.find(d => d.id === draftId);
    if (draft && draft.status !== 'in_progress') { draft.completed = false; draft.status = 'in_progress'; draft.updated_at = nowIso(); }
    writeDB(db);
    return row;
}

/** Store one photo/video captured during troubleshooting and record its metadata.
 *  Uploads immediately — Supabase Storage bucket 'troubleshooting' (public, same
 *  convention as the existing 'proofs' bucket) or local /uploads in local mode —
 *  so nothing is lost if the app crashes or the technician logs out mid-checklist. */
async function tsInsertMedia(draftId, jobId, file, checkId) {
    const mediaType = file.mimetype.startsWith('video') ? 'video' : 'image';
    if (supabase) {
        const storagePath = `${jobId}/${draftId}/${Date.now()}-${file.originalname.replace(/\s/g, '_')}`;
        const fileBuffer = fs.readFileSync(file.path);
        const { error: upErr } = await supabase.storage
            .from('troubleshooting')
            .upload(storagePath, fileBuffer, { contentType: file.mimetype, upsert: true });
        if (upErr) throw upErr;
        const { data: { publicUrl } } = supabase.storage.from('troubleshooting').getPublicUrl(storagePath);
        const { data, error } = await supabase
            .from('troubleshooting_media')
            .insert({ draft_id: draftId, check: checkId || null, storage_url: publicUrl, media_type: mediaType })
            .select()
            .single();
        if (error) throw error;
        return data;
    }
    const storageUrl = `/uploads/${file.filename}`;
    const db = readDB();
    const row = { id: generateId(), draft_id: draftId, check: checkId || null, storage_url: storageUrl, media_type: mediaType, uploaded_at: nowIso() };
    db.troubleshooting_media.push(row);
    writeDB(db);
    return row;
}

/** Partial update of a draft's navigation position and/or AI summary/completion. */
async function tsUpdateProgress(draftId, fields) {
    const patch = { updated_at: nowIso() };
    if (fields.current_phase !== undefined) patch.current_phase = fields.current_phase;
    if (fields.current_step  !== undefined) patch.current_step  = fields.current_step;
    if (fields.ai_summary    !== undefined) patch.ai_summary    = fields.ai_summary;
    if (fields.completed     !== undefined) patch.completed     = fields.completed;
    if (fields.status        !== undefined) patch.status        = fields.status;

    if (supabase) {
        const { data, error } = await supabase.from('troubleshooting_drafts').update(patch).eq('id', draftId).select().single();
        if (error) throw error;
        return data;
    }
    const db = readDB();
    const draft = db.troubleshooting_drafts.find(d => d.id === draftId);
    if (!draft) throw new Error('Draft not found');
    Object.assign(draft, patch);
    writeDB(db);
    return draft;
}

/** Returns the single completed (but not yet submitted) draft for a job, or null.
 *  Used by POST /api/tickets/submit to gate submission and to collect the final
 *  summary + already-uploaded media URLs without re-uploading anything. */
async function tsGetCompletedDraft(jobId) {
    if (supabase) {
        const { data, error } = await supabase
            .from('troubleshooting_drafts')
            .select('*')
            .eq('job_id', jobId)
            .eq('completed', true)
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) throw error;
        return (data && data[0]) || null;
    }
    const db = readDB();
    return db.troubleshooting_drafts
        .filter(d => d.job_id === jobId && d.completed)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] || null;
}

/** Best-effort: flip a job's completed draft to status='submitted' once the final
 *  proof has gone out. Never throws into the caller — proof submission must
 *  never fail because of troubleshooting bookkeeping. */
async function tsMarkSubmitted(jobId) {
    try {
        if (supabase) {
            await supabase.from('troubleshooting_drafts')
                .update({ status: 'submitted', updated_at: nowIso() })
                .eq('job_id', jobId).eq('completed', true);
            return;
        }
        const db = readDB();
        db.troubleshooting_drafts
            .filter(d => d.job_id === jobId && d.completed)
            .forEach(d => { d.status = 'submitted'; d.updated_at = nowIso(); });
        writeDB(db);
    } catch (err) {
        console.warn('[Troubleshooting] Could not mark draft submitted for job', jobId, err.message);
    }
}

/** Batch lookup used by GET /api/tickets/ongoing to embed troubleshooting_completed
 *  on every job card in one round trip instead of one call per card. Fails CLOSED
 *  (false) on any error, so a lookup problem can never silently unlock Submit Proof. */
async function tsGetCompletionMap(jobIds) {
    const map = {};
    jobIds.forEach(id => { map[id] = false; });
    if (!jobIds.length) return map;
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('troubleshooting_drafts')
                .select('job_id, completed')
                .in('job_id', jobIds);
            if (error) throw error;
            (data || []).forEach(d => { if (d.completed) map[d.job_id] = true; });
            return map;
        }
        const db = readDB();
        db.troubleshooting_drafts.forEach(d => { if (jobIds.includes(d.job_id) && d.completed) map[d.job_id] = true; });
        return map;
    } catch (err) {
        console.warn('[Troubleshooting] completion lookup failed — defaulting to required:', err.message);
        return map; // all false — fails closed
    }
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
                    site_notes:  site.notes || '', // optional admin-entered site notes (distinct from technician completion `notes`)
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
                site_notes: site.notes || '', // optional admin-entered site notes (distinct from technician completion `notes`)
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

// ── POST /api/auth/tech/login ─────────────────────────────────────────────
// Technician accounts are provisioned directly in Supabase (no frontend
// self-registration — see /api/auth/tech/change-pin below). Every login
// response includes must_change_pin so the client can gate dashboard
// access behind the mandatory PIN-change screen when an admin has just
// created the account or reset its PIN.
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
        res.json({
            id: user.tech_code,
            display_name: user.display_name,
            tech_code: user.tech_code,
            role: 'technician',
            must_change_pin: !!user.must_change_pin
        });
    } catch (err) {
        console.error('[POST /auth/tech/login]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/auth/tech/change-pin ─────────────────────────────────────────
// Mandatory first-login (and post-reset) PIN change. Re-validates the
// current PIN against the stored hash server-side — this is the actual
// enforcement boundary, since it does not trust that the client only
// calls this route after a legitimate must_change_pin login. Clears
// must_change_pin only once the new PIN has been verified and saved.
const PIN_FORMAT = /^\d{4,6}$/;
app.post('/api/auth/tech/change-pin', async (req, res) => {
    const { tech_code, current_pin, new_pin } = req.body;
    if (!tech_code || !current_pin || !new_pin)
        return res.status(400).json({ error: 'Current PIN and new PIN are required' });
    if (!PIN_FORMAT.test(String(new_pin)))
        return res.status(400).json({ error: 'New PIN must be 4–6 digits' });

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

        const currentValid = await bcrypt.compare(String(current_pin), user.credential_hash);
        if (!currentValid) return res.status(401).json({ error: 'Current PIN is incorrect' });

        const sameAsOld = await bcrypt.compare(String(new_pin), user.credential_hash);
        if (sameAsOld) return res.status(400).json({ error: 'New PIN must be different from your current PIN' });

        const credential_hash = await bcrypt.hash(String(new_pin), 10);

        if (supabase) {
            const { error } = await supabase.from('users')
                .update({ credential_hash, must_change_pin: false })
                .eq('tech_code', tech_code);
            if (error) throw error;
        } else {
            const db = readDB();
            const u = db.users.find(u => u.tech_code === tech_code && u.role === 'technician');
            u.credential_hash = credential_hash;
            u.must_change_pin = false;
            writeDB(db);
        }

        notifyPinChanged(tech_code);
        res.json({ id: user.tech_code, display_name: user.display_name, tech_code: user.tech_code, role: 'technician' });
    } catch (err) {
        console.error('[POST /auth/tech/change-pin]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Per-user Telegram Settings (App Preferences)
//  Each technician owns their own Bot + Chat/Group — no global fallback.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/users/:tech_code/telegram-settings ───────────────────────────
app.get('/api/users/:tech_code/telegram-settings', async (req, res) => {
    const { tech_code } = req.params;
    try {
        let user;
        if (supabase) {
            const { data } = await supabase.from('users')
                .select('telegram_bot_token, telegram_chat_id')
                .eq('tech_code', tech_code).maybeSingle();
            user = data;
        } else {
            user = readDB().users.find(u => u.tech_code === tech_code);
        }
        if (!user) return res.status(404).json({ error: 'Technician not found' });
        res.json({
            telegram_bot_token: user.telegram_bot_token || '',
            telegram_chat_id:   user.telegram_chat_id   || ''
        });
    } catch (err) {
        console.error('[GET /users/telegram-settings]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/users/:tech_code/telegram-settings ──────────────────────────
// body: { telegram_bot_token, telegram_chat_id }
app.post('/api/users/:tech_code/telegram-settings', async (req, res) => {
    const { tech_code } = req.params;
    const { telegram_bot_token, telegram_chat_id } = req.body;
    if (!telegram_bot_token || !telegram_chat_id)
        return res.status(400).json({ error: 'Bot Token and Chat ID are required' });
    try {
        if (supabase) {
            const { error } = await supabase.from('users')
                .update({ telegram_bot_token, telegram_chat_id })
                .eq('tech_code', tech_code);
            if (error) throw error;
        } else {
            const db = readDB();
            const user = db.users.find(u => u.tech_code === tech_code);
            if (!user) return res.status(404).json({ error: 'Technician not found' });
            user.telegram_bot_token = telegram_bot_token;
            user.telegram_chat_id   = telegram_chat_id;
            writeDB(db);
        }
        res.json({ message: 'Telegram settings saved.' });
    } catch (err) {
        console.error('[POST /users/telegram-settings]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/users/telegram/test ─────────────────────────────────────────
// body: { telegram_bot_token, telegram_chat_id }
// "Send Test Message" button — verifies the token via getMe, then sends a
// real message to the chat_id. Tests whatever was just typed in, not
// necessarily what's already saved, so users can validate before saving.
app.post('/api/users/telegram/test', async (req, res) => {
    const { telegram_bot_token, telegram_chat_id } = req.body;
    if (!telegram_bot_token || !telegram_chat_id)
        return res.status(400).json({ error: 'Bot Token and Chat ID are required' });

    const API = `https://api.telegram.org/bot${telegram_bot_token}`;

    try {
        await axios.get(`${API}/getMe`);
    } catch (err) {
        const detail = err.response?.data?.description || err.message;
        return res.status(400).json({ error: `Invalid Bot Token — ${detail}` });
    }

    try {
        await axios.post(`${API}/sendMessage`, {
            chat_id: telegram_chat_id,
            text: '✅ FieldOps: this Telegram Bot is configured correctly.'
        });
    } catch (err) {
        const detail = err.response?.data?.description || err.message;
        return res.status(400).json({ error: `Invalid Chat ID — ${detail}` });
    }

    res.json({ message: 'Telegram configuration is working.' });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Personal Info (Profile → Personal Info)
//  Nickname / birth date / current address, plus a profile photo that
//  replaces the initial-letter avatar in the header and on Profile.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/users/:tech_code/personal-info ───────────────────────────────
app.get('/api/users/:tech_code/personal-info', async (req, res) => {
    const { tech_code } = req.params;
    try {
        let user;
        if (supabase) {
            const { data } = await supabase.from('users')
                .select('nickname, birth_date, address, photo_url')
                .eq('tech_code', tech_code).maybeSingle();
            user = data;
        } else {
            user = readDB().users.find(u => u.tech_code === tech_code);
        }
        if (!user) return res.status(404).json({ error: 'Technician not found' });
        res.json({
            nickname:   user.nickname   || '',
            birth_date: user.birth_date || '',
            address:    user.address    || '',
            photo_url:  user.photo_url  || ''
        });
    } catch (err) {
        console.error('[GET /users/personal-info]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/users/:tech_code/personal-info ──────────────────────────────
// body: { nickname, birth_date, address } — all optional, saved as-is.
app.post('/api/users/:tech_code/personal-info', async (req, res) => {
    const { tech_code } = req.params;
    const { nickname, birth_date, address } = req.body;
    try {
        if (supabase) {
            const { error } = await supabase.from('users')
                .update({
                    nickname:   nickname   || null,
                    birth_date: birth_date || null,
                    address:    address    || null
                })
                .eq('tech_code', tech_code);
            if (error) throw error;
        } else {
            const db = readDB();
            const user = db.users.find(u => u.tech_code === tech_code);
            if (!user) return res.status(404).json({ error: 'Technician not found' });
            user.nickname   = nickname   || '';
            user.birth_date = birth_date || '';
            user.address    = address    || '';
            writeDB(db);
        }
        notifyProfileUpdated(tech_code);
        res.json({ message: 'Personal info saved.' });
    } catch (err) {
        console.error('[POST /users/personal-info]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/users/:tech_code/photo — upload/replace the profile photo ───
// multipart/form-data, field name "photo". Stored under /uploads (same
// disk storage as proof photos/videos) and served via /uploads/<filename>.
app.post('/api/users/:tech_code/photo', upload.single('photo'), async (req, res) => {
    const { tech_code } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
    const photo_url = `/uploads/${req.file.filename}`;
    try {
        if (supabase) {
            const { error } = await supabase.from('users')
                .update({ photo_url })
                .eq('tech_code', tech_code);
            if (error) throw error;
        } else {
            const db = readDB();
            const user = db.users.find(u => u.tech_code === tech_code);
            if (!user) return res.status(404).json({ error: 'Technician not found' });
            user.photo_url = photo_url;
            writeDB(db);
        }
        notifyProfileUpdated(tech_code);
        res.json({ message: 'Photo updated.', photo_url });
    } catch (err) {
        console.error('[POST /users/photo]', err.message);
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
        let list;
        if (supabase) {
            const user = await getUserByTechCode(technician_id);
            const { data, error } = await supabase
                .from('tickets')
                .select('*')
                .eq('status', 'ON_GOING')
                .eq('assigned_to', user.id);
            if (error) throw error;
            list = data;
        } else {
            const { tickets } = readDB();
            list = tickets.filter(t => t.status === 'ON_GOING' && t.assigned_to === technician_id);
        }
        // ADDITIVE — Guided Troubleshooting: embed completion state per job so the
        // job card can show/hide the Submit Proof gate without an extra round trip.
        const completionMap = await tsGetCompletionMap(list.map(t => t.id));
        list = list.map(t => ({ ...t, troubleshooting_completed: !!completionMap[t.id] }));
        res.json(list);
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

            // Notifications & Alerts — additive and non-blocking; a failure here must never affect the claim itself.
            createNotificationInternal({
                user_id: technician_id, category: 'jobs', title: 'Job claimed successfully',
                message: `Your reservation for ${ticketNumber} was successful.`,
                priority: 'info', action_type: 'job_ongoing', action_data: { ticket_id: id },
                dedup_key: `job_claimed_${id}`,
            }).catch(e => console.error('[notify job_claimed]', e.message));

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

        // Notifications & Alerts — additive and non-blocking; a failure here must never affect the claim itself.
        createNotificationInternal({
            user_id: technician_id, category: 'jobs', title: 'Job claimed successfully',
            message: `Your reservation for ${t.ticket_id} was successful.`,
            priority: 'info', action_type: 'job_ongoing', action_data: { ticket_id: id },
            dedup_key: `job_claimed_${id}`,
        }).catch(e => console.error('[notify job_claimed]', e.message));

        res.json({ message: `Ticket ${t.ticket_id} claimed by ${technician_id}`, ticket_id: t.ticket_id });
    } catch (err) {
        console.error('[POST /claim]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/submit  (multipart/form-data)
//  fields : id, technician_id, notes,
//           troubleshooting_summary (optional, plain text — final edited AI summary),
//           troubleshooting_media   (optional, JSON string of [{storage_url, media_type}]
//                                    already uploaded during the guided checklist —
//                                    never re-uploaded here)
//  files  : proof[] (max 5, max 50 MB each)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/submit', upload.array('proof', 5), async (req, res) => {
    const id = req.body.id || req.body.ticket_id;
    const { technician_id, notes } = req.body;
    if (!id || !technician_id || !req.files?.length)
        return res.status(400).json({ error: 'Missing id, technician_id, or proof files' });
    try {
        // ── Per-user Telegram gate ──────────────────────────────────────────
        // Task proofs are delivered through the submitting technician's own
        // Telegram Bot — there is no shared/global fallback. If they haven't
        // configured one yet, block here (before any upload work) and send
        // them back to App Preferences to fix it.
        const techUser = supabase
            ? await getUserByTechCode(technician_id)
            : readDB().users.find(u => u.tech_code === technician_id);
        if (!techUser) return res.status(404).json({ error: 'Technician not found' });
        if (!techUser.telegram_bot_token || !techUser.telegram_chat_id) {
            return res.status(409).json({
                error: 'Set up your Telegram Bot in App Preferences before submitting a task proof.'
            });
        }

        // ADDITIVE — Guided Troubleshooting gate. Submitting proof now requires a
        // completed (technician-confirmed) troubleshooting draft for this job.
        // This is the same message shown client-side when Submit Proof is disabled.
        const completedDraft = await tsGetCompletedDraft(id);
        if (!completedDraft) {
            return res.status(409).json({ error: 'Please complete the troubleshooting checklist before submitting your proof.' });
        }
        let troubleshootingMedia = [];
        if (req.body.troubleshooting_media) {
            try { troubleshootingMedia = JSON.parse(req.body.troubleshooting_media); } catch { troubleshootingMedia = []; }
        }
        const troubleshootingSummary = req.body.troubleshooting_summary || '';

        let proofUrls    = [];
        let proofIds     = []; // ticket_proofs.id for each uploaded file — lets the Telegram
                                // send below stamp telegram_confirmed_at once delivery succeeds
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
                // .select('id') captures the new row so sendTelegramProof can later stamp
                // telegram_confirmed_at on exactly these rows (Media Retention gate).
                const { data: proofRow, error: proofInsErr } = await supabase.from('ticket_proofs').insert({
                    ticket_id:   id,
                    file_url:    publicUrl,
                    file_type:   file.mimetype.startsWith('video') ? 'video' : 'image',
                    file_name:   file.originalname,
                    uploaded_by: user.id
                }).select('id').single();
                if (proofInsErr) console.error('ticket_proofs insert error:', proofInsErr.message);
                else proofIds.push(proofRow.id);
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

        // Send proof to Telegram (non-blocking) — unchanged from today. proofIds is
        // passed through so a successful send can stamp telegram_confirmed_at
        // (Media Retention gate) on exactly the rows that were just uploaded.
        sendTelegramProof(techUser.telegram_bot_token, techUser.telegram_chat_id, ticketNumber, technician_id, notes, req.files, siteId, siteName, proofIds).catch(() => {});

        // ADDITIVE — Guided Troubleshooting: relay the AI-assisted summary and any
        // evidence captured during troubleshooting as a supplementary Telegram
        // message, referencing already-uploaded Storage URLs (nothing re-uploaded).
        // Fully independent of sendTelegramProof above — a failure here can never
        // affect the core proof submission, which has already succeeded by this point.
        // completedDraft.id is passed through so a successful evidence send can stamp
        // telegram_confirmed_at on the matching troubleshooting_media rows.
        if (troubleshootingSummary || troubleshootingMedia.length) {
            sendTelegramTroubleshootingFollowup(techUser.telegram_bot_token, techUser.telegram_chat_id, ticketNumber, troubleshootingSummary, troubleshootingMedia, completedDraft.id).catch(() => {});
        }
        tsMarkSubmitted(id).catch(() => {});

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
            const { data: row } = await supabase.from('tickets').select('ticket_id, assigned_to, status').eq('id', id).maybeSingle();
            ticketNumber = row?.ticket_id || ticketNumber;
            // assigned_to on this table is the technician's Supabase row id (uuid), not their
            // tech_code — resolve it below, only when the ticket was actually ON_GOING.
            const previouslyAssignedUuid = row?.status === 'ON_GOING' ? row?.assigned_to : null;

            const { error } = await supabase.from('tickets').update({
                status:               'CANCELLED',
                cancellation_reason:  reason,
                cancelled_by:         cancelled_by || 'unknown',
                cancelled_at:         new Date().toISOString(),
                assigned_to:          null
            }).eq('id', id).in('status', ['OPEN', 'ON_GOING']);
            if (error) throw error;

            // Notifications & Alerts — additive and non-blocking.
            if (previouslyAssignedUuid) {
                supabase.from('users').select('tech_code').eq('id', previouslyAssignedUuid).maybeSingle()
                    .then(({ data: u }) => {
                        if (u && u.tech_code && u.tech_code !== cancelled_by) {
                            createNotificationInternal({
                                user_id: u.tech_code, category: 'jobs', title: 'Job cancelled',
                                message: `Ticket ${ticketNumber} was cancelled: ${reason}`,
                                priority: 'critical', action_type: 'job_cancelled', action_data: { ticket_id: id },
                                dedup_key: `job_cancelled_${id}`,
                            }).catch(e => console.error('[notify job_cancelled]', e.message));
                        }
                    }).catch(e => console.error('[notify job_cancelled lookup]', e.message));
            }
        } else {
            const db = readDB();
            const t  = db.tickets.find(x => x.id === id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            if (!['OPEN', 'ON_GOING'].includes(t.status))
                return res.status(409).json({ error: 'Only OPEN or ON_GOING tickets can be cancelled' });
            const previouslyAssigned = t.status === 'ON_GOING' ? t.assigned_to : null;
            ticketNumber           = t.ticket_id || ticketNumber;
            t.status              = 'CANCELLED';
            t.cancellation_reason = reason;
            t.cancelled_by        = cancelled_by || 'unknown';
            t.cancelled_at        = new Date().toISOString();
            writeDB(db);

            // Notifications & Alerts — additive and non-blocking.
            if (previouslyAssigned && previouslyAssigned !== (cancelled_by || 'unknown')) {
                createNotificationInternal({
                    user_id: previouslyAssigned, category: 'jobs', title: 'Job cancelled',
                    message: `Ticket ${ticketNumber} was cancelled: ${reason}`,
                    priority: 'critical', action_type: 'job_cancelled', action_data: { ticket_id: id },
                    dedup_key: `job_cancelled_${id}`,
                }).catch(e => console.error('[notify job_cancelled]', e.message));
            }
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
//  CONTACT SUPPORT MODULE — routes
//  -----------------------------------------------------------------------
//  Backs Profile → Help & Support → Contact Support. Two new tables,
//  support_categories and support_contacts (see contact_support_migration.sql
//  / defaultSupportCategories() above for local-JSON mode). Read-only from
//  the app today — an Admin page can later add/edit/delete rows in either
//  table without any frontend change, since the frontend only ever calls
//  this one directory endpoint.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/support/directory ──────────────────────────────────────────────
// Every active category (sorted by sort_order), each with its active
// contacts nested underneath (sorted by display_order). Nothing here is
// hardcoded — it's a straight passthrough of whatever rows exist right now.
app.get('/api/support/directory', async (req, res) => {
    try {
        let categories, contacts;
        if (supabase) {
            const { data: cats, error: catErr } = await supabase
                .from('support_categories')
                .select('id, name, description, sort_order')
                .eq('is_active', true)
                .order('sort_order', { ascending: true });
            if (catErr) throw catErr;
            categories = cats;

            const { data: cts, error: contactErr } = await supabase
                .from('support_contacts')
                .select('id, category_id, full_name, designation, phone_number, viber_number, avatar_url, display_order')
                .eq('is_active', true)
                .order('display_order', { ascending: true });
            if (contactErr) throw contactErr;
            contacts = cts;
        } else {
            const db = readDB();
            categories = db.support_categories
                .filter(c => c.is_active !== false)
                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
            contacts = db.support_contacts
                .filter(c => c.is_active !== false)
                .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
        }

        const byCategory = {};
        for (const c of contacts || []) {
            (byCategory[c.category_id] = byCategory[c.category_id] || []).push(c);
        }
        const directory = (categories || []).map(cat => ({
            ...cat,
            contacts: byCategory[cat.id] || []
        }));

        res.json(directory);
    } catch (err) {
        console.error('[GET /support/directory]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GUIDED TROUBLESHOOTING & HELP CENTER — routes
//  -----------------------------------------------------------------------
//  All four routes below are additive: they only ever touch the three new
//  troubleshooting_* tables (via the helpers defined near the top of this
//  file) and never read or write tickets/users/ticket_proofs directly,
//  except for the resolved technician id needed to attribute a draft.
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/troubleshooting/draft?job_id=&technician_id= ───────────────────
// Fetch-or-create the active draft for this job, plus every response and
// media row saved so far, so the wizard can resume exactly where the
// technician left off — including after a refresh, crash, or logout.
app.get('/api/troubleshooting/draft', async (req, res) => {
    const { job_id, technician_id } = req.query;
    if (!job_id || !technician_id) return res.status(400).json({ error: 'Missing job_id or technician_id' });
    try {
        const user      = await getUserByTechCode(technician_id);
        const draft     = await tsGetOrCreateDraft(job_id, user.id);
        const responses = await tsGetResponses(draft.id);
        const media     = await tsGetMedia(draft.id);
        res.json({ draft, responses, media });
    } catch (err) {
        console.error('[GET /troubleshooting/draft]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/troubleshooting/response ───────────────────────────────────────
// body: { draft_id, phase, check, result: 'passed'|'failed', notes? }
// Upserts one check's result (unique per draft_id+check). Auto-saved by the
// client immediately after every Passed/Failed tap and after every note edit.
app.post('/api/troubleshooting/response', async (req, res) => {
    const { draft_id, phase, check, result, notes } = req.body;
    if (!draft_id || !phase || !check) return res.status(400).json({ error: 'Missing draft_id, phase, or check' });
    if (result !== 'passed' && result !== 'failed') return res.status(400).json({ error: "result must be 'passed' or 'failed'" });
    try {
        const row = await tsUpsertResponse(draft_id, phase, check, result, notes);
        res.json(row);
    } catch (err) {
        console.error('[POST /troubleshooting/response]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/troubleshooting/media  (multipart/form-data) ───────────────────
// fields: draft_id, job_id, check?   file: file
// Uploads a single photo/video the instant it's captured, so evidence is
// never lost even if the app crashes or the technician logs out before
// finishing the checklist. Reused verbatim (by URL) at final submission —
// never re-uploaded.
app.post('/api/troubleshooting/media', upload.single('file'), async (req, res) => {
    const { draft_id, job_id, check } = req.body;
    if (!draft_id || !job_id || !req.file) return res.status(400).json({ error: 'Missing draft_id, job_id, or file' });
    try {
        const row = await tsInsertMedia(draft_id, job_id, req.file, check);
        res.json(row);
    } catch (err) {
        console.error('[POST /troubleshooting/media]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/troubleshooting/progress ───────────────────────────────────────
// body: { draft_id, current_phase?, current_step?, ai_summary?, completed?, status? }
// Partial update — used both for lightweight nav auto-save (current_phase/
// current_step after every Next/Previous) and for saving/finalising the
// (technician-editable) AI summary. Setting completed:true here is what
// unlocks Submit Proof for this job.
app.post('/api/troubleshooting/progress', async (req, res) => {
    const { draft_id } = req.body;
    if (!draft_id) return res.status(400).json({ error: 'Missing draft_id' });
    try {
        const draft = await tsUpdateProgress(draft_id, req.body);
        res.json(draft);
    } catch (err) {
        console.error('[POST /troubleshooting/progress]', err.message);
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
    const { site_id, site_name, locality, address, coordinates, priority, uploaded_by, notes } = req.body;
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
                site_notes:  notes || '', // optional admin-entered site notes (distinct from technician completion `notes`)
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
                site_notes: notes || '', // optional admin-entered site notes (distinct from technician completion `notes`)
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

// ═══════════════════════════════════════════════════════════════════════════
//  TICKET EXPORT (CSV / XLSX) — admin reporting, monitoring & KPI analysis
//  -----------------------------------------------------------------------
//  ADDITIVE feature: read-only. Never writes to `tickets` or any other
//  table — it only queries, formats, and streams a file back to the admin.
//
//  Filtering:
//   - Date Range filters on the ticket's `created_at` (Opened date), pushed
//     down into the Supabase query (.gte/.lte) so large datasets are never
//     pulled into memory just to be filtered in JS. Local-JSON mode filters
//     in-process since that fallback is inherently small-scale.
//   - Status filter mirrors the exact same buckets the Admin Dashboard
//     already uses (see admFil() / updateStats() in index.html) — including
//     RECOVERED, which (like the Overview stat card) also picks up
//     ON_GOING tickets flagged recovered_while_claimed.
//
//  Timeline note baked into buildExportRow(): in this data model, claiming
//  an OPEN ticket is the single action that both assigns a technician AND
//  flips status to ON_GOING (see POST /api/tickets/claim above) — there is
//  no separate "reserved" timestamp stored on the ticket row itself. So
//  "Assigned Date & Time", "Claimed / Reserved Date & Time" and "On Going
//  Date & Time" all read from the same `claimed_at` value by design, not
//  by mistake.
// ═══════════════════════════════════════════════════════════════════════════
const EXPORT_STATUSES = ['ALL', 'OPEN', 'ON_GOING', 'COMPLETED', 'CANCELLED', 'RECOVERED'];
const EXPORT_STATUS_LABELS = {
    ALL: 'All Tickets', OPEN: 'Open', ON_GOING: 'On Going',
    COMPLETED: 'Completed', CANCELLED: 'Cancelled', RECOVERED: 'Recovered'
};
// Used to build the FieldOps_Tickets_<Status>_<range>.<ext> filename.
const EXPORT_STATUS_FILE_LABELS = {
    ALL: 'All', OPEN: 'Open', ON_GOING: 'OnGoing',
    COMPLETED: 'Completed', CANCELLED: 'Cancelled', RECOVERED: 'Recovered'
};
const EXPORT_HEADERS = [
    'Ticket ID', 'Site ID', 'Site Name', 'Locality', 'Ticket Status', 'Ticket Category', 'Ticket Priority',
    'Assigned Technician', 'Assigned Date & Time',
    'Created / Opened Date & Time', 'Claimed / Reserved Date & Time', 'On Going Date & Time',
    'Completed Date & Time', 'Cancelled Date & Time', 'Recovered Date & Time', 'Last Updated Date & Time',
    'Resolution Time (hrs)', 'Assignment Time (hrs)', 'Completion Duration (hrs)'
];
// 1-indexed column numbers of the three duration columns, for XLSX number formatting.
const EXPORT_HOUR_COLUMNS = [17, 18, 19];

/** Formats an ISO timestamp as "YYYY-MM-DD HH:mm:ss" in Philippine Time
 *  (Asia/Manila, UTC+8) — one consistent format for every date/time column
 *  in the export, matching the 'en-PH' locale already used elsewhere
 *  (see fmtDate() in index.html) while staying sortable as plain text. */
function fmtExportDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(d);
    const p = {};
    parts.forEach(x => { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00'; // some ICU builds emit "24" for midnight
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Hours between two ISO timestamps, rounded to 2 decimals — or '' if either
 *  side hasn't happened yet (ticket never reached that status). */
function durationHours(startIso, endIso) {
    if (!startIso || !endIso) return '';
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (!isFinite(ms) || ms < 0) return '';
    return Math.round((ms / 3600000) * 100) / 100;
}

/** Guards against CSV/Excel formula injection (a cell starting with
 *  = + - @ can execute as a formula in some spreadsheet apps) for any
 *  free-text field that ultimately came from admin/technician input
 *  (site names, notes, technician names, etc). Numbers/dates never pass
 *  through this — only strings. */
function guardFormulaInjection(v) {
    return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? `'${v}` : v;
}

function buildDateRangeLabel(startDate, endDate) {
    if (startDate && endDate) return `${startDate} to ${endDate}`;
    if (startDate) return `From ${startDate}`;
    if (endDate) return `Through ${endDate}`;
    return 'All time';
}

function buildExportFilename({ status, startDate, endDate, format }) {
    const statusPart = EXPORT_STATUS_FILE_LABELS[status] || 'All';
    const datePart = (startDate && endDate) ? `${startDate}_to_${endDate}`
        : startDate ? `From_${startDate}`
        : endDate   ? `Through_${endDate}`
        : 'AllTime';
    const ext = format === 'xlsx' ? 'xlsx' : 'csv';
    return `FieldOps_Tickets_${statusPart}_${datePart}.${ext}`;
}

/** Resolves ticket.assigned_to (a users.id UUID in Supabase mode, or the
 *  tech_code itself in local-JSON mode — see getUserByTechCode() above)
 *  to a human display_name. Keyed by both id and tech_code so either mode
 *  resolves correctly with a single map. */
async function buildTechnicianMap() {
    const map = {};
    if (supabase) {
        const { data, error } = await supabase.from('users').select('id, tech_code, display_name');
        if (error) throw error;
        (data || []).forEach(u => {
            if (u.id) map[u.id] = u.display_name;
            if (u.tech_code) map[u.tech_code] = u.display_name;
        });
    } else {
        const { users } = readDB();
        users.forEach(u => {
            if (u.tech_code) map[u.tech_code] = u.display_name;
            if (u.id) map[u.id] = u.display_name;
        });
    }
    return map;
}

/** Fetches only the tickets matching the export filters. Status/date
 *  filters are pushed into the Supabase query itself (not fetched-then-
 *  filtered) so exporting a narrow slice of a large table stays cheap. */
async function fetchTicketsForExport({ status, startIso, endIso }) {
    if (supabase) {
        let q = supabase.from('tickets').select('*').order('created_at', { ascending: true });
        if (startIso) q = q.gte('created_at', startIso);
        if (endIso)   q = q.lte('created_at', endIso);
        if (status === 'RECOVERED') {
            q = q.or('status.eq.RECOVERED,recovered_while_claimed.eq.true');
        } else if (status !== 'ALL') {
            q = q.eq('status', status);
        }
        const { data, error } = await q;
        if (error) throw error;
        return data || [];
    }
    const { tickets } = readDB();
    return tickets
        .filter(t => {
            if (startIso && (!t.created_at || t.created_at < startIso)) return false;
            if (endIso   && (!t.created_at || t.created_at > endIso))   return false;
            if (status === 'RECOVERED') return t.status === 'RECOVERED' || t.recovered_while_claimed;
            if (status !== 'ALL') return t.status === status;
            return true;
        })
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

function computeExportTotals(tickets) {
    return {
        total:     tickets.length,
        open:      tickets.filter(t => t.status === 'OPEN').length,
        ongoing:   tickets.filter(t => t.status === 'ON_GOING').length,
        completed: tickets.filter(t => t.status === 'COMPLETED').length,
        cancelled: tickets.filter(t => t.status === 'CANCELLED').length,
        // Mirrors the Overview "Recovered" stat card: RECOVERED status OR any
        // still-ON_GOING ticket flagged recovered_while_claimed. May overlap
        // with `ongoing` above by design — same as the dashboard.
        recovered: tickets.filter(t => t.status === 'RECOVERED' || t.recovered_while_claimed).length
    };
}

function buildExportRow(t, techMap) {
    const assignedTechnician = t.assigned_to ? guardFormulaInjection(techMap[t.assigned_to] || t.assigned_to) : '';
    return [
        guardFormulaInjection(t.ticket_id || ''),
        guardFormulaInjection(t.site_id || ''),
        guardFormulaInjection(t.site_name || ''),
        guardFormulaInjection(t.locality || ''),
        t.status || '',
        '', // Ticket Category — not currently tracked in the data model; left blank
        t.priority || '',
        assignedTechnician,
        fmtExportDateTime(t.claimed_at),      // Assigned Date & Time
        fmtExportDateTime(t.created_at),      // Created / Opened
        fmtExportDateTime(t.claimed_at),      // Claimed / Reserved
        fmtExportDateTime(t.claimed_at),      // On Going (same moment as claim — see header note)
        fmtExportDateTime(t.completed_at),
        fmtExportDateTime(t.cancelled_at),
        fmtExportDateTime(t.recovered_at),
        fmtExportDateTime(t.updated_at),
        durationHours(t.created_at, t.completed_at), // Resolution Time
        durationHours(t.created_at, t.claimed_at),   // Assignment Time
        durationHours(t.claimed_at, t.completed_at)  // Completion Duration
    ];
}

// ── CSV builder ──────────────────────────────────────────────────────────
function csvEscape(val) {
    if (val === null || val === undefined) return '';
    let s = String(val);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
}
function csvLine(cells) { return cells.map(csvEscape).join(','); }

function buildTicketsCsv({ summary, totals, rows }) {
    const lines = [];
    lines.push(csvLine(['FieldOps — Ticket Export']));
    lines.push('');
    lines.push(csvLine(['Export Generated On', summary.generatedOn]));
    lines.push(csvLine(['Exported By', summary.exportedBy]));
    lines.push(csvLine(['Date Range', summary.dateRangeLabel]));
    lines.push(csvLine(['Status Filter', summary.statusLabel]));
    lines.push('');
    lines.push(csvLine(['Ticket Totals']));
    lines.push(csvLine(['Total Exported Tickets', totals.total]));
    lines.push(csvLine(['Total Open', totals.open]));
    lines.push(csvLine(['Total On Going', totals.ongoing]));
    lines.push(csvLine(['Total Completed', totals.completed]));
    lines.push(csvLine(['Total Cancelled', totals.cancelled]));
    lines.push(csvLine(['Total Recovered', totals.recovered]));
    lines.push('');
    lines.push(csvLine(EXPORT_HEADERS));
    rows.forEach(r => lines.push(csvLine(r)));
    return lines.join('\r\n');
}

// ── XLSX builder (exceljs) ───────────────────────────────────────────────
async function buildTicketsXlsx({ summary, totals, rows }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FieldOps Admin Portal';
    wb.created = new Date();
    const ws = wb.addWorksheet('Tickets');
    const COLS = EXPORT_HEADERS.length;

    function addLabelValue(label, value) {
        const r = ws.addRow([label, guardFormulaInjection(value)]);
        r.getCell(1).font = { bold: true, color: { argb: 'FF64748B' } };
    }

    const titleRow = ws.addRow(['FieldOps — Ticket Export']);
    titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0D9488' } };
    ws.mergeCells(titleRow.number, 1, titleRow.number, COLS);
    ws.addRow([]);
    addLabelValue('Export Generated On', summary.generatedOn);
    addLabelValue('Exported By', summary.exportedBy);
    addLabelValue('Date Range', summary.dateRangeLabel);
    addLabelValue('Status Filter', summary.statusLabel);
    ws.addRow([]);
    const totalsHdrRow = ws.addRow(['Ticket Totals']);
    totalsHdrRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF0F172A' } };
    addLabelValue('Total Exported Tickets', totals.total);
    addLabelValue('Total Open', totals.open);
    addLabelValue('Total On Going', totals.ongoing);
    addLabelValue('Total Completed', totals.completed);
    addLabelValue('Total Cancelled', totals.cancelled);
    addLabelValue('Total Recovered', totals.recovered);
    ws.addRow([]);

    const headerRow = ws.addRow(EXPORT_HEADERS);
    headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D9488' } };
        cell.alignment = { vertical: 'middle' };
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow.number }];
    ws.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: headerRow.number, column: COLS } };

    rows.forEach(r => {
        const dataRow = ws.addRow(r);
        EXPORT_HOUR_COLUMNS.forEach(ci => {
            const cell = dataRow.getCell(ci);
            if (typeof cell.value === 'number') cell.numFmt = '0.00';
        });
    });

    ws.columns.forEach((col, i) => {
        const headerLen = (EXPORT_HEADERS[i] || '').length;
        col.width = Math.max(14, Math.min(32, headerLen + 4));
    });
    ws.getColumn(3).width = 28; // Site Name
    ws.getColumn(4).width = 20; // Locality

    return wb.xlsx.writeBuffer();
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/tickets/export
//  query: start_date, end_date  (YYYY-MM-DD, both optional — omit for open-ended)
//         status                (ALL|OPEN|ON_GOING|COMPLETED|CANCELLED|RECOVERED, default ALL)
//         format                (csv|xlsx, default csv)
//         exported_by           (display name of the admin triggering the export)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/tickets/export', async (req, res) => {
    try {
        const status = EXPORT_STATUSES.includes(String(req.query.status || '').toUpperCase())
            ? String(req.query.status).toUpperCase() : 'ALL';
        const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
        const startDate  = String(req.query.start_date  || '').trim() || null;
        const endDate    = String(req.query.end_date    || '').trim() || null;
        const exportedBy = String(req.query.exported_by || '').trim() || 'Admin';

        if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
            return res.status(400).json({ error: 'start_date must be in YYYY-MM-DD format' });
        if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))
            return res.status(400).json({ error: 'end_date must be in YYYY-MM-DD format' });

        const startIso = startDate ? `${startDate}T00:00:00.000Z` : null;
        const endIso   = endDate   ? `${endDate}T23:59:59.999Z`   : null;
        if (startIso && endIso && startIso > endIso)
            return res.status(400).json({ error: 'start_date must be on or before end_date' });

        const [tickets, techMap] = await Promise.all([
            fetchTicketsForExport({ status, startIso, endIso }),
            buildTechnicianMap()
        ]);

        const rows   = tickets.map(t => buildExportRow(t, techMap));
        const totals = computeExportTotals(tickets);
        const summary = {
            generatedOn:    fmtExportDateTime(new Date().toISOString()),
            exportedBy:     guardFormulaInjection(exportedBy),
            dateRangeLabel: buildDateRangeLabel(startDate, endDate),
            statusLabel:    EXPORT_STATUS_LABELS[status]
        };
        const filename = buildExportFilename({ status, startDate, endDate, format });

        if (format === 'xlsx') {
            const buffer = await buildTicketsXlsx({ summary, totals, rows });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(buffer);
        }
        const csv = buildTicketsCsv({ summary, totals, rows });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send('\uFEFF' + csv); // BOM so Excel opens UTF-8 CSV correctly
    } catch (err) {
        console.error('[GET /admin/tickets/export]', err.message);
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
async function sendTelegramProof(botToken, chatId, ticketId, techId, notes, files, siteId, siteName, proofIds = []) {
    if (!botToken || !chatId) {
        console.log(`[Telegram] Skipped for ticket ${ticketId} — technician has no Telegram Bot configured`);
        return;
    }
    if (!files || !files.length) {
        console.log('[Telegram] Skipped — no files attached');
        return;
    }

    const API     = `https://api.telegram.org/bot${botToken}`;
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
            form.append('chat_id',    chatId);
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
            form.append('chat_id', chatId);
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

        // ── Media Retention (ADDITIVE) ───────────────────────────────────────
        // Reaching this point means the send above completed without throwing.
        // Stamp telegram_confirmed_at on exactly the proof rows from this
        // submission — this is the only gate the nightly Storage purge checks
        // before deleting a file. A failure here only affects retention
        // bookkeeping; it can never undo the Telegram send or proof submission,
        // both of which have already succeeded by this point.
        if (supabase && proofIds.length) {
            const { error: confirmErr } = await supabase
                .from('ticket_proofs')
                .update({ telegram_confirmed_at: new Date().toISOString() })
                .in('id', proofIds);
            if (confirmErr) {
                console.error(`[Media Retention] Could not stamp telegram_confirmed_at for ticket ${ticketId}:`, confirmErr.message);
            }
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
//  Telegram: Guided Troubleshooting follow-up (ADDITIVE)
//  -----------------------------------------------------------------------
//  Sends the AI-assisted troubleshooting summary as its own message, then
//  (if any) the troubleshooting evidence as a second message — referencing
//  each file's existing Supabase Storage / local URL directly, so nothing
//  already uploaded during the checklist is re-uploaded here. Runs after,
//  and fully independently of, sendTelegramProof() above: any failure in
//  this function is caught internally and can never affect the core proof
//  submission, which has already completed by the time this is called.
// ═══════════════════════════════════════════════════════════════════════════
async function sendTelegramTroubleshootingFollowup(botToken, chatId, ticketId, summaryText, media, draftId) {
    if (!botToken || !chatId) return;
    if (!summaryText && (!media || !media.length)) return;
    const API = `https://api.telegram.org/bot${botToken}`;

    try {
        if (summaryText) {
            await axios.post(`${API}/sendMessage`, {
                chat_id:    chatId,
                parse_mode: 'HTML',
                text: `🛠 <b>Guided Troubleshooting Summary</b>\n` +
                      `Ticket: <code>${escapeHtml(ticketId)}</code>\n\n` +
                      escapeHtml(summaryText),
            });
            console.log(`[Telegram] ✔ Sent troubleshooting summary for ticket ${ticketId}`);
        }
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
        console.error(`[Telegram] ✘ Troubleshooting summary failed for ticket ${ticketId}:\n`, detail);
    }

    if (!media || !media.length) return;
    try {
        // Only http(s) URLs are safe to hand to Telegram's fetch-by-URL behaviour.
        const safeMedia = media.filter(m => m && /^https?:\/\//i.test(m.storage_url)).slice(0, 10);
        if (!safeMedia.length) return;

        if (safeMedia.length === 1) {
            const isVideo = safeMedia[0].media_type === 'video';
            await axios.post(`${API}/${isVideo ? 'sendVideo' : 'sendPhoto'}`, {
                chat_id: chatId,
                [isVideo ? 'video' : 'photo']: safeMedia[0].storage_url,
                caption: `Troubleshooting evidence — Ticket ${escapeHtml(ticketId)}`,
            });
        } else {
            const group = safeMedia.map((m, i) => ({
                type:  m.media_type === 'video' ? 'video' : 'photo',
                media: m.storage_url, // existing Storage URL — Telegram fetches it directly
                ...(i === 0 ? { caption: `Troubleshooting evidence — Ticket ${escapeHtml(ticketId)}` } : {}),
            }));
            await axios.post(`${API}/sendMediaGroup`, { chat_id: chatId, media: group });
        }
        console.log(`[Telegram] ✔ Sent ${safeMedia.length} troubleshooting evidence file(s) for ticket ${ticketId}`);

        // ── Media Retention (ADDITIVE) ───────────────────────────────────────
        // Stamp telegram_confirmed_at only on the rows that were actually sent
        // above (safeMedia may be a subset of `media` — non-http(s) URLs or
        // anything past the 10-item Telegram limit is excluded). Matched by
        // draft_id + storage_url since this array arrives from the client as
        // plain {storage_url, media_type} pairs, without row ids attached.
        if (supabase && draftId && safeMedia.length) {
            const urls = safeMedia.map(m => m.storage_url);
            const { error: confirmErr } = await supabase
                .from('troubleshooting_media')
                .update({ telegram_confirmed_at: new Date().toISOString() })
                .eq('draft_id', draftId)
                .in('storage_url', urls);
            if (confirmErr) {
                console.error(`[Media Retention] Could not stamp telegram_confirmed_at for ticket ${ticketId}:`, confirmErr.message);
            }
        }
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
        console.error(`[Telegram] ✘ Troubleshooting evidence failed for ticket ${ticketId}:\n`, detail);
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
            notifyRouteSitesChanged(technician_id, site_ids.length, 0);
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
        notifyRouteSitesChanged(technician_id, site_ids.length, 0);
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
            const { data: existing } = await supabase.from('route_reservations')
                .select('site_ids').eq('technician_id', technician_id).eq('status', 'ACTIVE').gte('last_activity', cutoff).maybeSingle();
            const oldIds = existing?.site_ids || [];
            const { error } = await supabase.from('route_reservations')
                .update({ site_ids, last_activity: nowIso() })
                .eq('technician_id', technician_id)
                .eq('status', 'ACTIVE')
                .gte('last_activity', cutoff);
            if (error) throw error;
            notifyRouteSitesChanged(technician_id, site_ids.filter(s => !oldIds.includes(s)).length, oldIds.filter(s => !site_ids.includes(s)).length);
            return res.json({ message: 'Route updated' });
        }
        const db = readDB();
        const route = getActiveRouteLocal(db, technician_id);
        if (!route) return res.status(404).json({ error: 'No active route found' });
        const oldIds = route.site_ids || [];
        route.site_ids = site_ids;
        route.last_activity = nowIso();
        writeDB(db);
        notifyRouteSitesChanged(technician_id, site_ids.filter(s => !oldIds.includes(s)).length, oldIds.filter(s => !site_ids.includes(s)).length);
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
            notifyAvailabilityChanged(technician_id, is_on_duty);
            return res.json({ message: `Status set to ${is_on_duty ? 'On Duty' : 'Off Duty'}` });
        }
        const db = readDB();
        const rec = getTechStatusLocal(db, technician_id);
        rec.is_on_duty = is_on_duty;
        rec.last_activity = nowIso();
        rec.technician_name = technician_name || technician_id;
        if (current_gps) rec.current_gps = current_gps;
        writeDB(db);
        notifyAvailabilityChanged(technician_id, is_on_duty);
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


// ═══════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS & ALERTS  (Profile → Notifications, header bell icon)
//  -----------------------------------------------------------------------
//  ADDITIVE feature, dual-mode like everything else in this file: Supabase
//  when configured, else database.json's `notifications` array. Schema,
//  indexes, RLS and the Realtime publication are in
//  supabase_migration_notifications.sql.
//
//  Real-time delivery: the client holds one Server-Sent-Events connection
//  per technician (GET /api/notifications/stream). When Supabase is
//  configured, a single postgres_changes subscription below relays every
//  insert/update/delete on `notifications` to the right SSE connections —
//  that's the "Supabase Realtime" requirement. In local-JSON mode there's
//  no database change feed to subscribe to, so each mutating function below
//  calls broadcastNotification() itself right after writing to disk. Either
//  way the client-side handling is identical (one EventSource, one message
//  shape), so the frontend doesn't need to know which mode is active.
//
//  Supabase mode requires this table (see the migration file for full DDL):
//    notifications(id, user_id, category, title, message, priority,
//                   action_type, action_data, dedup_key, is_read, created_at)
//  No other table is touched — sample-notification seeding (see
//  seedNotificationsIfNeeded below) just checks whether this table already
//  has any rows for the technician, so nothing else needs a schema change.
// ═══════════════════════════════════════════════════════════════════════════

const NOTIF_CATEGORIES = ['jobs', 'route', 'system', 'account', 'support'];
const NOTIF_PRIORITIES = ['info', 'reminder', 'critical'];

// ── Sample data (requirement: seed once per technician for testing) ────────
// Wording matches the six sample lines verbatim in `message`; `title` uses
// the matching type name from the Notifications spec. Three are left unread
// so a first-time visit shows the same "3 unread" the Profile card always
// displayed before this feature was wired up.
function defaultSampleNotifications(userId) {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    return [
        {
            id: generateId(), user_id: userId, category: 'jobs',
            title: 'New nearby job available',
            message: 'New nearby Field Support site available.',
            priority: 'info', action_type: 'job_open', action_data: null,
            dedup_key: null, is_read: false, created_at: iso(8 * 60 * 1000),
        },
        {
            id: generateId(), user_id: userId, category: 'jobs',
            title: 'Job claimed successfully',
            message: 'Your job reservation was successful.',
            priority: 'info', action_type: 'job_ongoing', action_data: null,
            dedup_key: null, is_read: false, created_at: iso(70 * 60 * 1000),
        },
        {
            id: generateId(), user_id: userId, category: 'jobs',
            title: 'Job completed',
            message: 'Site #DICT-104 completed successfully.',
            priority: 'info', action_type: 'job_done', action_data: null,
            dedup_key: null, is_read: true, created_at: iso(22 * 60 * 60 * 1000),
        },
        {
            id: generateId(), user_id: userId, category: 'system',
            title: 'New app version available',
            message: 'Version 1.0.1 is available.',
            priority: 'info', action_type: 'app_update', action_data: null,
            dedup_key: null, is_read: true, created_at: iso(2 * 24 * 60 * 60 * 1000),
        },
        {
            id: generateId(), user_id: userId, category: 'support',
            title: 'Support ticket replied',
            message: 'Support has replied to your inquiry.',
            priority: 'info', action_type: 'contact_support', action_data: null,
            dedup_key: null, is_read: false, created_at: iso(3 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000),
        },
        {
            id: generateId(), user_id: userId, category: 'account',
            title: 'Availability status changed',
            message: 'Your availability is now ON.',
            priority: 'info', action_type: 'profile', action_data: null,
            dedup_key: null, is_read: true, created_at: iso(5 * 24 * 60 * 60 * 1000),
        },
    ];
}

// ── Seed-once check ──────────────────────────────────────────────────────
// Deliberately self-contained: "has this technician ever had any
// notifications at all?" rather than a flag on another table. The existing
// duty/toggle handler above does a manual select-then-update-or-insert
// against technician_statuses rather than a single upsert(onConflict:...) —
// a strong sign technician_id has no unique constraint there in the real
// schema, and that table's other columns may be NOT NULL without defaults.
// Piggy-backing a flag on it risks a runtime error this code can't predict.
// Checking this table instead needs nothing from any other table's schema.
// (Edge case: if a technician deletes every notification they've ever had,
// the next load reseeds the 6 samples — harmless, and simpler than the
// alternative of a cross-table dependency this file can't verify is safe.)
async function hasSeededNotifications(technicianId) {
    if (supabase) {
        const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', technicianId);
        return !!count;
    }
    const db = readDB();
    return db.notifications.some(n => n.user_id === technicianId);
}
async function seedNotificationsIfNeeded(technicianId) {
    const already = await hasSeededNotifications(technicianId);
    if (already) return;
    const samples = defaultSampleNotifications(technicianId);
    if (supabase) {
        await supabase.from('notifications').insert(samples.map(({ id, ...rest }) => rest));
    } else {
        const db = readDB();
        db.notifications.push(...samples);
        writeDB(db);
    }
}

// ── SSE fan-out ─────────────────────────────────────────────────────────────
// technician_id (tech_code) → Set<res>. A technician can have more than one
// open connection (e.g. two tabs), so every connection for that id gets the
// event.
const notifSSEClients = new Map();
function notifSSEAdd(techId, res) {
    if (!notifSSEClients.has(techId)) notifSSEClients.set(techId, new Set());
    notifSSEClients.get(techId).add(res);
}
function notifSSERemove(techId, res) {
    const set = notifSSEClients.get(techId);
    if (!set) return;
    set.delete(res);
    if (!set.size) notifSSEClients.delete(techId);
}
function broadcastNotification(techId, payload) {
    const set = notifSSEClients.get(techId);
    if (!set || !set.size) return;
    const line = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of set) {
        try { res.write(line); } catch (e) { /* connection likely already gone; req.on('close') will clean it up */ }
    }
}

// When Supabase is configured, subscribe once to every change on the table
// and relay it to whichever technician it belongs to — this is what actually
// makes it "Supabase Realtime" rather than a plain in-process event bus. In
// local-JSON mode there's no equivalent to subscribe to, so each helper
// below (create/markRead/markUnread/delete) broadcasts manually instead.
if (supabase) {
    supabase
        .channel('notifications-realtime-relay')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, (payload) => {
            const uid = (payload.new && payload.new.user_id) || (payload.old && payload.old.user_id);
            if (!uid) return;
            const type = payload.eventType === 'INSERT' ? 'created' : payload.eventType === 'UPDATE' ? 'updated' : 'deleted';
            broadcastNotification(uid, { type, notification: payload.new || payload.old });
        })
        .subscribe();
}

// ── CRUD helpers (dual-mode) ────────────────────────────────────────────────

/** Paginated list + the technician's TRUE overall unread count (ignores the page filters, used for badges). */
async function getNotificationsPage({ userId, category, unreadOnly, limit, before }) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    if (supabase) {
        let q = supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit + 1);
        if (category && category !== 'all') q = q.eq('category', category);
        if (unreadOnly) q = q.eq('is_read', false);
        if (before) q = q.lt('created_at', before);
        const { data, error } = await q;
        if (error) throw error;
        const items = data || [];
        const hasMore = items.length > limit;
        const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false);
        return { items: items.slice(0, limit), hasMore, unreadCount: count || 0 };
    }

    const db = readDB();
    let rows = db.notifications.filter(n => n.user_id === userId);
    const unreadCount = rows.filter(n => !n.is_read).length;
    if (category && category !== 'all') rows = rows.filter(n => n.category === category);
    if (unreadOnly) rows = rows.filter(n => !n.is_read);
    if (before) rows = rows.filter(n => n.created_at < before);
    rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit), hasMore, unreadCount };
}

/** Inserts one notification. If dedup_key is set and a row with that (user_id, dedup_key) already
 *  exists, the insert is skipped — this is the "avoid duplicate notifications" requirement. */
async function createNotificationInternal({ user_id, category, title, message, priority, action_type, action_data, dedup_key }) {
    if (!NOTIF_CATEGORIES.includes(category)) throw new Error('Invalid category');
    if (!NOTIF_PRIORITIES.includes(priority)) priority = 'info';

    if (supabase) {
        if (dedup_key) {
            const { data: existing } = await supabase.from('notifications').select('id').eq('user_id', user_id).eq('dedup_key', dedup_key).maybeSingle();
            if (existing) return { notification: existing, created: false };
        }
        const row = { user_id, category, title, message, priority, action_type: action_type || null, action_data: action_data || null, dedup_key: dedup_key || null, is_read: false, created_at: nowIso() };
        const { data, error } = await supabase.from('notifications').insert(row).select().single();
        if (error) throw error;
        // No manual broadcast here — the postgres_changes subscription above already relays this insert.
        return { notification: data, created: true };
    }

    const db = readDB();
    if (dedup_key) {
        const existing = db.notifications.find(n => n.user_id === user_id && n.dedup_key === dedup_key);
        if (existing) return { notification: existing, created: false };
    }
    const row = { id: generateId(), user_id, category, title, message, priority, action_type: action_type || null, action_data: action_data || null, dedup_key: dedup_key || null, is_read: false, created_at: nowIso() };
    db.notifications.push(row);
    writeDB(db);
    broadcastNotification(user_id, { type: 'created', notification: row });
    return { notification: row, created: true };
}

async function setNotificationRead(id, userId, isRead) {
    if (supabase) {
        const { data, error } = await supabase.from('notifications').update({ is_read: isRead }).eq('id', id).eq('user_id', userId).select().maybeSingle();
        if (error) throw error;
        return data;
    }
    const db = readDB();
    const row = db.notifications.find(n => n.id === id && n.user_id === userId);
    if (!row) return null;
    row.is_read = isRead;
    writeDB(db);
    broadcastNotification(userId, { type: 'updated', notification: row });
    return row;
}

async function markAllReadInternal(userId) {
    if (supabase) {
        const { error } = await supabase.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
        if (error) throw error;
        return;
    }
    const db = readDB();
    let changed = false;
    db.notifications.forEach(n => { if (n.user_id === userId && !n.is_read) { n.is_read = true; changed = true; } });
    if (changed) writeDB(db);
    broadcastNotification(userId, { type: 'read-all' });
}

async function deleteNotificationInternal(id, userId) {
    if (supabase) {
        const { error } = await supabase.from('notifications').delete().eq('id', id).eq('user_id', userId);
        if (error) throw error;
        return;
    }
    const db = readDB();
    const before = db.notifications.length;
    db.notifications = db.notifications.filter(n => !(n.id === id && n.user_id === userId));
    if (db.notifications.length !== before) writeDB(db);
    broadcastNotification(userId, { type: 'deleted', notification: { id } });
}

// ── Small helpers used by hooks in OTHER existing endpoints below ──────────
// (job claim/cancel are wired inline where they happen; these few are used
// more than once or read a little more naturally pulled out.) All of these
// are fire-and-forget: callers .catch() them and never await, so a
// notification failure can never affect the feature it's attached to.
function notifyAvailabilityChanged(technicianId, isOnDuty) {
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000)); // 2-minute bucket guards against rapid double-taps
    createNotificationInternal({
        user_id: technicianId, category: 'account', title: 'Availability status changed',
        message: `Your availability is now ${isOnDuty ? 'ON' : 'OFF'}.`,
        priority: 'info', action_type: 'profile', action_data: null,
        dedup_key: `avail_${isOnDuty}_${bucket}`,
    }).catch(e => console.error('[notify availability]', e.message));
}
function notifyProfileUpdated(technicianId) {
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000));
    createNotificationInternal({
        user_id: technicianId, category: 'account', title: 'Profile updated',
        message: 'Your personal info was updated successfully.',
        priority: 'info', action_type: 'profile', action_data: null,
        dedup_key: `profile_updated_${bucket}`,
    }).catch(e => console.error('[notify profile updated]', e.message));
}
function notifyPinChanged(technicianId) {
    createNotificationInternal({
        user_id: technicianId, category: 'account', title: 'PIN changed successfully',
        message: 'Your PIN was changed successfully.',
        priority: 'info', action_type: 'profile', action_data: null,
        dedup_key: null,
    }).catch(e => console.error('[notify pin changed]', e.message));
}
function notifyRouteSitesChanged(technicianId, addedCount, removedCount) {
    if (addedCount > 0) {
        createNotificationInternal({
            user_id: technicianId, category: 'route', title: 'New site added to your route',
            message: addedCount === 1 ? 'A new site was added to your route.' : `${addedCount} new sites were added to your route.`,
            priority: 'info', action_type: 'route', action_data: null,
            dedup_key: null,
        }).catch(e => console.error('[notify route added]', e.message));
    }
    if (removedCount > 0) {
        createNotificationInternal({
            user_id: technicianId, category: 'route', title: 'Site removed from route',
            message: removedCount === 1 ? 'A site was removed from your route.' : `${removedCount} sites were removed from your route.`,
            priority: 'reminder', action_type: 'route', action_data: null,
            dedup_key: null,
        }).catch(e => console.error('[notify route removed]', e.message));
    }
}

// ── Routes ───────────────────────────────────────────────────────────────

// GET /api/notifications?technician_id=&category=&unread=1&limit=&before=
app.get('/api/notifications', async (req, res) => {
    try {
        const { technician_id, category, unread, limit, before } = req.query;
        if (!technician_id) return res.status(400).json({ error: 'technician_id is required' });
        await seedNotificationsIfNeeded(technician_id);
        const { items, hasMore, unreadCount } = await getNotificationsPage({
            userId: technician_id, category, unreadOnly: unread === '1' || unread === 'true', limit, before,
        });
        res.json({ items, has_more: hasMore, unread_count: unreadCount });
    } catch (err) {
        console.error('[GET /api/notifications]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/notifications — create (used by a few server-side hooks below, and by
// the client for the couple of notification types only the browser can detect,
// e.g. "Route optimized" and "New app version available").
app.post('/api/notifications', async (req, res) => {
    try {
        const { technician_id, category, title, message, priority, action_type, action_data, dedup_key } = req.body;
        if (!technician_id || !category || !title || !message) return res.status(400).json({ error: 'technician_id, category, title and message are required' });
        const result = await createNotificationInternal({ user_id: technician_id, category, title, message, priority, action_type, action_data, dedup_key });
        res.json(result);
    } catch (err) {
        console.error('[POST /api/notifications]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/read-all', async (req, res) => {
    try {
        const { technician_id } = req.body;
        if (!technician_id) return res.status(400).json({ error: 'technician_id is required' });
        await markAllReadInternal(technician_id);
        res.json({ message: 'All notifications marked as read' });
    } catch (err) {
        console.error('[POST /api/notifications/read-all]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/:id/read', async (req, res) => {
    try {
        const { technician_id } = req.body;
        if (!technician_id) return res.status(400).json({ error: 'technician_id is required' });
        const row = await setNotificationRead(req.params.id, technician_id, true);
        if (!row) return res.status(404).json({ error: 'Notification not found' });
        res.json({ notification: row });
    } catch (err) {
        console.error('[POST /api/notifications/:id/read]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/:id/unread', async (req, res) => {
    try {
        const { technician_id } = req.body;
        if (!technician_id) return res.status(400).json({ error: 'technician_id is required' });
        const row = await setNotificationRead(req.params.id, technician_id, false);
        if (!row) return res.status(404).json({ error: 'Notification not found' });
        res.json({ notification: row });
    } catch (err) {
        console.error('[POST /api/notifications/:id/unread]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/notifications/:id', async (req, res) => {
    try {
        const { technician_id } = req.query;
        if (!technician_id) return res.status(400).json({ error: 'technician_id is required' });
        await deleteNotificationInternal(req.params.id, technician_id);
        res.json({ message: 'Notification deleted' });
    } catch (err) {
        console.error('[DELETE /api/notifications/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/notifications/stream?technician_id=  — Server-Sent Events.
// Kept open for as long as the app is in the foreground; the client
// reconnects on its own (native EventSource behaviour) if it drops.
app.get('/api/notifications/stream', (req, res) => {
    const { technician_id } = req.query;
    if (!technician_id) return res.status(400).json({ error: 'technician_id is required' });
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 4000\n\n');
    notifSSEAdd(technician_id, res);
    const heartbeat = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(heartbeat); notifSSERemove(technician_id, res); });
});


app.listen(PORT, () => {
    console.log(`\n🚀  FieldOps running → http://localhost:${PORT}`);
    console.log(`    Mode : ${supabase ? 'Supabase (cloud database)' : 'Local JSON  (database.json)'}`);
    console.log(`    Telegram (cancel alerts, admin bot) : ${BOT_TOKEN ? 'enabled' : 'disabled (no BOT_TOKEN)'}`);
    console.log(`    Telegram (task proofs) : per-technician, configured in App Preferences`);
    if (supabase) {
        console.log(`    Guided Troubleshooting : storage bucket 'troubleshooting' must exist (public) — see supabase_migration_troubleshooting.sql`);
        console.log(`    Media Retention : 15-day Storage purge runs nightly via Supabase Cron — see supabase_migration_media_retention.sql`);
        console.log(`    Notifications & Alerts : Realtime via Supabase postgres_changes → relayed to clients over SSE — see supabase_migration_notifications.sql\n`);
    } else {
        console.log(`    Notifications & Alerts : local mode — real-time delivered over SSE only (no cross-device push)\n`);
    }
});
