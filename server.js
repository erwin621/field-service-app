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

function genTicketId() {
    return `TKT-${Date.now().toString().slice(-4)}-${Math.floor(1000 + Math.random() * 9000)}`;
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
            return res.json(data);
        }
        const { tickets } = readDB();
        res.json(tickets.filter(t => t.status === 'OPEN' && !t.assigned_to));
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
//  POST /api/tickets/claim
//  body: { ticket_id, technician_id }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/claim', async (req, res) => {
    const { ticket_id, technician_id } = req.body;
    if (!ticket_id || !technician_id)
        return res.status(400).json({ error: 'Missing ticket_id or technician_id' });
    try {
        if (supabase) {
            const user = await getUserByTechCode(technician_id);

            // Verify the ticket is still OPEN before claiming
            const { data: existing } = await supabase
                .from('tickets').select('status').eq('ticket_id', ticket_id).single();
            if (!existing || existing.status !== 'OPEN')
                return res.status(409).json({ error: 'Ticket is no longer available' });

            const { error } = await supabase.from('tickets').update({
                status:      'ON_GOING',
                assigned_to: user.id,
                claimed_at:  new Date().toISOString()
            }).eq('ticket_id', ticket_id);
            if (error) throw error;
            return res.json({ message: `Ticket ${ticket_id} claimed by ${user.display_name}` });
        }
        // Local fallback
        const db = readDB();
        const t = db.tickets.find(x => x.ticket_id === ticket_id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        if (t.status !== 'OPEN')
            return res.status(409).json({ error: 'Ticket is no longer available' });
        t.status      = 'ON_GOING';
        t.assigned_to = technician_id;
        t.claimed_at  = new Date().toISOString();
        writeDB(db);
        res.json({ message: `Ticket ${ticket_id} claimed by ${technician_id}` });
    } catch (err) {
        console.error('[POST /claim]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/submit  (multipart/form-data)
//  fields : ticket_id, technician_id, notes
//  files  : proof[] (max 5, max 50 MB each)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/submit', upload.array('proof', 5), async (req, res) => {
    const { ticket_id, technician_id, notes } = req.body;
    if (!ticket_id || !technician_id || !req.files?.length)
        return res.status(400).json({ error: 'Missing ticket_id, technician_id, or proof files' });
    try {
        let proofUrls = [];

        if (supabase) {
            const user = await getUserByTechCode(technician_id);

            for (const file of req.files) {
                const storagePath = `${ticket_id}/${Date.now()}-${file.originalname.replace(/\s/g, '_')}`;
                const fileBuffer  = fs.readFileSync(file.path);

                const { error: upErr } = await supabase.storage
                    .from('proofs')
                    .upload(storagePath, fileBuffer, { contentType: file.mimetype, upsert: true });

                if (upErr) { console.error('Storage upload error:', upErr.message); continue; }

                const { data: { publicUrl } } = supabase.storage
                    .from('proofs')
                    .getPublicUrl(storagePath);

                proofUrls.push(publicUrl);

                // Record proof metadata
                const { data: tktRow } = await supabase
                    .from('tickets').select('id').eq('ticket_id', ticket_id).single();
                if (tktRow) {
                    await supabase.from('ticket_proofs').insert({
                        ticket_id:   tktRow.id,
                        file_url:    publicUrl,
                        file_type:   file.mimetype.startsWith('video') ? 'video' : 'image',
                        file_name:   file.originalname,
                        uploaded_by: user.id
                    });
                }
            }

            const { error } = await supabase.from('tickets').update({
                status:       'COMPLETED',
                proof_url:    proofUrls,
                notes:        notes || '',
                completed_at: new Date().toISOString()
            }).eq('ticket_id', ticket_id);
            if (error) throw error;

        } else {
            // Local fallback — store files in /uploads
            proofUrls = req.files.map(f => `/uploads/${f.filename}`);
            const db = readDB();
            const t  = db.tickets.find(x => x.ticket_id === ticket_id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            t.status       = 'COMPLETED';
            t.proof_url    = proofUrls;
            t.notes        = notes || '';
            t.completed_at = new Date().toISOString();
            writeDB(db);
        }

        // Send proof to Telegram (non-blocking)
        sendTelegramProof(ticket_id, technician_id, notes, req.files).catch(() => {});

        res.json({ message: 'Job submitted and marked as Completed.' });
    } catch (err) {
        console.error('[POST /submit]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/cancel
//  body: { ticket_id, cancelled_by, reason }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/cancel', async (req, res) => {
    const { ticket_id, cancelled_by, reason } = req.body;
    if (!ticket_id || !reason)
        return res.status(400).json({ error: 'Missing ticket_id or reason' });
    try {
        if (supabase) {
            const { error } = await supabase.from('tickets').update({
                status:               'CANCELLED',
                cancellation_reason:  reason,
                cancelled_by:         cancelled_by || 'unknown',
                cancelled_at:         new Date().toISOString(),
                assigned_to:          null
            }).eq('ticket_id', ticket_id).in('status', ['OPEN', 'ON_GOING']);
            if (error) throw error;
        } else {
            const db = readDB();
            const t  = db.tickets.find(x => x.ticket_id === ticket_id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            if (!['OPEN', 'ON_GOING'].includes(t.status))
                return res.status(409).json({ error: 'Only OPEN or ON_GOING tickets can be cancelled' });
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
                      `🎫 Ticket: <code>${escapeHtml(ticket_id)}</code>\n` +
                      `👷 By: ${escapeHtml(cancelled_by || 'unknown')}\n` +
                      `📝 Reason: ${escapeHtml(reason)}`
            }).catch(e => console.warn('[Telegram] Cancel notification failed:', e.message));
        }

        res.json({ message: `Ticket ${ticket_id} cancelled.` });
    } catch (err) {
        console.error('[POST /cancel]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/tickets/reopen   (admin only)
//  body: { ticket_id }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/tickets/reopen', async (req, res) => {
    const { ticket_id } = req.body;
    if (!ticket_id) return res.status(400).json({ error: 'Missing ticket_id' });
    try {
        if (supabase) {
            const { error } = await supabase.from('tickets').update({
                status:              'OPEN',
                assigned_to:         null,
                cancellation_reason: null,
                cancelled_by:        null,
                cancelled_at:        null,
                claimed_at:          null
            }).eq('ticket_id', ticket_id);
            if (error) throw error;
        } else {
            const db = readDB();
            const t  = db.tickets.find(x => x.ticket_id === ticket_id);
            if (!t) return res.status(404).json({ error: 'Ticket not found' });
            t.status              = 'OPEN';
            t.assigned_to         = null;
            t.cancellation_reason = null;
            t.cancelled_by        = null;
            t.cancelled_at        = null;
            t.claimed_at          = null;
            writeDB(db);
        }
        res.json({ message: `Ticket ${ticket_id} re-opened as OPEN.` });
    } catch (err) {
        console.error('[POST /reopen]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/batch-upload
//  body: { sites: [ { site_id, site_name, locality, address,
//                     coordinates, priority } ] }
//  Rules:
//   - New site_id  → create OPEN ticket
//   - Duplicate site_id (already OPEN) → escalate priority to HIGH
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/batch-upload', async (req, res) => {
    const { sites } = req.body;
    if (!Array.isArray(sites) || !sites.length)
        return res.status(400).json({ error: 'sites array is required' });

    let created = 0, escalated = 0, skipped = 0;

    try {
        for (const site of sites) {
            if (!site.site_id || !site.site_name) { skipped++; continue; }
            const priority = (site.priority || 'LOW').toUpperCase();

            if (supabase) {
                const { data: existing } = await supabase
                    .from('tickets')
                    .select('id, priority')
                    .eq('site_id', site.site_id)
                    .eq('status', 'OPEN')
                    .maybeSingle();

                if (existing) {
                    if (existing.priority !== 'HIGH') {
                        await supabase.from('tickets')
                            .update({ priority: 'HIGH' }).eq('id', existing.id);
                        escalated++;
                    } else skipped++;
                } else {
                    const { error } = await supabase.from('tickets').insert({
                        ticket_id:   genTicketId(),
                        site_id:     site.site_id,
                        site_name:   site.site_name,
                        locality:    site.locality    || '',
                        address:     site.address     || '',
                        coordinates: site.coordinates || '',
                        status:      'OPEN',
                        priority
                    });
                    if (!error) created++;
                    else { console.error('Insert error:', error.message); skipped++; }
                }
            } else {
                // Local fallback
                const db       = readDB();
                const existing = db.tickets.find(
                    t => t.site_id === site.site_id && t.status === 'OPEN'
                );
                if (existing) {
                    if (existing.priority !== 'HIGH') {
                        existing.priority = 'HIGH'; escalated++;
                    } else skipped++;
                } else {
                    db.tickets.push({
                        ticket_id:           genTicketId(),
                        site_id:             site.site_id,
                        site_name:           site.site_name,
                        locality:            site.locality    || '',
                        address:             site.address     || '',
                        coordinates:         site.coordinates || '',
                        status:              'OPEN',
                        priority,
                        assigned_to:         null,
                        proof_url:           [],
                        notes:               '',
                        cancellation_reason: null,
                        cancelled_by:        null,
                        created_at:          new Date().toISOString()
                    });
                    created++;
                }
                writeDB(db);
            }
        }

        res.json({
            message: `Done — Created: ${created} · Escalated to HIGH: ${escalated} · Skipped: ${skipped}`
        });
    } catch (err) {
        console.error('[POST /batch-upload]', err.message);
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
async function sendTelegramProof(ticketId, techId, notes, files) {
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
    const caption =
        `✅ <b>Job Completed</b>\n` +
        `🎫 Ticket: <code>${escapeHtml(ticketId)}</code>\n` +
        `👷 Tech: ${escapeHtml(techId)}` +
        (notes ? `\n📝 Notes: ${escapeHtml(notes)}` : '');

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

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀  FieldOps running → http://localhost:${PORT}`);
    console.log(`    Mode : ${supabase ? 'Supabase (cloud database)' : 'Local JSON  (database.json)'}`);
    console.log(`    Telegram : ${BOT_TOKEN ? 'enabled' : 'disabled (no BOT_TOKEN)'}\n`);
});
