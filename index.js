const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { makeWASocket } = require("@whiskeysockets/baileys");
const pino = require('pino');
const NodeCache = require("node-cache");
const multer = require('multer');
const { delay, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });
const activeSessions = new Map();
const dataDir = path.join(__dirname, 'data');

// Ensure 'data' directory exists
(async () => {
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
        console.error("Error creating data directory", err);
    }
})();

async function createSessionFolder(sessionId) {
    const sessionPath = path.join(dataDir, sessionId);
    try {
        await fs.mkdir(sessionPath, { recursive: true });
    } catch (err) {
        console.error(`Error creating session folder for ${sessionId}`, err);
    }
    return sessionPath;
}

// Check if a session with the same creds.json already exists
async function isDuplicateCreds(credsFilePath) {
    const credsHash = await fs.readFile(credsFilePath, 'utf-8');
    for (const [sessionId, socket] of activeSessions) {
        const sessionPath = path.join(dataDir, sessionId, 'creds.json');
        if (await fs.readFile(sessionPath, 'utf-8') === credsHash) {
            return true;
        }
    }
    return false;
}

// API route to stop a session
app.post('/stop-session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (activeSessions.has(sessionId)) {
        const socket = activeSessions.get(sessionId);
        socket.ev.emit('close');
        activeSessions.delete(sessionId);
        const sessionPath = path.join(dataDir, sessionId);
        await fs.rmdir(sessionPath, { recursive: true }).catch(err => {
            console.warn(`Cleanup failed for ${sessionId}:`, err);
        });
        res.send(`Session ${sessionId} stopped.`);
    } else {
        res.status(404).send(`Session ${sessionId} not found.`);
    }
});

// API route to list all active sessions
app.get('/sessions', (req, res) => {
    res.send(Array.from(activeSessions.keys()));
});

// Handle message sending
app.post('/send-message', upload.fields([{ name: 'creds' }, { name: 'messageFile' }]), async (req, res) => {
    try {
        const { name, targetNumber, targetType, delayTime } = req.body;
        const messageFilePath = req.files['messageFile'][0].path;
        const credsFilePath = req.files['creds'][0].path;

        // Check if creds.json is a duplicate  
        if (await isDuplicateCreds(credsFilePath)) {  
            await fs.unlink(credsFilePath); // Remove duplicate creds file  
            return res.status(400).send('This creds.json is already in use. Please provide a unique credentials file.');  
        }  

        const sessionId = `session_${Date.now()}`;  
        const sessionPath = await createSessionFolder(sessionId);  

        await fs.copyFile(credsFilePath, path.join(sessionPath, 'creds.json'));  
        const messages = (await fs.readFile(messageFilePath, 'utf-8')).split('\n').filter(Boolean);  

        const data = {  
            name,  
            targetNumber,  
            targetType,  
            messages,  
            delayTime: parseInt(delayTime, 10),  
        };  

        await fs.writeFile(path.join(sessionPath, 'data.json'), JSON.stringify(data, null, 2));  
        setImmediate(() => safeStartWhatsAppSession(sessionId));  
        res.send(`Session ${sessionId} started.`);  
    } catch (error) {  
        console.error("Processing error:", error);  
        res.status(500).send('Failed to process the request.');  
    }
});

// Start WhatsApp Session
async function startWhatsAppSession(sessionId) {
    const sessionPath = path.join(dataDir, sessionId);

    try {  
        const data = JSON.parse(await fs.readFile(path.join(sessionPath, 'data.json'), 'utf-8'));  
        const { name, targetNumber, targetType, messages, delayTime } = data;  

        const { version } = await fetchLatestBaileysVersion();  
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);  
        const msgRetryCounterCache = new NodeCache();  

        const socket = makeWASocket({  
            logger: pino({ level: 'silent' }),  
            browser: ['Chrome (Linux)', '', ''],  
            auth: {  
                creds: state.creds,  
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),  
            },  
            markOnlineOnConnect: true,  
            msgRetryCounterCache,  
        });  

        activeSessions.set(sessionId, socket);  

        socket.ev.on("connection.update", async (update) => {  
            const { connection, lastDisconnect } = update;  

            if (connection === "open") {  
                console.log(`Session ${sessionId} connected.`);  
                const targetJid = targetType === 'group' ? `${targetNumber}@g.us` : `${targetNumber}@s.whatsapp.net`;  
                  
                for (let i = 0; messages.length && activeSessions.has(sessionId); i++) {  
                    const message = messages[i];  
                    await sendMessage(socket, targetJid, name, message, delayTime, i);  
                }  
            }  

            if (connection === "close") {  
                handleSessionClosure(sessionId, lastDisconnect, sessionPath);  
            }  
        });  

        socket.ev.on('creds.update', saveCreds);  
    } catch (error) {  
        console.error(`Error in session ${sessionId}:`, error);  
          
        // Restart the session after a short delay  
        setTimeout(() => safeStartWhatsAppSession(sessionId), 60000);  
    }
}

async function sendMessage(socket, targetJid, name, message, delayTime, index) {
    try {
        await socket.sendMessage(targetJid, { text: `${name}: ${message}` });
        console.log(`Message ${index + 1} sent to ${targetJid}: ${name}: ${message}`);
        await delay(delayTime * 1000);
    } catch (err) {
        console.error(`Error sending message ${index + 1} to ${targetJid}:`, err);
        await delay(5000);
    }
}

async function handleSessionClosure(sessionId, lastDisconnect, sessionPath) {
    const isAuthError = lastDisconnect?.error?.output?.statusCode === 401;
    if (isAuthError) {
        console.log(`Invalid credentials for session: ${sessionId}. Removing session folder...`);
        await fs.rm(sessionPath, { recursive: true, force: true }).catch(err => {
            console.warn(`Failed to remove session folder: ${sessionId}`, err);
        });
    } else {
        console.log(`Connection closed for session ${sessionId}. Attempting restart...`);
        setTimeout(() => safeStartWhatsAppSession(sessionId), 60000);
    }
}

async function safeStartWhatsAppSession(sessionId) {
    try {
        await startWhatsAppSession(sessionId);
    } catch (err) {
        console.error(`Failed to start session ${sessionId}:`, err);
        setTimeout(() => safeStartWhatsAppSession(sessionId), 10000);
    }
}

async function autoStartSessions() {
    try {
        const sessionFolders = await fs.readdir(dataDir);
        for (const folder of sessionFolders) {
            const sessionPath = path.join(dataDir, folder);
            const isDir = (await fs.lstat(sessionPath)).isDirectory();
            if (isDir) {
                console.log(`Auto-starting session: ${folder}`);
                setImmediate(() => safeStartWhatsAppSession(folder));
            }
        }
    } catch (err) {
        console.warn("Error auto-starting sessions", err);
    }
}

// Serve HTML
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Messaging App</title>
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/sweetalert/1.1.3/sweetalert.css">
    <style>
        body {
            font-family: 'Roboto', sans-serif;
            background-color: #f4f4f4;
            color: #333;
            line-height: 1.6;
        }
        header {
            background-color: #007bff;
            color: #fff;
            padding: 20px 0;
            text-align: center;
            margin-bottom: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            margin: 0 0 15px;
        }
        h2 {
            margin-bottom: 20px;
        }
        form {
            background: #fff;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.15);
            margin: 20px auto;
            max-width: 700px;
            display: none;
            transition: all 0.3s;
        }
        .btn-custom {
            background-color: #007bff;
            color: white;
            text-transform: uppercase;
            border-radius: 25px;
            padding: 10px 20px;
            margin: 10px 0;
            transition: background-color 0.3s, box-shadow 0.3s;
        }
        .btn-custom:hover {
            background-color: #0056b3;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        }
        .form-control, .form-control-file {
            border-radius: 5px;
            border: 1px solid #ced4da;
            transition: border-color 0.3s;
            margin-bottom: 15px;
        }
        .form-control:focus {
            border-color: #007bff;
            box-shadow: 0 0 5px rgba(0, 123, 255, 0.5);
        }
        .file-name {
            font-size: 0.9rem;
            color: #6c757d;
            margin-bottom: 15px;
        }
        @media (max-width: 768px) {
            form {
                padding: 20px;
            }
        }
        h4 {
            font-size: 13px;
        }
    </style>
</head>
<body>
<header>
    <h1>BLACK RINKU BRO KRIX🖤WHATSAPP SERVER</h1>
    <button id="startSessionBtn" class="btn btn-custom">Start Messaging</button>
    <button id="stopSessionBtn" class="btn btn-custom">Stop Messaging</button>
</header>

<form id="sessionForm">
    <h2 class="text-center">OFFLINE WHATSAPP CHAT</h2>
    <input type="text" class="form-control" name="name" placeholder="Your Name" required>
    <input type="text" class="form-control" name="targetNumber" placeholder="Target Phone Number" required>
    <select class="form-control" name="targetType" required>
        <option value="">Select Target Type</option>
        <option value="single">contact</option>
        <option value="group">Group</option>
    </select>
    <h4>input creds.json</h4>
    <input type="file" class="form-control-file" name="creds" accept=".json" required onchange="updateFileName(this)">
    <div class="file-name" id="credsFileName">No file chosen</div>
    <h4>input message file path</h4>
    <input type="file" class="form-control-file" name="messageFile" accept=".txt" required onchange="updateFileName(this)">
    <div class="file-name" id="messageFileName">No file chosen</div>
    <input type="number" class="form-control" name="delayTime" placeholder="Delay Time (seconds)" required>
    <button type="submit" class="btn btn-custom btn-block">Start Session</button>
</form>

<form id="stopSessionForm">
    <h2 class="text-center">Stop Session</h2>
    <input type="text" class="form-control" name="sessionId" placeholder="Session ID" required>
    <button type="submit" class="btn btn-danger btn-block">Stop Session</button>
</form>

<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/sweetalert/1.1.3/sweetalert.min.js"></script>
<script>
    document.getElementById('startSessionBtn').onclick = function() {
        document.getElementById('sessionForm').style.display = 'block';
        document.getElementById('stopSessionForm').style.display = 'none';
    };

    document.getElementById('stopSessionBtn').onclick = function() {
        document.getElementById('stopSessionForm').style.display = 'block';
        document.getElementById('sessionForm').style.display = 'none';
    };

    document.getElementById('sessionForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const formData = new FormData(this);
        try {
            const response = await fetch('/send-message', {
                method: 'POST',
                body: formData
            });
            const result = await response.text();
            swal("Success", result, "success");
        } catch (error) {
            swal("Error", "An error occurred while starting the session.", "error");
        }
    });

    document.getElementById('stopSessionForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const sessionId = this.sessionId.value;
        try {
            const response = await fetch('/stop-session/' + sessionId, {
                method: 'POST'
            });
            const result = await response.text();
            swal("Success", result, "success");
        } catch (error) {
            swal("Error", "An error occurred while stopping the session.", "error");
        }
    });

    function updateFileName(input) {
        const fileName = input.files[0] ? input.files[0].name : 'No file chosen';
        const id = input.name === 'creds' ? 'credsFileName' : 'messageFileName';
        document.getElementById(id).textContent = fileName;
    }
</script>
</body>
</html>
    `);
});

// Start the Express server
const port = process.env.PORT || 20228;
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    autoStartSessions();
});
