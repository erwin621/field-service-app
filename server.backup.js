const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'database.json');

// Siguraduhing may 'uploads' folder para sa mga isusumiteng proof ng technician
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Setup Multer para tanggapin ang maramihang files
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// =========================================================================
// TELEGRAM CONFIGURATION
// =========================================================================
const TELEGRAM_BOT_TOKEN = '8273955218:AAGeIovOmiQIAEZOp1A2eDyLMBw6pajNESU';
const TELEGRAM_CHAT_ID = '8129202637';

const readDatabase = () => {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify([]));
        return [];
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '[]');
};

const writeDatabase = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

// ================= ADMIN ENDPOINT =================
app.post('/api/admin/batch-upload', (req, res) => {
    const { sites } = req.body;
    if (!sites || !Array.isArray(sites)) return res.status(400).json({ error: 'Invalid data format.' });

    let tickets = readDatabase();
    let createdCount = 0;
    let escalatedCount = 0;

    sites.forEach(site => {
        const existingIndex = tickets.findIndex(t => t.site_id === site.site_id && t.status === 'OPEN');
        if (existingIndex !== -1) {
            tickets[existingIndex].priority = 'HIGH';
            escalatedCount++;
        } else {
            const ticketId = `TKT-${Date.now().toString().slice(-4)}-${Math.floor(1000 + Math.random() * 9000)}`;
            tickets.push({
                ticket_id: ticketId, site_id: site.site_id, site_name: site.site_name,
                locality: site.locality, address: site.address, coordinates: site.coordinates,
                status: 'OPEN', priority: site.priority.toUpperCase(), assigned_to: null, proof_url: []
            });
            createdCount++;
        }
    });
    writeDatabase(tickets);
    res.json({ message: `Batch process complete. Created: ${createdCount}, Escalated to HIGH: ${escalatedCount}` });
});

// ================= TECHNICIAN ENDPOINTS =================

// 1. Kuhanin ang lahat ng OPEN Tickets
app.get('/api/tickets/open', (req, res) => {
    const tickets = readDatabase();
    const openTickets = tickets.filter(t => t.status === 'OPEN' && t.assigned_to === null);
    openTickets.sort((a, b) => {
        const order = { 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3 };
        return (order[a.priority] || 4) - (order[b.priority] || 4);
    });
    res.json(openTickets);
});

// 2. Claim Job API
app.post('/api/tickets/claim', (req, res) => {
    const { ticket_id, technician_id } = req.body;
    let tickets = readDatabase();
    const index = tickets.findIndex(t => t.ticket_id === ticket_id && t.status === 'OPEN');

    if (index === -1) return res.status(400).json({ error: 'Ticket unavailable or already claimed.' });

    tickets[index].status = 'ON_GOING';
    tickets[index].assigned_to = technician_id;
    
    writeDatabase(tickets);
    res.json({ message: 'Job successfully claimed!' });
});

// 3. Kuhanin ang ON GOING tickets ng naka-login na tech
app.get('/api/tickets/ongoing', (req, res) => {
    const { technician_id } = req.query;
    const tickets = readDatabase();
    const ongoing = tickets.filter(t => t.status === 'ON_GOING' && t.assigned_to === technician_id);
    res.json(ongoing);
});

// 4. Submit Job (Multiple Uploads + Telegram sendMediaGroup)
app.post('/api/tickets/submit', upload.array('proof', 5), async (req, res) => {
    const { ticket_id, technician_id } = req.body;
    
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Please upload at least one image or video proof.' });
    }

    let tickets = readDatabase();
    const index = tickets.findIndex(t => t.ticket_id === ticket_id && t.status === 'ON_GOING');

    if (index === -1) return res.status(400).json({ error: 'Ticket not found or not in progress.' });

    const fileUrls = req.files.map(file => `/uploads/${file.filename}`);
    tickets[index].status = 'COMPLETED';
    tickets[index].proof_url = fileUrls;
    writeDatabase(tickets);

    const ticketData = tickets[index];
    
    const messageText = `✅ JOB COMPLETED (MULTIPLE ATTACHMENTS)\n\n` +
                        `• Control No: ${ticketData.ticket_id}\n` +
                        `• Site ID: ${ticketData.site_id}\n` +
                        `• Site Name: ${ticketData.site_name}\n` +
                        `• Locality: ${ticketData.locality}\n` +
                        `• Tech Assigned: ${technician_id}\n` +
                        `• Coordinates: ${ticketData.coordinates}\n` +
                        `• Google Maps: https://www.google.com/maps/search/?api=1&query=${ticketData.coordinates}`;

    // FORWARD AS ALBUM SA TELEGRAM
    try {
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);

        const mediaGroupConfig = [];

        req.files.forEach((file, idx) => {
            const fileBuffer = fs.readFileSync(file.path);
            const fileBlob = new Blob([fileBuffer], { type: file.mimetype });
            const attachKey = `file_${idx}`;
            
            formData.append(attachKey, fileBlob, file.filename);

            const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'photo';

            mediaGroupConfig.push({
                type: mediaType,
                media: `attach://${attachKey}`,
                caption: idx === 0 ? messageText : '' // Ang unang picture/video lang ang may caption
            });
        });

        formData.append('media', JSON.stringify(mediaGroupConfig));

        console.log(`Sending ${req.files.length} file(s) as an Album to Telegram...`);
        
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`, {
            method: 'POST',
            body: formData
        });

        const resData = await response.json();
        
        if (!resData.ok) {
            console.error('❌ TELEGRAM API ERROR LOG:', resData);
        } else {
            console.log('✅ Multiple files successfully sent as a Telegram Album!');
        }

    } catch (err) {
        console.error('❌ Server Error during Telegram transfer:', err.message);
    }

    res.json({ message: 'Job completed successfully! Files saved and sent to Telegram.' });
});

app.listen(3000, () => console.log('Server is running seamlessly on http://localhost:3000'));

