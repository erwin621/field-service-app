'use strict';
require('dotenv').config();

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const axios     = require('axios');
const FormData  = require('form-data');

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

function readDB() {
    if (!fs.existsSync(DB_PATH))
        fs.writeFileSync(DB_PATH, JSON.stringify({ tickets: [] }, null, 2));
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}
function genTicketId() {
    return `TKT-${Date.now().toString().slice(-4)}-${Math.floor(1000 + Math.random() * 9000)}`;
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
                parse_mode: 'Markdown',
                text: `🚫 *Job Cancelled*\nTicket: \`${ticket_id}\`\nBy: ${cancelled_by || 'unknown'}\nReason: ${reason}`
            }).catch(e => console.warn('Telegram error:', e.message));
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

// ─── Telegram: send proof media group ───────────────────────────────────────
async function sendTelegramProof(ticketId, techId, notes, files) {
    if (!BOT_TOKEN || !CHAT_ID || !files?.length) return;
    const caption =
        `✅ *Job Completed*\n` +
        `Ticket: \`${ticketId}\`\n` +
        `Tech: ${techId}` +
        (notes ? `\nNotes: ${notes}` : '');

    const media = files.map((f, i) => ({
        type:  f.mimetype.startsWith('video') ? 'video' : 'photo',
        media: `attach://file${i}`,
        ...(i === 0 ? { caption, parse_mode: 'Markdown' } : {})
    }));

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('media', JSON.stringify(media));
    files.forEach((f, i) =>
        form.append(`file${i}`, fs.createReadStream(f.path), f.filename)
    );

    await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`,
        form,
        { headers: form.getHeaders() }
    );
}

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀  FieldOps running → http://localhost:${PORT}`);
    console.log(`    Mode : ${supabase ? 'Supabase (cloud database)' : 'Local JSON  (database.json)'}`);
    console.log(`    Telegram : ${BOT_TOKEN ? 'enabled' : 'disabled (no BOT_TOKEN)'}\n`);
});
